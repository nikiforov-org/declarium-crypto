/**
 * Публичный вход крипто-модуля: опознание по сертификату и подпись им же.
 *
 * Наружу выходят два действия, всё остальное — внутреннее устройство:
 *
 *   const session = await authenticate({ chooseCertificate, requestPin })
 *   const signature = await session.sign(bytes)
 *
 * ── Порядок опроса ──────────────────────────────────────────────────────────
 * Сначала Рутокен, потом КриптоПро. Это приоритет, а не запасной путь: на
 * машине, где стоят оба, работать будут тоже оба — КриптоПро CSP видит ключи
 * Рутокена как свои контейнеры, а Рутокен Плагин те же ключи как объекты
 * PKCS#11, и список сертификатов совпадает. Значит порядок решает не «что
 * доступно», а «через что подписывать».
 *
 * ── Выбор сертификата ───────────────────────────────────────────────────────
 * `chooseCertificate` зовётся всегда, даже когда сертификат один: человек
 * должен видеть, чем он собирается подписывать, до того как подпишет.
 *
 * ── ПИН ─────────────────────────────────────────────────────────────────────
 * Спрашивается лениво, при первом обращении к закрытому ключу, и только у
 * Рутокена — КриптоПро показывает собственное окно. Читать сертификаты можно
 * без ПИН у обоих, поэтому список и выбор идут раньше: просить ПИН до того,
 * как человек увидел, за что подписывается, незачем.
 */

import { CryptoProProvider } from './cryptopro.js'
import { RutokenProvider } from './rutoken.js'
import { parseCertificate, type X509Certificate } from './x509.js'
import {
  CryptoError,
  type CertInfo,
  type CryptoProvider,
  type ProviderStatus,
  type Recipient,
  type VerifyResult,
} from './types.js'

export type ProviderId = 'rutoken' | 'cryptopro'

/** Порядок по умолчанию: приоритет у токена. */
const DEFAULT_ORDER: readonly ProviderId[] = ['rutoken', 'cryptopro']

const FACTORIES: Readonly<Record<ProviderId, () => CryptoProvider>> = {
  rutoken: () => new RutokenProvider(),
  cryptopro: () => new CryptoProProvider(),
}

export interface CertificateChoice {
  /** Ключ для обращения к сертификату внутри провайдера. */
  readonly id: string
  readonly certificate: X509Certificate
}

export interface AuthenticateOptions {
  /**
   * Показать сертификаты и вернуть идентификатор выбранного.
   * Вызывается всегда, в том числе когда сертификат единственный.
   */
  chooseCertificate(list: readonly CertificateChoice[]): Promise<string>
  /** Запрос ПИН. Нужен только для Рутокена и только при работе с ключом. */
  requestPin?(): Promise<string>
  /** Порядок опроса бэкендов. По умолчанию Рутокен, затем КриптоПро. */
  order?: readonly ProviderId[]
}

export interface Session {
  readonly provider: ProviderId
  readonly providerTitle: string
  /** Внутренний идентификатор — пригодится, если понадобится второй сеанс. */
  readonly certificateId: string
  readonly certificate: X509Certificate
  /** Открепленная подпись CAdES-BES, CMS в base64. */
  sign(data: Uint8Array): Promise<string>
  /** Криптографическая проверка открепленной подписи. Цепочку не строит. */
  verify(signature: string, data: Uint8Array): Promise<VerifyResult>
  /** CMS EnvelopedData. К опознанию отношения не имеет, нужен сборке контейнера. */
  encrypt(recipients: readonly Recipient[], data: Uint8Array): Promise<string>
}

export interface ProviderAttempt {
  provider: ProviderId
  title: string
  reason?: string
  hint?: string
}

/** Ни один бэкенд не отозвался. В `attempts` — что именно сказал каждый. */
export class NoProviderError extends CryptoError {
  readonly attempts: readonly ProviderAttempt[]

  constructor(attempts: readonly ProviderAttempt[]) {
    super(
      'Не найдено средство электронной подписи',
      'Нужен либо Рутокен Плагин с адаптером в браузере, либо КриптоПро ЭЦП Browser plug-in с расширением.',
    )
    this.name = 'NoProviderError'
    this.attempts = attempts
  }
}

