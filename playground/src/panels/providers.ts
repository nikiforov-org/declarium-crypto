/**
 * Панель 1 — средства подписи по отдельности.
 *
 * Вызывает `detect()` у каждого средства напрямую, минуя `authenticate()`.
 * Смысл в том, что обёртка останавливается на первом пригодном и про
 * остальные не рассказывает ничего; здесь видно все три сразу и целиком.
 */

import {
  CryptoProProvider,
  KonturProvider,
  RutokenProvider,
  type CryptoProvider,
  type ProviderStatus,
} from '@declarium/crypto/internals'

import { clear, h } from '../shell/dom.js'
import { timed } from '../shell/log.js'
import { panel } from '../shell/panel.js'

/**
 * Порядок тот же, что в обёртке по умолчанию, но смысла «первый пригодный»
 * здесь нет: опрашиваются все.
 */
function allProviders(): CryptoProvider[] {
  return [new RutokenProvider(), new CryptoProProvider(), new KonturProvider()]
}

function statusCard(provider: CryptoProvider, status: ProviderStatus, ms: number): HTMLElement {
  const rows: Node[] = []
  const add = (label: string, value?: string) => {
    if (value) rows.push(h('dt', { text: label }), h('dd', { text: value }))
  }

  add('версия', status.version)
  add('CSP', status.cspVersion)
  add('расширение', status.extension)
  add('причина', status.reason)
  add('что делать', status.hint)
  add('время', `${Math.round(ms)} мс`)

  return h(
    'div',
    { class: `card ${status.available ? 'ok' : 'bad'}` },
    h(
      'h3',
      {},
      provider.title,
      h(
        'span',
        { class: `pill ${status.available ? 'ok' : 'bad'}` },
        status.available ? 'доступен' : 'недоступен',
      ),
      h('span', { class: 'pill' }, provider.requiresPin ? 'нужен ПИН' : 'ПИН у средства'),
    ),
    h('dl', {}, ...rows),
  )
}

export function createProvidersPanel(): HTMLElement {
  const cards = h('div', { class: 'cards' })

  const run = async (): Promise<void> => {
    clear(cards)
    // По очереди, а не Promise.all: нативные плагины, поднятые одновременно,
    // мешают друг другу за доступ к токену и к считывателю
    for (const provider of allProviders()) {
      const started = performance.now()
      try {
        const status = await timed(`Опрос «${provider.title}»`, () => provider.detect())
        cards.append(statusCard(provider, status, performance.now() - started))
      } catch (error) {
        // detect() по контракту не бросает, но средство — чужой нативный код
        cards.append(
          statusCard(provider, { available: false, reason: String(error) }, performance.now() - started),
        )
      }
    }
  }

  return panel(
    '1. Средства подписи',
    'Прямой вызов detect() у каждого средства — то же, что делает вход, но по отдельности и с полным ответом.',
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => void run() }, 'Опрос')),
    cards,
  )
}
