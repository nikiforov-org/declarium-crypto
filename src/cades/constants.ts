/**
 * Константы CAPICOM/CADESCOM — только те, что действительно используются.
 *
 * Официальный загрузчик тащит таблицу из трёхсот значений (треть файла), из
 * которых нужны семь. Значения сверены с `cadesplugin_api.js` 2.4.5; ссылка на
 * источник рядом с каждой группой, чтобы сверку можно было повторить.
 */

/** Расположение хранилища сертификатов. */
export const StoreLocation = {
  CurrentUser: 2,
} as const
export type StoreLocation = (typeof StoreLocation)[keyof typeof StoreLocation]

/** Имя хранилища. */
export const StoreName = {
  /** «Личные» — сертификаты пользователя с привязкой к закрытому ключу. */
  My: 'My',
  /** «Другие пользователи» — сюда ставится сертификат приёмного комплекса. */
  AddressBook: 'AddressBook',
} as const
export type StoreName = (typeof StoreName)[keyof typeof StoreName]

/** Режим открытия хранилища. */
export const StoreOpenMode = {
  MaximumAllowed: 2,
} as const
export type StoreOpenMode = (typeof StoreOpenMode)[keyof typeof StoreOpenMode]

/** Как трактовать строку, переданную в Content. */
export const ContentEncoding = {
  /** Содержимое — base64, плагин раскодирует его в двоичные данные. */
  Base64ToBinary: 1,
} as const
export type ContentEncoding = (typeof ContentEncoding)[keyof typeof ContentEncoding]

/** Профиль усовершенствованной подписи. */
export const CadesType = {
  Bes: 1,
  T: 0x5,
  XLongType1: 0x5d,
} as const
export type CadesType = (typeof CadesType)[keyof typeof CadesType]

/** Кодировка результата шифрования. */
export const OutputEncoding = {
  Base64: 0,
  Binary: 1,
} as const
export type OutputEncoding = (typeof OutputEncoding)[keyof typeof OutputEncoding]

/** Тип продукта для запроса версии через About.CSPVersion. */
export const ProductType = {
  Csp: 75,
} as const
export type ProductType = (typeof ProductType)[keyof typeof ProductType]
