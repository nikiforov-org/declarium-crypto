/**
 * Разбор сертификата X.509.
 *
 * ── Зачем разбирать DER, а не строку от провайдера ──────────────────────────
 * Оба провайдера умеют отдавать имя субъекта строкой, но делают это по-разному:
 * КриптоПро — в кавычной форме с кириллическими ключами
 * (`CN="ООО ""РОМАШКА""", ИНН=770000000000`), Рутокен — длинными именами
 * (`commonName=…, INN=…`). Разбор такой строки приходится подгонять под
 * каждое средство отдельно, и каждое новое поле добавляет ещё одно
 * расхождение.
 *
 * DER у обоих одинаков. Из него получается один результат независимо от
 * средства, а вдобавок расширения, серийный номер и точные даты, которых в
 * строке нет вовсе.
 *
 * ── Почему pkijs, а не свой разбор ──────────────────────────────────────────
 * ASN.1 — область, где собственная реализация ошибается на редких кодировках
 * строк и длинных формах длины, причём на чужих сертификатах, а не на своих.
 * `pkijs` здесь только читает байты и ничего не подписывает.
 *
 * Собственного в этом файле — отображение российских идентификаторов на
 * поля: ИНН, ОГРН, ОГРНИП и СНИЛС в общих библиотеках не значатся.
 *
 * ── Границы ─────────────────────────────────────────────────────────────────
 * Это чтение полей, а не проверка сертификата: подпись самого сертификата,
 * цепочка и отзыв здесь не проверяются.
 */

import { Certificate, ContentInfo, ExtKeyUsage, SignedData } from 'pkijs'

/** Идентификаторы атрибутов имени. Кириллические — российские дополнения. */
const AttributeOid = {
  commonName: '2.5.4.3',
  surname: '2.5.4.4',
  country: '2.5.4.6',
  locality: '2.5.4.7',
  state: '2.5.4.8',
  street: '2.5.4.9',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  title: '2.5.4.12',
  givenName: '2.5.4.42',
  email: '1.2.840.113549.1.9.1',
  /** ИНН физического лица. */
  innFl: '1.2.643.3.131.1.1',
  /** ИНН юридического лица — в сертификатах руководителей. */
  innUl: '1.2.643.100.4',
  ogrn: '1.2.643.100.1',
  ogrnip: '1.2.643.100.5',
  snils: '1.2.643.100.3',
} as const

/** Проверка подлинности клиента: назначение ключа, допускающее вход. */
export const EKU_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'
/** Защищённая электронная почта — покрывает подпись и шифрование CMS. */
export const EKU_EMAIL_PROTECTION = '1.3.6.1.5.5.7.3.4'

const EXTENDED_KEY_USAGE_OID = '2.5.29.37'

export class CertificateParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`Сертификат не разобран: ${message}`, options)
    this.name = 'CertificateParseError'
  }
}

/** Различительное имя: разобранные поля плюс всё остальное по идентификаторам. */
export interface DistinguishedName {
  /** Полный набор атрибутов по OID — для того, чего нет в именованных полях. */
  readonly attributes: ReadonlyMap<string, string>
  readonly commonName?: string
  readonly surname?: string
  readonly givenName?: string
  readonly title?: string
  readonly organization?: string
  readonly organizationalUnit?: string
  readonly country?: string
  readonly state?: string
  readonly locality?: string
  readonly street?: string
  readonly email?: string
  readonly innFl?: string
  readonly innUl?: string
  readonly ogrn?: string
  readonly ogrnip?: string
  readonly snils?: string
}

export interface X509Certificate {
  /** Исходные байты — их же отдаём серверу для проверки подписи. */
  readonly der: Uint8Array
  /** Серийный номер, шестнадцатеричный, прописными — как показывает certmgr. */
  readonly serialNumber: string
  readonly subject: DistinguishedName
  readonly issuer: DistinguishedName
  readonly notBefore: Date
  readonly notAfter: Date
  readonly extendedKeyUsage: readonly string[]
}

