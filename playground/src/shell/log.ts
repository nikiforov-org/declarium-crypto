/**
 * Журнал стенда.
 *
 * Общая служба: ею пользуются все панели, но она не знает ни об одной из них.
 * Наружу отдаёт элемент, а во что его завернуть — решает сборка страницы.
 */

import { h } from './dom.js'

export const logBody = h('pre', { class: 'log' })

export type LogLevel = 'info' | 'ok' | 'err'

export function log(message: string, level: LogLevel = 'info'): void {
  const time = new Date().toTimeString().slice(0, 8)
  logBody.append(
    h('div', {}, h('span', { class: 't' }, `${time}  `), h('span', { class: `lvl-${level}` }, message)),
  )
  logBody.scrollTop = logBody.scrollHeight
}

/** Ошибки библиотеки несут `hint` — без него текст ошибки половинчатый. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    const hint = (error as { hint?: string }).hint
    return hint ? `${error.message} — ${hint}` : error.message
  }
  return String(error)
}

/** Выполняет работу, записывая в журнал начало, исход и время. */
export async function timed<T>(what: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  log(`${what}…`)
  try {
    const result = await work()
    log(`${what}: готово за ${Math.round(performance.now() - started)} мс`, 'ok')
    return result
  } catch (error) {
    log(`${what}: ${describe(error)}`, 'err')
    throw error
  }
}
