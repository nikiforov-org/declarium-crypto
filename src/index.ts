/**
 * Крипто-модуль: опознание по сертификату и подпись им же.
 *
 * Два действия наружу — `authenticate()` и `session.sign()`. Провайдеры,
 * загрузчик плагина КриптоПро, типы COM-объектов и разбор ошибок остаются
 * внутри: снаружи не должно быть видно, чем именно подписано.
 *
 * Пошаговый интерфейс — `detect`, `listCertificates`, `unlock` и классы
 * средств подписи — вынесен в подпуть `./internals`: он нужен для ручного
 * управления шагами, а не для обычного применения.
 */

export {
  authenticate,
  NoProviderError,
  type AuthenticateOptions,
  type CertificateChoice,
  type ProviderAttempt,
  type ProviderId,
  type Session,
} from './authenticate.js'

export {
  certificatesFromCms,
  parseCertificate,
  parseCertificateFromBase64,
  CertificateParseError,
  EKU_CLIENT_AUTH,
  EKU_EMAIL_PROTECTION,
  type DistinguishedName,
  type X509Certificate,
} from './x509.js'

export { CryptoError, type Recipient, type VerifyResult } from './types.js'

/**
 * Плагины принимают и отдают двоичные данные строками base64 — подпись,
 * зашифрованный блок, сертификат. Поэтому кодировка входит в публичную
 * поверхность: без неё результатом невозможно пользоваться.
 */
export { base64ToBytes, bytesToBase64 } from './base64.js'
