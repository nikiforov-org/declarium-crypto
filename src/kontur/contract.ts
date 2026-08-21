/**
 * Протокол Контур.Плагина.
 *
 * Опубликованного описания нет — контракт снят с трёх источников и сверен на
 * живом хосте:
 *
 *  · расширение «Контур.Плагин» 3.1.11 и 3.2.13 — транспорт и обёртка запроса;
 *  · нативный хост `kontur.plugin` 4.1.1.430 — словарь команд и имена полей
 *    (они лежат в таблице строк исполняемого файла);
 *  · клиент help.kontur.ru (`/App/dist/Plugin.js`) — форма параметров.
 *
 * Поэтому здесь описано только то, что нужно для входа и подписи, и ничего
 * сверх: у хоста есть команды работы с файловой системой, реестром и
 * запуском процессов, и им в этой библиотеке делать нечего.
 *
 * ── Как выглядит обмен ──────────────────────────────────────────────────────
 * Запрос: `{ sessionId, commandId, type, ...параметры }`. Поле `hostUri`
 * дописывает СТРАНИЦЕ НЕДОСТУПНЫМ образом сам content-скрипт расширения,
 * подставляя `event.origin`, — подделать его со страницы нельзя, и указывать
 * его здесь не нужно.
 *
 * Ответ: `{ sessionId, commandId, result }` либо `{ sessionId, commandId,
 * error: { code, message, type } }`. Ответ без `commandId` относится ко всему
 * сеансу — так приходит обрыв связи с хостом.
 */

/** Двоичное значение в обмене с хостом. */
export interface KonturBlob {
  type: 'base64' | 'hex'
  data: string
  size?: number
}

/** Отпечаток сертификата — SHA-1, шестнадцатеричный, 20 байт. */
export interface KonturThumbprint {
  type: 'hex'
  data: string
  size: 20
}

/**
 * Различительное имя приходит массивом односвязных объектов, а не строкой:
 * `[{ CN: '…' }, { ИНН: '…' }]`. Порядок — от последнего атрибута к первому.
 */
export type KonturName = readonly Readonly<Record<string, string>>[]

/** Запись сертификата. Набор полей определяется запрошенными properties. */
export interface KonturCertificate {
  hash: KonturThumbprint
  content?: KonturBlob
  subject?: KonturName
  issuer?: KonturName
  serialNumber?: KonturBlob
  validFrom?: string
  validTo?: string
  hasPrivateKey?: boolean
  qualified?: boolean
}

/** Какие поля сертификата вернуть. Пустой набор отдаёт только отпечаток. */
export interface KonturCertProperties {
  content?: boolean
  subject?: boolean
  issuer?: boolean
  serialNumber?: boolean
  validFrom?: boolean
  validTo?: boolean
  hasPrivateKey?: boolean
  qualified?: boolean
}

/**
 * Хранилище сертификатов.
 *
 * Своей криптографии у Контура нет, он работает через установленные в системе
 * средства, и каналов у него два: `cryptoApi` — хранилища операционной системы
 * через криптопровайдера (на практике КриптоПро CSP), `pkcs11` — библиотека
 * токена напрямую. Второй нужен там, где КриптоПро не установлен.
 *
 * `name` и `location` — понятия CryptoAPI: имена хранилищ операционной системы
 * из таблицы клиента Контура, `{1:'My', 2:'CA', 3:'AddressBook', 4:'ROOT',
 * 5:'Disallowed', 6:'tokens'}` и `{1:'machine', 2:'user'}`.
 *
 * У PKCS#11 хранилищ нет — есть токен, и весь он одно хранилище. Указывать там
 * `name` и `location` не просто лишнее: хост принимает такой запрос молча и
 * отвечает пустым списком, будто на токене ничего нет. Поэтому оба поля
 * необязательные, и для токена не передаются.
 */
export interface KonturStore {
  storeType: 'cryptoApi' | 'pkcs11'
  name?: 'My' | 'AddressBook' | 'CA' | 'ROOT'
  location?: 'user' | 'machine'
}

/** Сведения о расширении. Отдаёт фоновая страница, нативный хост не участвует. */
export interface KonturExtensionInfo {
  id: string
  type: string
  version: string
  /** Появилось в 3.2: признак включённости. */
  state?: number
}

/** Ответ `plugin.info`. */
export interface KonturPluginInfo {
  pluginVersion: string
  platform: string
  buildType: string
  /**
   * Сайт вне списка доверенных узлов Контура.
   *
   * Флаг справочный: хост его сообщает, но командам не препятствует —
   * проверено на произвольных источниках, включая `null`. Полагаться на него
   * как на разрешение нельзя ни в одну, ни в другую сторону.
   */
  denied?: boolean
  extended?: { installedVersion?: string; executablePath?: string }
}

/** Ошибка от хоста. */
export interface KonturError {
  code?: number
  message?: string
  type?: string
}

export interface KonturResponse<T = unknown> {
  sessionId?: string
  commandId?: number
  result?: T
  error?: KonturError
}

/** Команды, которыми пользуется библиотека. Хост знает больше — они не нужны. */
export const KonturCommand = {
  ExtensionInfo: 'extension.info',
  ExtensionClose: 'extension.close',
  PluginInfo: 'plugin.info',
  CertSearch: 'cert.search',
  CryptoProviders: 'crypto.getCryptoProviders',
  Sign: 'crypto.sign',
  Verify: 'crypto.verify',
  Encrypt: 'crypto.encrypt',
} as const

export type KonturCommandName = (typeof KonturCommand)[keyof typeof KonturCommand]
