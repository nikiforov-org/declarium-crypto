/**
 * Реализация CryptoProvider поверх Рутокен Плагина.
 *
 * Отличия от КриптоПро, которые учтены в общем интерфейсе:
 *
 *  · сертификаты живут не в хранилищах ОС, а на устройствах: сначала
 *    enumerateDevices, потом enumerateCertificates по каждому устройству;
 *  · хранилища «Другие пользователи» нет вовсе — сертификаты получателей
 *    передаются в cmsEncrypt PEM-строками, отсюда тип Recipient;
 *  · ПИН вводит приложение через login(), своего окна плагин не показывает.
 *
 * Внимание: установленной библиотеки PKCS#11 (`librtpkcs11ecp`) недостаточно —
 * она нативная и странице недоступна. Нужен Рутокен Плагин с расширением
 * браузера, это отдельная установка.
 */

import { base64ToBytes, bytesToBase64 } from './base64.js'
import { commonName, innFrom } from './rdn.js'
import {
  CryptoError,
  type CertInfo,
  type CertStore,
  type CryptoProvider,
  type ProviderStatus,
  type Recipient,
  type VerifyResult,
} from './types.js'

/** Категория сертификата: пользовательский. */
const CERT_CATEGORY_USER = 1
/**
 * Код отказа «вход уже выполнен» (ALREADY_LOGGED_IN в таблице errorCodes,
 * plugin.api.rutoken.ru). Числом, как и категория сертификата: у объекта
 * плагина, каким его отдаёт загрузчик, таблицы кодов нет.
 */
const ALREADY_LOGGED_IN = 93
/** Сколько ждём ответа от плагина, прежде чем считать его мёртвым. */
const PLUGIN_TIMEOUT_MS = 15_000
/**
 * Формат подписываемых данных.
 *
 * Двоичные данные передаются плагину строкой base64, поэтому формат обязан
 * быть `DATA_FORMAT_BASE64`. При `DATA_FORMAT_PLAIN` плагин подписывает текст
 * base64-представления, а не сами данные, и такая подпись не подтверждается.
 *
 * Опция `base64` в параметрах `sign` формат входа не задаёт — его определяет
 * только четвёртый аргумент.
 */
const DATA_FORMAT_BASE64 = 1

interface RutokenModule {
  ready: Promise<unknown>
  isExtensionInstalled(): Promise<boolean>
  isPluginInstalled(): Promise<boolean>
  loadPlugin(): Promise<RutokenPlugin>
}

interface RutokenPlugin {
  enumerateDevices(options?: unknown): Promise<number[]>
  enumerateCertificates(deviceId: number, category: number): Promise<string[]>
  getCertificate(deviceId: number, certId: string): Promise<string>
  parseCertificate(deviceId: number, certId: string): Promise<Record<string, unknown>>
  login(deviceId: number, pin: string): Promise<void>
  logout(deviceId: number): Promise<void>
  sign(
    deviceId: number,
    certId: string,
    data: string,
    dataFormat: number,
    options?: Record<string, unknown>,
  ): Promise<string>
  /**
   * Проверка подписи. Сигнатура снята с документации Актива
   * (plugin.api.rutoken.ru): подписанные данные для открепленной подписи
   * передаются не аргументом, а опцией `data`.
   */
  verify(
    deviceId: number,
    cms: string,
    options?: Record<string, unknown>,
  ): Promise<boolean>
  cmsEncrypt(
    deviceId: number,
    certId: string,
    recipientCerts: string[],
    data: string,
    options?: Record<string, unknown>,
  ): Promise<string>
  getDeviceInfo?(deviceId: number, option: number): Promise<unknown>
}

/** Идентификатор вида `<deviceId>:<certId>` — устройство плюс сертификат. */
function packId(deviceId: number, certId: string): string {
  return `${deviceId}:${certId}`
}

function unpackId(id: string): { deviceId: number; certId: string } {
  const at = id.indexOf(':')
  if (at < 0) throw new CryptoError(`Некорректный идентификатор сертификата: ${id}`)
  return { deviceId: Number(id.slice(0, at)), certId: id.slice(at + 1) }
}

