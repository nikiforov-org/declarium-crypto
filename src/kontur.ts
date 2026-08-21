/**
 * Реализация CryptoProvider поверх Контур.Плагина.
 *
 * Третье средство подписи после КриптоПро и Рутокена — и устроено оно иначе
 * обоих. Расширение Контура не даёт странице ни объекта плагина, ни скрипта:
 * весь обмен идёт сообщениями окна, а криптографию выполняет нативный хост
 * `kontur.plugin`, обращаясь к установленному криптопровайдеру (на практике —
 * к КриптоПро CSP). Подробности протокола — в `./kontur/contract.ts`.
 *
 * ── Обособленность ──────────────────────────────────────────────────────────
 * Средство подписи отвечает за один маршрут и ничего не знает об остальных.
 * Здесь это значит: работаем только собственным каналом Контура — ГОСТ поверх
 * PKCS#11, напрямую к токену. Хранилища операционной системы не читаются
 * вовсе.
 *
 * Причина не в чистоте ради чистоты. Хост Контура умеет ещё и CryptoAPI, то
 * есть хранилища криптопровайдера. Стоит заглянуть туда — и оттуда придут
 * контейнеры КриптоПро, а подписывать станет он: своим окном, своими
 * ошибками, своим требованием носителя. Пользователь при этом выбирал Контур,
 * и КриптоПро у него может не стоять вовсе. Такой маршрут называется Контуром,
 * а Контуром не является.
 *
 * Кому нужен криптопровайдер — тот идёт в `cryptopro.ts`. Выбор между
 * средствами делает `authenticate.ts` и только он.
 *
 * ── Чего этот провайдер не делает ───────────────────────────────────────────
 * Хост умеет читать файлы, ходить в сеть и запускать процессы. Библиотека
 * пользуется только сертификатами и подписью; остальные команды сюда не
 * попадают намеренно.
 */

import { base64ToBytes, bytesToBase64 } from './base64.js'
import { commonName, innFrom } from './rdn.js'
import {
  KonturCommand,
  KonturTransport,
  type KonturBlob,
  type KonturCertProperties,
  type KonturCertificate,
  type KonturName,
  type KonturPluginInfo,
  type KonturStore,
  type KonturThumbprint,
} from './kontur/index.js'
import {
  CryptoError,
  pemToBase64,
  type CertInfo,
  type CertStore,
  type CryptoProvider,
  type ProviderStatus,
  type Recipient,
  type VerifyResult,
} from './types.js'

/**
 * Единственное хранилище, с которым работает этот сабмодуль: сертификаты на
 * токене, видимые через PKCS#11.
 *
 * Хранилищ у хоста больше, но остальные принадлежат криптопровайдеру, и здесь
 * им делать нечего — см. пояснение про обособленность в шапке файла.
 *
 * Ни `name`, ни `location` не указываются намеренно: это понятия CryptoAPI, а
 * у токена всё содержимое — одно хранилище. С ними хост отвечает пустым
 * списком, не сообщая об ошибке.
 */
const TOKEN_STORE: KonturStore = { storeType: 'pkcs11' }

/**
 * Что запрашиваем у хоста про каждый сертификат.
 *
 * `content` берётся сразу вместе со списком, а не отдельной командой при
 * выгрузке: у `cert.search` фильтр по конкретному сертификату не описан
 * нигде, а лишний обход хранилища ради тех же байтов не нужен.
 */
const CERT_PROPERTIES: KonturCertProperties = {
  content: true,
  subject: true,
  issuer: true,
  serialNumber: true,
  validFrom: true,
  validTo: true,
  hasPrivateKey: true,
}

/**
 * Значение атрибута DN обратно в кавычную форму X.500.
 *
 * Контур отдаёт имя разобранным на пары, а разбор в библиотеке — общий и
 * строковый (`rdn.ts`). Обратная сборка дешевле второго разборщика и
 * гарантирует, что все три провайдера показывают имя одинаково.
 */