type NamePart = { type: string; value: { valueBlock: { value: unknown } } }

function toName(parts: readonly NamePart[]): DistinguishedName {
  const attributes = new Map<string, string>()
  for (const part of parts) {
    const value = String(part.value.valueBlock.value ?? '').trim()
    // при повторе побеждает первое вхождение — так же ведут себя штатные
    // средства просмотра сертификата
    if (value && !attributes.has(part.type)) attributes.set(part.type, value)
  }
  const digits = (oid: string) => attributes.get(oid)?.replace(/\D/g, '') || undefined
  return {
    attributes,
    commonName: attributes.get(AttributeOid.commonName),
    surname: attributes.get(AttributeOid.surname),
    givenName: attributes.get(AttributeOid.givenName),
    title: attributes.get(AttributeOid.title),
    organization: attributes.get(AttributeOid.organization),
    organizationalUnit: attributes.get(AttributeOid.organizationalUnit),
    country: attributes.get(AttributeOid.country),
    state: attributes.get(AttributeOid.state),
    locality: attributes.get(AttributeOid.locality),
    street: attributes.get(AttributeOid.street),
    email: attributes.get(AttributeOid.email),
    innFl: digits(AttributeOid.innFl),
    innUl: digits(AttributeOid.innUl),
    ogrn: digits(AttributeOid.ogrn),
    ogrnip: digits(AttributeOid.ogrnip),
    snils: digits(AttributeOid.snils),
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function extendedKeyUsage(certificate: Certificate): string[] {
  const extension = certificate.extensions?.find((e) => e.extnID === EXTENDED_KEY_USAGE_OID)
  const parsed = extension?.parsedValue
  return parsed instanceof ExtKeyUsage ? [...parsed.keyPurposes] : []
}

export function parseCertificate(der: Uint8Array): X509Certificate {
  let certificate: Certificate
  try {
    // копия обязательна: fromBER держит ссылку на буфер, а вызывающий вправе
    // переиспользовать свой массив
    certificate = Certificate.fromBER(der.slice().buffer)
  } catch (error) {
    throw new CertificateParseError('не разбирается как X.509', { cause: error })
  }

  return {
    der,
    // ведущий ноль в DER означает лишь «число положительное», в номере он лишний
    serialNumber: toHex(new Uint8Array(certificate.serialNumber.valueBlock.valueHexView)).replace(/^00/, ''),
    subject: toName(certificate.subject.typesAndValues as unknown as NamePart[]),
    issuer: toName(certificate.issuer.typesAndValues as unknown as NamePart[]),
    notBefore: certificate.notBefore.value,
    notAfter: certificate.notAfter.value,
    extendedKeyUsage: extendedKeyUsage(certificate),
  }
}

function toDer(value: string): Uint8Array {
  const clean = value.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const binary = atob(clean)
  const der = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i)
  return der
}

/** Принимает и PEM, и «голый» base64 — провайдеры отдают по-разному. */
export function parseCertificateFromBase64(value: string): X509Certificate {
  return parseCertificate(toDer(value))
}

/**
 * Достаёт сертификаты, вложенные в подпись CMS.
 *
 * Подпись CAdES-BES несёт относящийся к ней сертификат, поэтому подписанта
 * можно опознать по самой подписи, не обращаясь к носителю. Разбор общий для
 * обоих средств: у КриптоПро сертификат доступен и через `Signers`, у Рутокена
 * такого пути нет, а CMS у них одинаков.
 *
 * Первым идёт сертификат подписанта, дальше — цепочка, если вендор её вложил.
 * Возвращает пустой массив, если это не CMS SignedData.
 */
export function certificatesFromCms(value: string): X509Certificate[] {
  try {
    const info = ContentInfo.fromBER(toDer(value).slice().buffer)
    const signed = new SignedData({ schema: info.content })
    return (signed.certificates ?? [])
      .filter((c): c is Certificate => c instanceof Certificate)
      .map((c) => parseCertificate(new Uint8Array(c.toSchema().toBER())))
  } catch {
    return []
  }
}