const EMPTY_STORE_HINT: Readonly<Record<ProviderId, string>> = {
  rutoken: 'Проверьте, что токен вставлен и на нём есть сертификаты.',
  cryptopro:
    'Контейнеры могут быть видны, а хранилище «Личные» пусто: сертификаты не попадают туда сами. ' +
    'Установите их командой «csptestf -absorb -certs» либо «certmgr -inst -cont».',
}

/**
 * Общий предел на опрос одного бэкенда.
 *
 * Свой срок есть и внутри провайдеров, но полагаться только на него нельзя:
 * это чужие плагины, живущие в нативных процессах, и способ подвиснуть у них
 * найдётся там, где обёртки нет. Вход не должен зависать никогда — лучше
 * объявить средство недоступным и перейти к следующему.
 */
const DETECT_TIMEOUT_MS = 20_000

async function detectWithLimit(provider: CryptoProvider): Promise<ProviderStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      provider.detect(),
      new Promise<ProviderStatus>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              available: false,
              reason: `${provider.title} не ответил за ${DETECT_TIMEOUT_MS / 1000} с`,
              hint: 'Похоже, нативный компонент средства подписи не отвечает. Помогает перезапуск браузера.',
            }),
          DETECT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Первый бэкенд, которым действительно можно войти.
 *
 * Мало того, чтобы он отозвался: нужен хотя бы один сертификат. Средство
 * подписи бывает установлено и работоспособно, а подписывать нечем —
 * например, у Рутокена вынут токен, а у КриптоПро пустое хранилище
 * «Личные». Останавливаться на таком нельзя: пользователь, у которого нет
 * Рутокена, обязан дойти до КриптоПро.
 *
 * Сертификаты читаются здесь же, а не после выбора бэкенда, именно поэтому:
 * пустой список — такой же повод идти дальше, как и отсутствие плагина.
 */
async function firstUsable(
  order: readonly ProviderId[],
): Promise<{ id: ProviderId; provider: CryptoProvider; certificates: readonly CertInfo[] }> {
  const attempts: ProviderAttempt[] = []

  for (const id of order) {
    const provider = FACTORIES[id]()
    const status = await detectWithLimit(provider)
    if (!status.available) {
      attempts.push({ provider: id, title: provider.title, reason: status.reason, hint: status.hint })
      continue
    }

    let certificates: CertInfo[]
    try {
      certificates = await provider.listCertificates('my')
    } catch (error) {
      const e = error as { message?: string; hint?: string }
      attempts.push({ provider: id, title: provider.title, reason: e?.message, hint: e?.hint })
      continue
    }

    if (certificates.length) return { id, provider, certificates }
    attempts.push({
      provider: id,
      title: provider.title,
      reason: 'Средство подписи работает, но сертификатов нет',
      hint: EMPTY_STORE_HINT[id],
    })
  }

  throw new NoProviderError(attempts)
}

export async function authenticate(options: AuthenticateOptions): Promise<Session> {
  const { id, provider, certificates } = await firstUsable(options.order ?? DEFAULT_ORDER)

  // Разбираем DER, а не строку субъекта от провайдера: у двух бэкендов она
  // выглядит по-разному, а сертификат один и тот же
  const choices: CertificateChoice[] = await Promise.all(
    certificates.map(async (cert) => ({
      id: cert.id,
      certificate: parseCertificate(await provider.exportCertificate(cert.id)),
    })),
  )

  const chosenId = await options.chooseCertificate(choices)
  const chosen = choices.find((c) => c.id === chosenId)
  if (!chosen) throw new CryptoError('Выбран сертификат, которого нет в списке')

  let unlocked = false
  const ensureKeyAccess = async (): Promise<void> => {
    if (unlocked || !provider.requiresPin || !provider.unlock) return
    if (!options.requestPin) {
      throw new CryptoError(
        'Для работы с ключом нужен ПИН',
        'Передайте обработчик requestPin в authenticate.',
      )
    }
    await provider.unlock(await options.requestPin())
    unlocked = true
  }

  return {
    provider: id,
    providerTitle: provider.title,
    certificateId: chosen.id,
    certificate: chosen.certificate,

    async sign(data) {
      await ensureKeyAccess()
      return provider.signDetached(chosen.id, data)
    },

    // проверка и шифрование закрытого ключа не трогают — ПИН для них не нужен
    verify: (signature, data) => provider.verifyDetached(signature, data),
    encrypt: (recipients, data) => provider.encrypt(recipients, data),
  }
}
