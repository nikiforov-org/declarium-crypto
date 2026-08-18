/**
 * Абстракция над средством электронной подписи.
 *
 * Реализации — КриптоПро ЭЦП Browser plug-in и Рутокен Плагин. Ни одна не
 * извлекает и не хранит закрытый ключ: подпись и выработка ключа шифрования
 * выполняются сертифицированным средством криптографической защиты.
 */

export type CertStore = 'my' | 'addressbook'

export interface CertInfo {
  /** Ключ для обращения к сертификату внутри провайдера. */
  id: string
  subject: string
  issuer: string
  issuerCn: string
  cn: string
  validFrom: string
  validTo: string
  thumbprint: string
  /** ИНН из сертификата, если он там есть. */
  inn?: string
}

export interface ProviderStatus {
  available: boolean
  version?: string
  cspVersion?: string
  /** Идентификатор и версия расширения браузера, если провайдер их знает. */
  extension?: string
  /** Причина недоступности — показывается пользователю как есть. */
  reason?: string
  /** Что делать, чтобы починить. Первый вход — самый хрупкий момент продукта. */
  hint?: string
}

/**
 * Получатель шифрования.
 *
 * КриптоПро умеет взять сертификат из хранилища «Другие пользователи». У
 * Рутокена такого хранилища нет — он принимает сертификаты получателей только
 * PEM-строками, поэтому вариант `pem` работает с обоими средствами.
 */
export type Recipient = { kind: 'store'; certId: string } | { kind: 'pem'; pem: string }

/** Итог проверки подписи. */
export interface VerifyResult {
  valid: boolean
  /** Почему не сошлось — текст от провайдера, как есть. */
  reason?: string
}

export interface CryptoProvider {
  readonly id: string
  readonly title: string
  /** Нужен ли ПИН перед криптографическими операциями (аппаратный токен). */
  readonly requiresPin: boolean

  detect(): Promise<ProviderStatus>
  listCertificates(store: CertStore): Promise<CertInfo[]>

  /** Ввод ПИН на подключённых устройствах. Провайдерам с собственным окном не нужен. */
  unlock?(pin: string): Promise<void>

  /**
   * Сертификат в DER. Открытая часть — закрытый ключ из токена не выходит
   * никогда. Нужен, чтобы разобрать поля одинаково для обоих бэкендов и чтобы
   * серверу было чем проверять подпись.
   */
  exportCertificate(certId: string): Promise<Uint8Array>

  /** Открепленная подпись CAdES-BES. Возвращает CMS в base64. */
  signDetached(certId: string, data: Uint8Array): Promise<string>

  /**
   * Криптографическая проверка открепленной подписи.
   *
   * Проверяется, что подпись математически верна для этих данных. Построение
   * цепочки до аккредитованного удостоверяющего центра и проверка отзыва сюда
   * не входят: они требуют сети и корневых сертификатов и выполняются на
   * стороне, принимающей решение о доверии.
   */
  verifyDetached(signature: string, data: Uint8Array): Promise<VerifyResult>

  /**
   * CMS EnvelopedData на сертификатах получателей. Возвращает base64.
   *
   * Получателей может быть несколько: часть форматов обмена требует
   * адресовать сообщение и получателю, и отправителю, иначе отправитель не
   * сможет прочитать то, что сам же отправил.
   */
  encrypt(recipients: readonly Recipient[], data: Uint8Array): Promise<string>
}

/** Убирает PEM-обвязку и переводы строк, оставляя чистый base64 DER. */
export function pemToBase64(pem: string): string {
  return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
}

export class CryptoError extends Error {
  /** Что делать пользователю — показывается под текстом ошибки. */
  hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'CryptoError'
    this.hint = hint
  }
}
