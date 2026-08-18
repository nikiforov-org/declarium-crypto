/**
 * Загрузка КриптоПро ЭЦП Browser plug-in — своя реализация.
 *
 * ── Почему не официальный cadesplugin_api.js ────────────────────────────────
 * В нём 942 строки, из которых 451 — пути, которыми современный браузер не
 * ходит: NPAPI, Internet Explorer, синхронный CreateObject, таблица из
 * трёхсот констант, генераторные хелперы. Он же вставляет в чужую страницу
 * полноэкранный оверлей со ссылкой на .xpi для Firefox и объявляет глобалы,
 * которые потом невозможно типизировать.
 *
 * Версия из npm (`crypto-pro-cadesplugin`, JSModuleVersion 2.1.1) вдобавок
 * отстала: её `load_extension` знает только два расширения, без Manifest V3.
 * И подключает их параллельно двумя тегами сразу — отсюда счётчик
 * `failed_extensions < 2`, который отклоняет промис на второй неудаче.
 * В официальной 2.4.5 схема другая: расширения пробуются по очереди с
 * откатом, и счётчик оттуда убран.
 *
 * ── Что здесь не переписывается ─────────────────────────────────────────────
 * Мост к нативному хосту живёт в `nmcades_plugin_api.js` ВНУТРИ расширения и
 * создаёт глобал `cpcsp_chrome_nmcades`. Подменить его нельзя — странице
 * остаётся лишь предоставить расширению то, чего оно ожидает.
 *
 * ── Контракт (снят с nmcades_plugin_api.js 1.3.17) ──────────────────────────
 * Расширение обращается к `window.cadesplugin` за:
 *   · async_spawn(genFn, ...args) — гоняет генератор по промисам. Аргументы
 *     приходят в генератор ОДНИМ МАССИВОМ: внутри расширения это `args[0]`
 *     и `args[1]`. Другая сигнатура его ломает;
 *   · set(pluginObject)          — так оно передаёт объект плагина;
 *   · current_log_level и LOG_LEVEL_DEBUG / INFO / ERROR;
 *   · EnableInternalCSP          — читается, необязательное.
 *
 * Последовательность: подключить скрипт расширения → послать
 * postMessage('cadesplugin_echo_request') → дождаться 'cadesplugin_loaded' →
 * вызвать cpcsp_chrome_nmcades.check_chrome_plugin(onOk, onError).
 *
 * Контракт недокументирован, поэтому при обновлении расширения его стоит
 * сверять с официальным загрузчиком КриптоПро.
 */

import type { CadesObjectMap, CadesObjectName, CadesPlugin, CadesPluginObject } from './contract.js'

/** Расширение браузера, обслуживающее плагин. */
export interface CadesExtension {
  readonly id: string
  readonly title: string
}

/**
 * Идентификаторы взяты из `allowed_origins` манифеста нативного хоста
 * `ru.cryptopro.nmcades.json`. Порядок — от нового к старому: на свежей
 * машине первая же попытка попадает в цель.
 */
export const KNOWN_EXTENSIONS: readonly CadesExtension[] = [
  { id: 'pfhgbfnnjiafkhfdkmpiflachepdcjod', title: 'Extension for CAdES Browser Plugin (Manifest V3)' },
  { id: 'iifchhfnnmpdbibifmljnfjhpififfog', title: 'CryptoPro Extension for CAdES (Manifest V2)' },
  { id: 'epebfcehmdedogndhlcacafjaacknbcm', title: 'расширение для Opera' },
] as const

const LogLevel = { Error: 1, Info: 2, Debug: 4 } as const

/** Шаг, на котором остановилась загрузка. По нему строится совет пользователю. */
export type CadesLoadStage = 'extension' | 'handshake' | 'bridge' | 'plugin'

export class CadesLoadError extends Error {
  readonly stage: CadesLoadStage
  readonly hint: string

  constructor(stage: CadesLoadStage, message: string, hint: string) {
    super(message)
    this.name = 'CadesLoadError'
    this.stage = stage
    this.hint = hint
  }
}

/** Глобал, который расширение ожидает найти на странице. */
interface CadesGlobal {
  async_spawn(generator: (args: readonly unknown[]) => Generator, ...args: unknown[]): unknown
  set(plugin: CadesPluginObject): void
  current_log_level: number
  LOG_LEVEL_ERROR: number
  LOG_LEVEL_INFO: number
  LOG_LEVEL_DEBUG: number
  EnableInternalCSP?: boolean
}

/** Мост, который создаёт скрипт расширения. */
interface CpcspBridge {
  check_chrome_plugin(onLoaded: () => void, onError: (reason?: string) => void): void
}

declare global {
  interface Window {
    cadesplugin?: CadesGlobal
    cpcsp_chrome_nmcades?: CpcspBridge
  }
}

/**
 * Повторяет `async_spawn` вендора: генератор получает аргументы одним
 * массивом, каждое `yield` разворачивается как промис. Расширение внутри
 * себя обращается к `args[0]` и `args[1]`, поэтому сигнатура обязана
 * совпадать буквально.
 */