function quote(value: string): string {
  return /[",]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function nameToDn(name: KonturName | undefined): string {
  if (!name) return ''
  const parts: string[] = []
  for (const attribute of name) {
    for (const [key, value] of Object.entries(attribute)) {
      if (value) parts.push(`${key}=${quote(value)}`)
    }
  }
  return parts.join(', ')
}

/** Отпечаток в том же виде, что у КриптоПро: шестнадцатеричный, прописными. */
function thumbprintOf(certificate: KonturCertificate): string {
  return certificate.hash.data.toUpperCase()
}

function thumbprintRef(hex: string): KonturThumbprint {
  return { type: 'hex', data: hex.toLowerCase(), size: 20 }
}

function shortDate(value: string | undefined): string {
  return (value ?? '').slice(0, 10)
}

/**
 * Достаёт base64 из ответа хоста.
 *
 * Приёмник объявлен как `{ type: 'base64' }`, и результат возвращается в теле
 * ответа. Где именно — у разных команд по-разному, поэтому перебираются
 * известные места, а при незнакомой форме ошибка называет ключи ответа: на
 * живой машине этого хватает, чтобы понять, что поменялось.
 */
function blobData(result: unknown, context: string): string {
  const holder = result as { sink?: KonturBlob; data?: string; signature?: KonturBlob; content?: KonturBlob } | null
  const found = holder?.sink?.data ?? holder?.signature?.data ?? holder?.content?.data ?? holder?.data
  if (typeof found === 'string' && found) return found.replace(/[\r\n]/g, '')

  const keys = holder && typeof holder === 'object' ? Object.keys(holder).join(', ') : String(result)
  throw new CryptoError(
    `${context}: хост не вернул данные в ожидаемом виде`,
    `Ответ содержит: ${keys}. Похоже, протокол Контур.Плагина изменился.`,
  )
}

export class KonturProvider implements CryptoProvider {
  readonly id = 'kontur'
  readonly title = 'Контур.Плагин'
  /**
   * ПИН запрашивает сам Контур своим окном — хост лишь передаёт вызов.
   * Своего поля ввода библиотеке заводить не нужно.
   */
  readonly requiresPin = false

  private readonly transport = new KonturTransport()


  /** Сертификаты по внутреннему идентификатору: отпечаток и разобранный DER. */
  private readonly certificates = new Map<string, { thumbprint: string; der: Uint8Array }>()

  async detect(): Promise<ProviderStatus> {
    const extension = await this.transport.extensionInfo()
    if (!extension) {
      return {
        available: false,
        reason: 'Расширение «Контур.Плагин» в браузере не найдено',
        hint: 'Поставьте расширение «Контур.Плагин» из магазина расширений браузера и перезагрузите страницу.',
      }
    }

    let info: KonturPluginInfo
    try {
      info = await this.transport.command<KonturPluginInfo>(
        KonturCommand.PluginInfo,
        { extended: true },
        { context: 'Контур.Плагин не отвечает' },
      )
    } catch (error) {
      return {
        available: false,
        reason: `Расширение есть, но сам Контур.Плагин не отвечает: ${(error as Error).message}`,
        hint:
          'Нужна нативная часть — приложение «Контур.Плагин». Одного расширения недостаточно: ' +
          'криптография выполняется вне браузера.',
        extension: `${extension.id} · ${extension.version}`,
      }
    }

    return {
      available: true,
      version: info.pluginVersion,
      extension: `${extension.id} · ${extension.version}`,
    }
  }

  private search(store: KonturStore): Promise<KonturCertificate[]> {
    return this.transport.command<KonturCertificate[]>(
      KonturCommand.CertSearch,
      { filter: { store }, properties: CERT_PROPERTIES },
      {
        context: `Не удалось прочитать сертификаты (${store.storeType})`,
        hint: 'Проверьте, что токен вставлен и Контур.Плагин его видит.',
      },
    )
  }

  async listCertificates(store: CertStore): Promise<CertInfo[]> {
    // Хранилища получателей у токена нет: сертификаты адресатов передаются в
    // шифрование строками, поэтому здесь честнее вернуть пустой список
    if (store !== 'my') return []

    const found = await this.search(TOKEN_STORE)

    const result: CertInfo[] = []
    const seen = new Set<string>()
    for (const certificate of found) {
      // Записи без отпечатка встречаются: хост отдаёт пустые элементы, когда
      // сертификат в хранилище есть, а прочитать его не удалось
      if (!certificate?.hash?.data) continue

      const thumbprint = thumbprintOf(certificate)
      // Один и тот же сертификат виден и как контейнер CSP, и как объект
      // токена — в списке он должен быть один
      if (seen.has(thumbprint)) continue
      seen.add(thumbprint)

      const id = `${store}:${thumbprint}`
      const subject = nameToDn(certificate.subject)
      const issuer = nameToDn(certificate.issuer)

      if (certificate.content?.data) {
        this.certificates.set(id, { thumbprint, der: base64ToBytes(certificate.content.data) })
      }

      result.push({
        id,
        subject,
        issuer,
        issuerCn: commonName(issuer),
        cn: commonName(subject),
        validFrom: shortDate(certificate.validFrom),
        validTo: shortDate(certificate.validTo),
        thumbprint,
        inn: innFrom(subject),
      })
    }
    return result
  }

  private require(certId: string): { thumbprint: string; der: Uint8Array } {
    const known = this.certificates.get(certId)
    if (!known) throw new CryptoError('Сертификат не найден. Обновите список сертификатов.')
    return known
  }

  async exportCertificate(certId: string): Promise<Uint8Array> {
    return this.require(certId).der
  }

  async signDetached(certId: string, data: Uint8Array): Promise<string> {
    const { thumbprint } = this.require(certId)
    const result = await this.transport.command(
      KonturCommand.Sign,
      {
        source: { type: 'base64', data: bytesToBase64(data) },
        sink: { type: 'base64' },
        certs: [{ hasPrivateKey: true, hash: thumbprintRef(thumbprint) }],
        // открепленная подпись: подписанные данные в CMS не вкладываются
        attached: false,
      },
      {
        context: 'Не удалось подписать',
        hint: 'Проверьте, что к сертификату есть закрытый ключ и носитель на месте.',
      },
    )
    return blobData(result, 'Подпись')
  }

  async verifyDetached(signature: string, data: Uint8Array): Promise<VerifyResult> {
    try {
      const result = await this.transport.command<{ valid?: boolean; signers?: unknown[] }>(
        KonturCommand.Verify,
        {
          source: { type: 'base64', data: bytesToBase64(data) },
          signature: { type: 'base64', data: signature.replace(/[\r\n]/g, '') },
        },
        { context: 'Подпись не подтверждена' },
      )
      // Расхождение подписи хост сообщает ошибкой, а не значением, поэтому
      // дошедший сюда ответ считается подтверждением
      return { valid: result?.valid !== false }
    } catch (error) {
      return { valid: false, reason: (error as Error).message }
    }
  }

  async encrypt(recipients: readonly Recipient[], data: Uint8Array): Promise<string> {
    if (!recipients.length) throw new CryptoError('Не указан ни один получатель шифрования')

    const certs = recipients.map((recipient) =>
      recipient.kind === 'store'
        ? { hash: thumbprintRef(this.require(recipient.certId).thumbprint) }
        : { content: { type: 'base64', data: pemToBase64(recipient.pem) } },
    )

    const result = await this.transport.command(
      KonturCommand.Encrypt,
      { source: { type: 'base64', data: bytesToBase64(data) }, sink: { type: 'base64' }, certs },
      {
        context: 'Не удалось зашифровать',
        hint: 'Проверьте сертификат получателя: он должен быть предназначен для шифрования.',
      },
    )
    return blobData(result, 'Шифрование')
  }
}