/** Собирает «CN=…, O=…» из того, что вернул parseCertificate. */
function joinRdn(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        const p = part as Record<string, unknown>
        const key = p.rdn ?? p.oid ?? p.type
        return key ? `${String(key)}=${String(p.value ?? '')}` : String(p.value ?? '')
      })
      .join(', ')
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')
  }
  return ''
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (source[k] !== undefined) return source[k]
  return undefined
}

/**
 * Плагин отклоняет промис не ошибкой, а объектом
 * `{ message: <число>, error: <строка>, description: <строка> }`.
 * Обычное `(e as Error).message` даёт из него голое число вроде «54», по
 * которому ничего не понять; смысл лежит в `description`.
 */
function describeRutokenError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; error?: unknown; description?: unknown }
    const code = typeof e.message === 'number' ? `код ${e.message}` : undefined
    const text = [e.description, e.error].find((v) => typeof v === 'string' && v)
    const parts = [text, code].filter(Boolean)
    if (parts.length) return parts.join(', ')
  }
  return String(error)
}

/** Отказ во входе оттого, что вход на токен уже выполнен. */
function alreadyLoggedIn(error: unknown): boolean {
  return Number((error as { message?: unknown } | null)?.message) === ALREADY_LOGGED_IN
}

export class RutokenProvider implements CryptoProvider {
  readonly id = 'rutoken'
  readonly title = 'Рутокен Плагин'
  /** Ключ неизвлекаемый, ПИН запрашивает приложение через login(). */
  readonly requiresPin = true

  private plugin: RutokenPlugin | null = null
  private bootstrap: RutokenModule | null = null
  private readonly unlocked = new Set<number>()

  /**
   * Загрузчик Рутокена подтягивается по требованию.
   *
   * Именно импортом, а не тегом `<script>` из `public/`: библиотека не может
   * требовать, чтобы потребитель разложил файлы у себя. Динамически — чтобы
   * код Рутокена не попадал ни в основной кусок сборки, ни на страницу, если
   * пользователь входит другим средством.
   */
  private async module(): Promise<RutokenModule> {
    if (!this.bootstrap) {
      try {
        const imported = await import('@aktivco/rutoken-plugin')
        this.bootstrap = (imported.default ?? imported) as RutokenModule
      } catch (error) {
        throw new CryptoError(
          'Не удалось загрузить модуль Рутокен Плагина',
          `Пакет @aktivco/rutoken-plugin не подгрузился: ${(error as Error).message}`,
        )
      }
    }
    return this.bootstrap
  }

  private require(): RutokenPlugin {
    if (!this.plugin) throw new CryptoError('Плагин не загружен. Сначала выполните проверку.')
    return this.plugin
  }

