/**
 * Сырой мост к расширению «Контур.Плагин» — инструмент разведки.
 *
 * Здесь нарочно нет никакой типизации команд: протокол нативного хоста
 * `kontur.plugin` нигде не опубликован, и стенд нужен как раз для того, чтобы
 * его нащупать. Типизированный провайдер появится в библиотеке отдельно,
 * когда словарь команд будет известен.
 *
 * ── Что удалось снять с самого расширения (v3.1.11, MV3) ────────────────────
 * `content.js` внедряется на все страницы без разбора — в манифесте стоит
 * маска на любую схему, любой хост и любой путь, `all_frames` и
 * `document_start`. Он пересылает в фон любой postMessage вида
 * `{ type: 'kontur-toolbox-request', request }`, дописывая к запросу
 * `hostUri = event.origin`. Проверка «сайт принадлежит Контуру» стоит ровно
 * на двух вещах: мета-тег `kontur-toolbox-installed` и команда
 * `extension.uninstall`. Всё остальное уходит в фон с любого домена.
 *
 * `background.js` держит по порту на sessionId, три команды обслуживает сам —
 * `extension.info`, `extension.close`, `extension.uninstall` — а прочее
 * отправляет в нативный хост `kontur.plugin`. Ответ приходит как
 * `{ type: 'kontur-toolbox-response', response }`, где response —
 * `{ sessionId, commandId, result?, error? }`. Длинные ответы хост режет на
 * куски, но склеивает их фон: странице всегда достаётся целый JSON.
 *
 * Отсюда важное следствие: `extension.info` отвечает, даже когда нативная
 * часть не установлена — он не доходит до хоста. Это единственная проба,
 * которая различает «расширения нет» и «расширение есть, плагина нет».
 */

const REQUEST_TYPE = 'kontur-toolbox-request'
const RESPONSE_TYPE = 'kontur-toolbox-response'

export interface KonturResponse {
  sessionId?: string
  commandId?: number
  result?: unknown
  error?: { type?: string; message?: string; [key: string]: unknown }
}

export interface KonturExtensionInfo {
  id: string
  type: string
  version: string
}

/** Направление записи в журнале обмена. */
export interface KonturTraffic {
  direction: 'out' | 'in'
  at: number
  payload: unknown
}

type Pending = {
  resolve: (response: KonturResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class KonturBridge {
  /** Фон заводит отдельный порт на каждый sessionId — держим один на стенд. */
  readonly sessionId = crypto.randomUUID()

  private commandId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(entry: KonturTraffic) => void>()
  private started = false

  /** Подписка на весь обмен — журнал стенда показывает и запросы, и ответы. */
  onTraffic(listener: (entry: KonturTraffic) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private trace(direction: 'out' | 'in', payload: unknown): void {
    const entry: KonturTraffic = { direction, at: Date.now(), payload }
    for (const listener of this.listeners) listener(entry)
  }

  private start(): void {
    if (this.started) return
    this.started = true
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; response?: KonturResponse } | null
      if (event.source !== window || !data || data.type !== RESPONSE_TYPE) return
      const response = data.response ?? {}
      this.trace('in', response)

      if (typeof response.commandId === 'number') {
        this.settle(response.commandId, response)
        return
      }
      // Обрыв порта и падение хоста приходят без commandId, на весь сеанс —
      // тогда отвечать нечем ни одному ожидающему запросу
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

  /**
   * Отправляет запрос как есть. `sessionId` и `commandId` проставляются здесь:
   * без первого расширение молча игнорирует сообщение, без второго ответ
   * невозможно сопоставить с запросом.
   */
  send(request: Record<string, unknown>, timeoutMs = 15_000): Promise<KonturResponse> {
    this.start()
    const commandId = ++this.commandId
    const payload = { ...request, sessionId: this.sessionId, commandId }

    return new Promise<KonturResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId)
        reject(
          new Error(
            `Контур не ответил за ${Math.round(timeoutMs / 1000)} с. ` +
              'Если молчит даже extension.info — расширения нет или оно выключено для этого сайта.',
          ),
        )
      }, timeoutMs)

      this.pending.set(commandId, { resolve, reject, timer })
      this.trace('out', payload)
      window.postMessage({ type: REQUEST_TYPE, request: payload }, '*')
    })
  }

  /**
   * Есть ли расширение. Отвечает фон, нативный хост не участвует, поэтому
   * срок ожидания короткий: живое расширение отвечает мгновенно.
   */
  async extensionInfo(timeoutMs = 3_000): Promise<KonturExtensionInfo | null> {
    try {
      const response = await this.send({ type: 'extension.info' }, timeoutMs)
      return (response.result as KonturExtensionInfo | undefined) ?? null
    } catch {
      return null
    }
  }
}

/** Мета-тег, который расширение вешает только на страницах Контура. */
export function konturHostMarker(): boolean {
  return !!document.querySelector('meta[kontur-toolbox-installed]')
}
