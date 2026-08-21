/**
 * Панель 4 — сырой канал к Контур.Плагину.
 *
 * Запрос уходит хосту `kontur.plugin` как есть, мимо средства подписи. Нужен
 * для команд, которых в библиотеке нет и быть не должно: у хоста их несколько
 * десятков, включая работу с файловой системой и запуск процессов, а
 * библиотеке нужны только сертификаты и подпись.
 *
 * Это отладочный инструмент стенда, а не часть маршрута: `KonturProvider` про
 * эту панель не знает и пользуется собственным типизированным транспортом.
 */

import { clear, h, pretty } from '../shell/dom.js'
import { describe, log, timed } from '../shell/log.js'
import { panel } from '../shell/panel.js'
import { KonturBridge, konturHostMarker } from '../kontur/bridge.js'

const SAMPLE = {
  type: 'cert.search',
  filter: { store: { storeType: 'pkcs11', name: 'My', location: 'user' } },
  properties: { subject: true, issuer: true, validFrom: true, validTo: true, hasPrivateKey: true },
}

export function createKonturRawPanel(): HTMLElement {
  const bridge = new KonturBridge()
  const cards = h('div', { class: 'cards' })
  const request = h('textarea', { rows: 6, spellcheck: 'false' })
  request.value = JSON.stringify(SAMPLE, null, 2)
  const output = h('pre', { text: 'Ответов пока не было.' })

  bridge.onTraffic((entry) => {
    const arrow = entry.direction === 'out' ? '→ Контур' : '← Контур'
    log(`${arrow}: ${JSON.stringify(entry.payload).slice(0, 240)}`)
  })

  const probe = async (): Promise<void> => {
    clear(cards)
    log('Проба расширения Контура (extension.info, до нативного хоста не доходит)…')
    const info = await bridge.extensionInfo()

    const rows: Node[] = []
    const add = (label: string, value: string) => rows.push(h('dt', { text: label }), h('dd', { text: value }))
    if (info) {
      add('идентификатор', info.id)
      add('версия', info.version)
      add('тип', info.type)
    }
    add(
      'мета-тег kontur-toolbox-installed',
      konturHostMarker() ? 'есть' : 'нет (его вешают только на доменах Контура)',
    )

    cards.append(
      h(
        'div',
        { class: `card ${info ? 'ok' : 'bad'}` },
        h(
          'h3',
          {},
          'Контур.Плагин',
          h(
            'span',
            { class: `pill ${info ? 'ok' : 'bad'}` },
            info ? 'расширение на месте' : 'расширение не отвечает',
          ),
        ),
        h('dl', {}, ...rows),
        h('p', {
          class: 'note',
          text: info
            ? 'Фон ответил сам. Установлена ли нативная часть — этим не проверяется, для неё нужна любая другая команда.'
            : 'Ответа нет: расширения нет, оно выключено для этого сайта либо изменился протокол.',
        }),
      ),
    )
    log(info ? `Контур: расширение ${info.version}` : 'Контур: расширение не отвечает', info ? 'ok' : 'err')
  }

  const send = async (): Promise<void> => {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(request.value) as Record<string, unknown>
    } catch (error) {
      output.textContent = `Запрос не разобрался как JSON: ${describe(error)}`
      return
    }
    try {
      const response = await timed(`Контур ${String(body.type ?? '?')}`, () => bridge.send(body))
      output.textContent = pretty(response)
    } catch (error) {
      output.textContent = pretty(error)
    }
  }

  return panel(
    '4. Контур.Плагин — сырой канал',
    'Запрос уходит хосту kontur.plugin как есть, мимо средства подписи. Нужен для команд, которых в библиотеке нет.',
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', onclick: () => void probe() }, 'Проверить расширение'),
      h('button', { onclick: () => void send() }, 'Отправить запрос'),
    ),
    cards,
    h('p', { class: 'note', text: 'sessionId и commandId подставляются автоматически.' }),
    request,
    output,
  )
}