function asyncSpawn(generator: (args: readonly unknown[]) => Generator, ...args: unknown[]): unknown {
  const iterator = generator(args)

  const step = (verb: 'next' | 'throw', value?: unknown): unknown => {
    let result: IteratorResult<unknown>
    try {
      result = iterator[verb](value as never)
    } catch (error) {
      return Promise.reject(error)
    }
    return result.done
      ? result.value
      : Promise.resolve(result.value).then(
          (v) => step('next', v),
          (e) => step('throw', e),
        )
  }

  return step('next')
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`скрипт не загрузился: ${src}`))
    document.head.appendChild(script)
  })
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Скрипт расширения отвечает на echo-запрос сообщением `cadesplugin_loaded`.
 * Срок ожидания навешивается снаружи через withTimeout.
 */
function handshake(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string' || !event.data.includes('cadesplugin_loaded')) return
      window.removeEventListener('message', onMessage)
      resolve()
    }
    window.addEventListener('message', onMessage, false)
    window.postMessage('cadesplugin_echo_request', '*')
  })
}

export interface CadesLoadResult {
  readonly plugin: CadesPlugin
  readonly extension: CadesExtension
  /** Расширения, которые пробовали до успешного. Полезно в диагностике. */
  readonly skipped: readonly string[]
}

let cached: Promise<CadesLoadResult> | null = null

/**
 * Загружает плагин. Повторные вызовы отдают тот же результат: скрипт
 * расширения подключается один раз за жизнь страницы. После неудачи кэш
 * сбрасывается, чтобы можно было повторить, установив расширение.
 */
export function loadCadesPlugin(timeoutMs = 20_000): Promise<CadesLoadResult> {
  cached ??= connect(timeoutMs).catch((error: unknown) => {
    cached = null
    throw error
  })
  return cached
}

async function connect(timeoutMs: number): Promise<CadesLoadResult> {
  let received: CadesPluginObject | null = null

  // Глобал должен существовать ДО загрузки скрипта расширения: оно
  // обращается к нему сразу, ещё в процессе инициализации.
  const api: CadesGlobal = {
    async_spawn: asyncSpawn,
    set: (plugin) => {
      received = plugin
    },
    current_log_level: LogLevel.Error,
    LOG_LEVEL_ERROR: LogLevel.Error,
    LOG_LEVEL_INFO: LogLevel.Info,
    LOG_LEVEL_DEBUG: LogLevel.Debug,
  }
  window.cadesplugin = Object.assign(window.cadesplugin ?? {}, api)

  // 1. подключаем скрипт расширения — по очереди, до первого удачного
  const skipped: string[] = []
  let extension: CadesExtension | undefined
  for (const candidate of KNOWN_EXTENSIONS) {
    try {
      await loadScript(`chrome-extension://${candidate.id}/nmcades_plugin_api.js`)
      extension = candidate
      break
    } catch {
      skipped.push(candidate.id)
    }
  }

  if (!extension) {
    throw new CadesLoadError(
      'extension',
      'Расширение КриптоПро в браузере не найдено',
      'Проверены все известные идентификаторы. Установите «Extension for CAdES Browser Plugin» ' +
        'и перезагрузите страницу: одних КриптоПро CSP и плагина недостаточно.',
    )
  }

  // 2. рукопожатие
  try {
    await withTimeout(handshake(), timeoutMs, 'расширение не ответило на cadesplugin_echo_request')
  } catch (error) {
    throw new CadesLoadError(
      'handshake',
      `Расширение «${extension.title}» подключилось, но молчит`,
      `${(error as Error).message}. Убедитесь, что расширение включено для этого сайта, и перезагрузите страницу.`,
    )
  }

  // 3. мост к нативному хосту
  const bridge = window.cpcsp_chrome_nmcades
  if (typeof bridge?.check_chrome_plugin !== 'function') {
    throw new CadesLoadError(
      'bridge',
      'Расширение не создало мост cpcsp_chrome_nmcades',
      'Версия расширения разошлась с ожидаемым контрактом. Обновите КриптоПро ЭЦП Browser plug-in.',
    )
  }

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        // «Плагин недоступен» — дословный текст из nmcades_plugin_api.js
        bridge.check_chrome_plugin(resolve, (reason) => reject(new Error(reason || 'Плагин недоступен')))
      }),
      timeoutMs,
      'плагин не ответил вовремя',
    )
  } catch (error) {
    throw new CadesLoadError(
      'plugin',
      (error as Error).message,
      'Расширение на месте и отвечает, а до КриптоПро CSP достучаться не вышло. Проверьте, что ' +
        'установлен сам ЭЦП Browser plug-in и что CSP работает: /opt/cprocsp/bin/certmgr -list',
    )
  }

  const plugin: CadesPluginObject | null = received
  if (!plugin) {
    throw new CadesLoadError(
      'plugin',
      'Плагин загрузился, но не передал объект через cadesplugin.set',
      'Контракт с расширением изменился. Обновите КриптоПро ЭЦП Browser plug-in.',
    )
  }

  return { plugin: wrap(plugin), extension, skipped }
}

/** Оборачивает нетипизированный объект плагина в типобезопасный фасад. */
function wrap(plugin: CadesPluginObject): CadesPlugin {
  return {
    createObject: <K extends CadesObjectName>(name: K) =>
      plugin.CreateObjectAsync(name) as Promise<CadesObjectMap[K]>,
    getLastError: () => {
      try {
        return plugin.getLastError?.()
      } catch {
        return undefined
      }
    },
  }
}
