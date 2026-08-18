/**
 * Разбор различительного имени (DN) сертификата.
 *
 * Общий для обоих провайдеров, и не ради экономии строк: они отдают одно и то
 * же имя по-разному, и без единого места разбора расхождение всплывает в
 * интерфейсе — как «cn», в который попал весь DN целиком.
 *
 * ── Что отдаёт КриптоПро ────────────────────────────────────────────────────
 * X.500 в кавычной форме, короткие имена атрибутов, кириллические ключи:
 *
 *   SN=ИВАНОВ, CN="ООО ""РОМАШКА""", STREET="УЛ., Д. 29", ИНН=770000000000
 *
 * Значение с запятой или кавычкой заворачивается в двойные кавычки, а
 * внутренняя кавычка удваивается. Разбор по запятым такое рвёт: имя
 * показывается вместе с кавычками, адрес режется по первой внутренней запятой.
 *
 * ── Что отдаёт Рутокен ──────────────────────────────────────────────────────
 * Те же поля, но длинными именами и без кавычек:
 *
 *   commonName=ИВАНОВ ИВАН ИВАНОВИЧ, INN=770000000000, OGRNIP=…
 *
 * Поэтому поиск идёт по набору синонимов, а не по одному ключу.
 */

/** ИНН физического лица. */
const OID_INN_FL = '1.2.643.3.131.1.1'
/** ИНН юридического лица — в сертификатах руководителей. */
const OID_INN_UL = '1.2.643.100.4'

const CN_KEYS = ['CN', 'commonName', '2.5.4.3']
const INN_FL_KEYS = ['ИНН', 'INN', OID_INN_FL, `OID.${OID_INN_FL}`]
const INN_UL_KEYS = ['ИНН ЮЛ', 'INNLE', OID_INN_UL, `OID.${OID_INN_UL}`]

/**
 * Разбирает DN в пары «ключ → значение». При повторе ключа побеждает первое
 * вхождение: так же ведут себя штатные средства просмотра сертификата.
 */
export function parseRdn(dn: string): Map<string, string> {
  const values = new Map<string, string>()
  let at = 0

  while (at < dn.length) {
    const equals = dn.indexOf('=', at)
    if (equals < 0) break

    const key = dn.slice(at, equals).trim()
    at = equals + 1
    let value: string

    if (dn[at] === '"') {
      at++
      let quoted = ''
      while (at < dn.length) {
        if (dn[at] !== '"') {
          quoted += dn[at++]
          continue
        }
        if (dn[at + 1] === '"') {
          // удвоенная кавычка внутри значения — это одна кавычка
          quoted += '"'
          at += 2
          continue
        }
        at++
        break
      }
      value = quoted
    } else {
      const comma = dn.indexOf(',', at)
      const end = comma < 0 ? dn.length : comma
      value = dn.slice(at, end)
      at = end
    }

    if (key && !values.has(key)) values.set(key, value.trim())

    const comma = dn.indexOf(',', at)
    at = comma < 0 ? dn.length : comma + 1
  }

  return values
}

function first(values: Map<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = values.get(key)
    if (value) return value
  }
  return undefined
}

/** Общее имя. Если его нет, отдаём DN целиком — пустая строка хуже. */
export function commonName(dn: string): string {
  return first(parseRdn(dn), CN_KEYS) ?? dn
}

/**
 * ИНН из сертификата: сначала личный, потом ИНН юрлица. Сертификат
 * руководителя несёт оба, и какой из них пойдёт в декларацию, решает форма,
 * а не разбор строки.
 */
export function innFrom(dn: string): string | undefined {
  const values = parseRdn(dn)
  const raw = first(values, INN_FL_KEYS) ?? first(values, INN_UL_KEYS)
  return raw?.replace(/\D/g, '') || undefined
}
