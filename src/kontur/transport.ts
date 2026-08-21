/**
 * Транспорт до расширения «Контур.Плагин».
 *
 * Страница разговаривает с расширением через `window.postMessage`, расширение
 * пересылает запрос нативному хосту `kontur.plugin`. Ни глобальных объектов,
 * ни подключаемых скриптов расширение не предоставляет — отсюда и весь код
 * ниже: это единственный доступный способ.
 *
 * ── Совместимость версий ────────────────────────────────────────────────────
 * У расширения два поколения обёртки. Старое (до 3.2) знает только
 * `kontur-toolbox-request`/`-response`. Новое (3.2+) понимает и его, и пару
 * `kontur-plugin-request`/`-response`, причём на старый запрос отвечает
 * старым же типом. Поэтому запрос отправляется в старой форме — её понимают
 * оба, — а слушаются оба типа ответа.
 *
 * ── Почему на каждый ответ проверяется origin ───────────────────────────────
 * `postMessage` слышно всему, что живёт в окне: другие расширения, вставленные
 * в страницу виджеты, фреймы. Ответ от расширения приходит от собственного
 * источника страницы, всё остальное к делу не относится.
 */

import { CryptoError } from '../types.js'
import type { KonturExtensionInfo, KonturResponse } from './contract.js'

const REQUEST_TYPE = 'kontur-toolbox-request'
const RESPONSE_TYPES = ['kontur-toolbox-response', 'kontur-plugin-response']

/** Сколько ждём фоновую страницу расширения. Она отвечает не выходя наружу. */
const EXTENSION_TIMEOUT_MS = 3_000
/** Сколько ждём нативный хост: он ходит к криптопровайдеру и к токену. */
const HOST_TIMEOUT_MS = 60_000

interface Pending {
  resolve: (response: KonturResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Ответ хоста об ошибке — в исключение с читаемым текстом. */
export class KonturHostError extends CryptoError {
  readonly code?: number

  constructor(context: string, error: { code?: number; message?: string; type?: string }, hint?: string) {
    super(`${context}: ${error.message ?? 'без описания'}`, hint)
    this.name = 'KonturHostError'
    this.code = error.code
  }
}

/**
 * У фона расширения на каждый `sessionId` заводится отдельный порт к хосту, а
 * порт держит состояние — введённый ПИН в том числе. Поэтому идентификатор
 * один на всё время жизни транспорта, а не на запрос.
 */
function newSessionId(): string {
  // Небезопасный источник (страница по http не в localhost) остаётся без
  // crypto.randomUUID — идентификатор здесь не секрет, годится любой
  return globalThis.crypto?.randomUUID?.() ?? `kontur-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export class KonturTransport {
  private readonly sessionId = newSessionId()
  private readonly pending = new Map<number, Pending>()
  private commandId = 0
  private listening = false

  private listen(): void {
    if (this.listening) return
    this.listening = true

    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      const data = event.data as { type?: string; response?: KonturResponse } | null
      if (!data || typeof data.type !== 'string' || !RESPONSE_TYPES.includes(data.type)) return

      const response = data.response
      if (!response || response.sessionId !== this.sessionId) return

      if (typeof response.commandId === 'number') {
        this.settle(response.commandId, response)
        return
      }
      // Ответ без commandId относится ко всему сеансу: так приходит обрыв
      // порта и падение нативного хоста. Ждать больше нечего ни одному запросу
      for (const id of [...this.pending.keys()]) this.settle(id, response)
    })
  }

  private settle(commandId: number, response: KonturResponse): void {
    const waiting = this.pending.get(commandId)
    if (!waiting) return
    this.pending.delete(commandId)
    clearTimeout(waiting.timer)
    waiting.resolve(response)
  }

  /** Отправляет запрос и ждёт ответ. Ошибку хоста не разворачивает. */
  private exchange(request: Record<string, unknown>, timeoutMs: number): Promise<KonturResponse> {
    this.listen()
    const commandId = ++this.commandId
    const payload = { ...request, sessionId: this.sessionId, commandId }

    return new Promise<KonturResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        reject(new Error(`Контур.Плагин не ответил за ${Math.round(timeoutMs / 1000)} с`))
      }, timeoutMs)

      this.pending.set(commandId, { resolve, reject, timer })
      window.postMessage({ type: REQUEST_TYPE, request: payload }, window.location.origin)
    })
  }

  /**
   * Выполняет команду. Ошибку хоста поднимает исключением, чтобы вызывающему
   * коду не приходилось разбирать два вида неудачи.
   */
  async command<T>(
    type: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number; context?: string; hint?: string } = {},
  ): Promise<T> {
    const response = await this.exchange({ type, ...params }, options.timeoutMs ?? HOST_TIMEOUT_MS)
    if (response.error) {
      throw new KonturHostError(options.context ?? `Команда ${type} не выполнена`, response.error, options.hint)
    }
    return response.result as T
  }

  /**
   * Есть ли расширение в браузере.
   *
   * `extension.info` обслуживает фоновая страница, до нативного хоста запрос
   * не доходит. Это единственная проба, которая отличает «расширения нет» от
   * «расширение есть, а Контур.Плагин не установлен»: всё остальное уходит
   * наружу и на машине без плагина одинаково молчит.
   */
  async extensionInfo(): Promise<KonturExtensionInfo | null> {
    try {
      return await this.command<KonturExtensionInfo>(
        'extension.info',
        {},
        { timeoutMs: EXTENSION_TIMEOUT_MS },
      )
    } catch {
      return null
    }
  }

  /** Закрывает порт к нативному хосту. Сеанс после этого начинается заново. */
  close(): void {
    if (!this.listening) return
    void this.exchange({ type: 'extension.close' }, EXTENSION_TIMEOUT_MS).catch(() => {})
  }
}
