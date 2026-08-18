/**
 * Типы COM-объектов КриптоПро, доступных через плагин.
 *
 * Плагин работает в асинхронном режиме: обращение к свойству возвращает не
 * значение, а промис — `await cert.SubjectName`. Поэтому свойства объявлены
 * как `Promise<T>`, а не как `T`. Это не украшательство: без него код молча
 * получает `[object Promise]` вместо строки.
 *
 * Контракт снят с cadesplugin_api.js 2.4.5 и nmcades_plugin_api.js 1.3.17,
 * сверяется с официальным загрузчиком после обновлений вендора.
 */

import type {
  CadesType,
  ContentEncoding,
  OutputEncoding,
  ProductType,
  StoreLocation,
  StoreName,
  StoreOpenMode,
} from './constants.js'

/**
 * Версия как отдельный COM-объект.
 *
 * Так CAdESCOM отдаёт версию продукта: не строкой, а объектом, у которого
 * `toString()` — тоже асинхронный. Пропустить его нельзя: вместо версии
 * получится объект, который дальше попадёт в вывод как есть.
 */
export interface CadesVersion {
  toString(): Promise<string>
}

/**
 * Сведения о версиях.
 *
 * Формы намеренно разные, это не описка (плагин 2.0.15700):
 *   · `Version`    → строка «2.0.15700»;
 *   · `CSPVersion` → CadesVersion, строка достаётся через toString();
 *   · `CSPName`    → строка «Crypto-Pro GOST R 34.10-2012 KC1 CSP».
 */
export interface CadesAbout {
  readonly Version: Promise<string>
  readonly MajorVersion: Promise<number>
  readonly BuildVersion: Promise<number>
  /** Версия продукта: имя провайдера и код типа, для CSP — ProductType.Csp. */
  CSPVersion(providerName: string, productType: ProductType): Promise<CadesVersion>
  /** Имя провайдера по коду типа. */
  CSPName(productType: ProductType): Promise<string>
}

/** Сертификат. */
export interface CadesCertificate {
  readonly SubjectName: Promise<string>
  readonly IssuerName: Promise<string>
  readonly ValidFromDate: Promise<string>
  readonly ValidToDate: Promise<string>
  readonly Thumbprint: Promise<string>
  readonly SerialNumber: Promise<string>
  /** Загружает сертификат из base64 DER — хранилище при этом не задействуется. */
  Import(base64: string): Promise<void>
  /**
   * Выгружает сертификат. Работает только кодировка Base64: на Binary плагин
   * 2.0.15700 отвечает 0x80070057 «Параметр задан неверно».
   */
  Export(encoding: OutputEncoding): Promise<string>
  /** true, если к сертификату привязан доступный закрытый ключ. */
  HasPrivateKey(): Promise<boolean>
}

/** Коллекция сертификатов. Нумерация с единицы — так устроен CAPICOM. */
export interface CadesCertificates {
  readonly Count: Promise<number>
  Item(index: number): Promise<CadesCertificate>
}

/** Хранилище сертификатов. */
export interface CadesStore {
  Open(location: StoreLocation, name: StoreName, mode: StoreOpenMode): Promise<void>
  Close(): Promise<void>
  readonly Certificates: Promise<CadesCertificates>
}

/** Подписант. Свойства задаются через propset_*, это соглашение CAdESCOM. */
export interface CadesSigner {
  propset_Certificate(certificate: CadesCertificate): Promise<void>
  propset_CheckCertificate(check: boolean): Promise<void>
}

/** Подписанные данные. */
export interface CadesSignedData {
  propset_ContentEncoding(encoding: ContentEncoding): Promise<void>
  propset_Content(content: string): Promise<void>
  /** Третий аргумент — открепленная подпись. Возвращает CMS в base64. */
  SignCades(signer: CadesSigner, type: CadesType, detached: boolean): Promise<string>
  /**
   * Проверяет подпись. Ничего не возвращает: при расхождении бросает
   * исключение с кодом — так устроен вендорский API, и так же его зовёт
   * демо-страница КриптоПро.
   *
   * Для открепленной подписи проверяемые данные задаются заранее через
   * propset_Content, а третьим аргументом идёт `true`.
   */
  VerifyCades(signature: string, type: CadesType, detached: boolean): Promise<void>
}

/** Получатели шифрования. */
export interface CadesRecipients {
  Add(certificate: CadesCertificate): Promise<void>
  readonly Count: Promise<number>
}

/** Зашифрованные данные, CMS EnvelopedData. */
export interface CadesEnvelopedData {
  propset_ContentEncoding(encoding: ContentEncoding): Promise<void>
  propset_Content(content: string): Promise<void>
  readonly Recipients: Promise<CadesRecipients>
  Encrypt(encoding: OutputEncoding): Promise<string>
}

/**
 * Соответствие имени COM-объекта его типу. Благодаря этому
 * `createObject('CAdESCOM.Store')` возвращает CadesStore, а не any,
 * и опечатка в имени — ошибка компиляции.
 */
export interface CadesObjectMap {
  'CAdESCOM.About': CadesAbout
  'CAdESCOM.Store': CadesStore
  'CAdESCOM.Certificate': CadesCertificate
  'CAdESCOM.CPSigner': CadesSigner
  'CAdESCOM.CadesSignedData': CadesSignedData
  'CAdESCOM.CPEnvelopedData': CadesEnvelopedData
}

export type CadesObjectName = keyof CadesObjectMap

/** Объект плагина, который расширение отдаёт через cadesplugin.set(). */
export interface CadesPluginObject {
  CreateObjectAsync(name: CadesObjectName): Promise<unknown>
  getLastError?(): string
}

/** Типобезопасный фасад над объектом плагина. */
export interface CadesPlugin {
  createObject<K extends CadesObjectName>(name: K): Promise<CadesObjectMap[K]>
  /** Текст последней ошибки от самого плагина, если он её отдаёт. */
  getLastError(): string | undefined
}
