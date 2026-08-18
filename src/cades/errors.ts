/**
 * Разбор ошибок КриптоПро.
 *
 * Объект ошибки плагина несёт числовое поле `number` с кодом HRESULT, а
 * `message` часто содержит лишь общую фразу. Вендор склеивает их в
 * «сообщение (0xXXXXXXXX)» — без кода ошибка неопознаваема, по коду находится
 * сразу. Здесь то же самое плюс расшифровка частых кодов.
 *
 * Про `cadesplugin.getLastError`: в браузерах с нативным обменом сообщениями
 * (то есть во всех современных) он сводится ровно к этой же склейке — так
 * написано в исходнике вендора. Обращение к плагину имеет смысл только как
 * дополнительный источник текста, поэтому оно опционально.
 */

/** Ошибка криптографической операции с разобранным кодом. */
export class CryptoOperationError extends Error {
  /** HRESULT в виде 0xXXXXXXXX, если удалось определить. */
  readonly code?: string
  /** Что это значит и что делать. */
  readonly hint?: string

  constructor(message: string, code?: string, hint?: string) {
    super(message)
    this.name = 'CryptoOperationError'
    this.code = code
    this.hint = hint
  }
}

/** HRESULT приходит знаковым 32-битным — приводим к беззнаковому hex. */
function toHex(value: number): string {
  const unsigned = value < 0 ? value + 0x1_0000_0000 : value
  return `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * Частые коды. Список намеренно короткий: сюда попадает только то, что
 * встречается реально и на что есть внятный совет.
 */
const KNOWN_CODES: Readonly<Record<string, string>> = {
  '0x8010006E': 'Ввод ПИН отменён. Повторите операцию и введите ПИН токена.',
  '0x8010002C':
    'Не найден считыватель. Токен вынут или занят другим приложением — закройте программы, ' +
    'работающие с токеном, и вставьте его заново.',
  '0x80100069': 'Токен извлечён во время операции. Вставьте его и повторите.',
  '0x8009000D':
    'Нет доступа к закрытому ключу. Обычно это значит, что сертификат не связан с контейнером — ' +
    'установите его в хранилище «Личные».',
  '0x80090016':
    'Контейнер с ключом не найден. Проверьте, что токен вставлен и сертификат установлен из контейнера.',
  '0x800B0101': 'Срок действия сертификата истёк.',
  '0x800B010A':
    'Не удалось построить цепочку до доверенного корневого центра. Установите сертификаты УЦ.',
  '0x800B0109': 'Корневой сертификат цепочки не является доверенным.',
  '0x8007000D': 'Данные повреждены или имеют неверный формат.',
}

interface RawPluginError {
  message?: string
  number?: number
}

function textOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const raw = error as RawPluginError
    if (typeof raw.message === 'string' && raw.message) return raw.message
  }
  return String(error)
}

function codeOf(error: unknown, text: string): string | undefined {
  const raw = error as RawPluginError | null
  if (raw && typeof raw.number === 'number' && raw.number !== 0) return toHex(raw.number)
  const inText = /0x[0-9a-fA-F]{8}/.exec(text)
  return inText ? `0x${inText[0].slice(2).toUpperCase()}` : undefined
}

/**
 * Приводит что угодно, прилетевшее из плагина, к ошибке с кодом и советом.
 * `context` — выполнявшаяся операция, `fallbackHint` — совет, если код
 * незнакомый.
 */
export function toCryptoError(error: unknown, context: string, fallbackHint?: string): CryptoOperationError {
  if (error instanceof CryptoOperationError) return error

  const text = textOf(error)
  const code = codeOf(error, text)
  const withCode = code && !text.includes(code) ? `${text} (${code})` : text
  const hint = (code ? KNOWN_CODES[code] : undefined) ?? fallbackHint

  return new CryptoOperationError(`${context}: ${withCode}`, code, hint)
}