  /**
   * Срок ожидания обязателен на каждом обращении к плагину.
   *
   * Нативная часть живёт в отдельном процессе, и при её сбое промис не
   * отклоняется и не разрешается — страница ждёт молча и бесконечно. Без
   * срока это неотличимо от зависшего приложения.
   */
  private async withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new CryptoError(
                  `Рутокен Плагин не ответил за ${Math.round(ms / 1000)} с (${what})`,
                  'Нативная часть Рутокена не отвечает. По убыванию действенности: вынуть и вставить ' +
                    'токен, перезапустить браузер, переустановить Рутокен Плагин.',
                ),
              ),
            ms,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async detect(): Promise<ProviderStatus> {
    let m: RutokenModule
    try {
      m = await this.module()
    } catch (e) {
      return { available: false, reason: (e as CryptoError).message, hint: (e as CryptoError).hint }
    }

    try {
      // Сроком обёрнут каждый шаг, а не только loadPlugin: упавший нативный
      // хост подвешивает любой вызов, до которого дойдёт очередь, и заранее
      // неизвестно какой именно
      await this.withTimeout(Promise.resolve(m.ready), PLUGIN_TIMEOUT_MS, 'инициализация')

      if (!(await this.withTimeout(m.isExtensionInstalled(), PLUGIN_TIMEOUT_MS, 'опрос расширения'))) {
        return {
          available: false,
          reason: 'Расширение Рутокен для браузера не установлено',
          hint: 'Поставьте «Адаптер Рутокен Плагин» из магазина расширений браузера, затем перезагрузите страницу.',
        }
      }
      if (!(await this.withTimeout(m.isPluginInstalled(), PLUGIN_TIMEOUT_MS, 'опрос плагина'))) {
        return {
          available: false,
          reason: 'Расширение есть, но сам Рутокен Плагин не установлен',
          hint:
            'Нужен именно Рутокен Плагин. Библиотека librtpkcs11ecp — нативная, ' +
            'браузеру она недоступна, наличие драйверов Рутокена ещё не значит, что веб-страница увидит токен.',
        }
      }

      this.plugin = await this.withTimeout(m.loadPlugin(), PLUGIN_TIMEOUT_MS, 'загрузка плагина')
      const devices = await this.withTimeout(
        this.plugin.enumerateDevices(),
        PLUGIN_TIMEOUT_MS,
        'опрос устройств',
      )
      // Плагин установлен и грузится, даже когда токена в разъёме нет. Без
      // устройства подписывать нечем, поэтому это «недоступен», а не
      // «доступен, но пусто»: иначе вход упирается в Рутокен и не доходит
      // до КриптоПро, которым пользователь как раз и хотел войти.
      if (!devices.length) {
        return {
          available: false,
          reason: 'Рутокен не подключён',
          hint: 'Вставьте токен. Если входите другим средством — оно будет опрошено следующим.',
        }
      }

      return {
        available: true,
        version: `плагин загружен, устройств: ${devices.length}`,
      }
    } catch (e) {
      return { available: false, reason: `Рутокен Плагин не отвечает: ${(e as Error).message ?? e}` }
    }
  }

  async listCertificates(store: CertStore): Promise<CertInfo[]> {
    if (store === 'addressbook') {
      // У токена нет хранилища «Другие пользователи»: сертификаты получателей
      // передаются в cmsEncrypt строками. Пустой список здесь — не ошибка.
      return []
    }

    const plugin = this.require()
    const devices = await plugin.enumerateDevices()
    const result: CertInfo[] = []

    for (const deviceId of devices) {
      let certIds: string[]
      try {
        certIds = await plugin.enumerateCertificates(deviceId, CERT_CATEGORY_USER)
      } catch (e) {
        throw new CryptoError(
          `Не удалось прочитать сертификаты устройства ${deviceId}: ${(e as Error).message ?? e}`,
          'Возможно, требуется ПИН — введите его и повторите.',
        )
      }

      for (const certId of certIds) {
        result.push(await this.describe(deviceId, certId))
      }
    }
    return result
  }

  private async describe(deviceId: number, certId: string): Promise<CertInfo> {
    const plugin = this.require()
    const id = packId(deviceId, certId)
    let parsed: Record<string, unknown> = {}
    try {
      parsed = await plugin.parseCertificate(deviceId, certId)
    } catch {
      // разбор требует авторизации — покажем то, что есть
    }

    const subject = joinRdn(pick(parsed, 'subject', 'subjectName')) || `сертификат ${certId}`
    const issuer = joinRdn(pick(parsed, 'issuer', 'issuerName'))
    const validTo = String(pick(parsed, 'validNotAfter', 'notAfter', 'validTo') ?? '')
    const validFrom = String(pick(parsed, 'validNotBefore', 'notBefore', 'validFrom') ?? '')
    return {
      id,
      subject,
      issuer,
      issuerCn: commonName(issuer),
      cn: commonName(subject),
      validFrom: validFrom.slice(0, 10),
      validTo: validTo.slice(0, 10),
      thumbprint: certId,
      inn: innFrom(subject),
    }
  }

  /** Логинится на все подключённые устройства: ПИН вводится один раз. */
  async unlock(pin: string): Promise<void> {
    const plugin = this.require()
    const devices = await plugin.enumerateDevices()
    if (!devices.length) throw new CryptoError('Нет подключённых устройств Рутокен')

    const failures: string[] = []
    for (const deviceId of devices) {
      try {
        try {
          await plugin.login(deviceId, pin)
        } catch (e) {
          // Вход на токен держит плагин, один на все сайты браузера: кто
          // входил этим токеном в другой кабинет, у того он уже открыт, и
          // повторный вход отклоняется при верном ПИН. Выход тут не помогает —
          // вход после него отклоняется так же. Токен открыт, подписывать
          // можно; введённый ПИН при этом не проверен — проверять его нечем.
          if (!alreadyLoggedIn(e)) throw e
        }
        this.unlocked.add(deviceId)
      } catch (e) {
        failures.push(`${deviceId}: ${describeRutokenError(e)}`)
      }
    }
    if (!this.unlocked.size) {
      throw new CryptoError(`Не удалось войти на устройство — ${failures.join('; ')}`, 'Проверьте ПИН.')
    }
  }

  async exportCertificate(certId: string): Promise<Uint8Array> {
    const { deviceId, certId: id } = unpackId(certId)
    // getCertificate отдаёт PEM; чтения закрытого ключа тут нет и быть не может
    const pem = await this.withTimeout(
      this.require().getCertificate(deviceId, id),
      PLUGIN_TIMEOUT_MS,
      'выгрузка сертификата',
    )
    return base64ToBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''))
  }

  async verifyDetached(signature: string, data: Uint8Array): Promise<VerifyResult> {
    const plugin = this.require()
    const devices = await this.withTimeout(plugin.enumerateDevices(), PLUGIN_TIMEOUT_MS, 'опрос устройств')
    const deviceId = devices[0]
    if (deviceId === undefined) throw new CryptoError('Нет подключённых устройств Рутокен')

    try {
      const valid = await this.withTimeout(
        plugin.verify(deviceId, signature, {
          data: bytesToBase64(data),
          base64: true,
          // Проверяется криптография, а не доверие к сертификату: цепочка и
          // отзыв — задача сервера. С verifyCertificate плагин отвечает
          // 12 «No CA certificates found»: корневых на устройстве нет.
          verifyCertificate: false,
          // requireCades не ставим: он тянет за собой ту же проверку
          // издателя и отвечает 54 «Unable to get local issuer certificate»
          // даже на корректной подписи CAdES-BES.
        }),
        PLUGIN_TIMEOUT_MS,
        'проверка подписи',
      )
      return valid ? { valid: true } : { valid: false, reason: 'Подпись не соответствует данным' }
    } catch (e) {
      return { valid: false, reason: describeRutokenError(e) }
    }
  }

  async signDetached(certId: string, data: Uint8Array): Promise<string> {
    const { deviceId, certId: id } = unpackId(certId)
    if (!this.unlocked.has(deviceId)) {
      // Не «заблокирован»: этим словом называют токен, исчерпавший попытки
      // ввода ПИН, и пугать им там, где просто не было входа, нельзя
      throw new CryptoError(
        'Вход на токен не выполнен',
        'Введите ПИН в поле выше и повторите — закрытый ключ до входа недоступен.',
      )
    }
    // addEssCert и addSignTime обязательны для профиля CAdES-BES
    const signature = await this.require().sign(deviceId, id, bytesToBase64(data), DATA_FORMAT_BASE64, {
      detached: true,
      addEssCert: true,
      addSignTime: true,
    })
    // PEM-обвязка и переносы мешают дальнейшей склейке в контейнер
    return signature.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  }

  async encrypt(recipients: readonly Recipient[], data: Uint8Array): Promise<string> {
    if (!recipients.length) throw new CryptoError('Не указан ни один получатель шифрования')
    if (recipients.some((r) => r.kind === 'store')) {
      throw new CryptoError(
        'Рутокен не умеет брать получателя из хранилища ОС',
        'Передайте сертификат приёмного комплекса PEM-строкой.',
      )
    }
    const plugin = this.require()
    const devices = await plugin.enumerateDevices()
    const deviceId = devices[0]
    if (deviceId === undefined) throw new CryptoError('Нет подключённых устройств Рутокен')

    const pems = recipients.map((r) => (r as { kind: 'pem'; pem: string }).pem)
    const encrypted = await plugin.cmsEncrypt(deviceId, '', pems, bytesToBase64(data), {
      base64: true,
    })
    return encrypted.replace(/[\r\n]/g, '')
  }
}
