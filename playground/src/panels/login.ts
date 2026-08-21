/**
 * Панель 2 — вход по сертификату.
 *
 * Вызывает `authenticate()` целиком, как это делает продукт: опрос средств →
 * список сертификатов → выбор → сеанс. Результат кладётся в общее хранилище
 * сеанса; о том, кто им дальше воспользуется, панель не знает.
 */

import {
  authenticate,
  NoProviderError,
  type CertificateChoice,
  type ProviderId,
} from '@declarium/crypto'

import { clear, h, pretty } from '../shell/dom.js'
import { log, timed } from '../shell/log.js'
import { panel } from '../shell/panel.js'
import { sessionStore } from '../shell/session.js'

/**
 * Каким средством входить.
 *
 * Обёртка останавливается на первом пригодном, поэтому на машине, где стоят
 * все три, до последнего дело не доходит никогда. Проверить конкретное
 * средство можно только сузив список — этим список и нужен.
 */
const ORDERS: readonly { label: string; order?: readonly ProviderId[] }[] = [
  { label: 'Как в продукте: Рутокен → КриптоПро → Контур' },
  { label: 'Только Рутокен', order: ['rutoken'] },
  { label: 'Только КриптоПро', order: ['cryptopro'] },
  { label: 'Только Контур', order: ['kontur'] },
]

/** Показывает список сертификатов и ждёт выбора — как это делает продукт. */
function askCertificate(area: HTMLElement, list: readonly CertificateChoice[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const box = h('div', { class: 'choice' })

    for (const [index, choice] of list.entries()) {
      const { subject, notAfter, serialNumber } = choice.certificate
      const who = subject.commonName ?? subject.organization ?? '(без CN)'
      const meta = [
        subject.organization && subject.commonName !== subject.organization ? subject.organization : null,
        subject.innUl ?? subject.innFl ? `ИНН ${subject.innUl ?? subject.innFl}` : null,
        `до ${notAfter.toLocaleDateString('ru-RU')}`,
        `№ ${serialNumber.slice(0, 16)}…`,
      ]
        .filter(Boolean)
        .join(' · ')

      box.append(
        h(
          'label',
          {},
          h('input', {
            type: 'radio',
            name: 'cert',
            value: choice.id,
            ...(index === 0 ? { checked: true } : {}),
          }),
          h('span', {}, h('span', { class: 'cn' }, who), h('br'), h('span', { class: 'meta' }, meta)),
        ),
      )
    }

    const confirm = h(
      'button',
      {
        class: 'primary',
        onclick: () => {
          const picked = box.querySelector<HTMLInputElement>('input[name=cert]:checked')
          if (!picked) return
          clear(area)
          log(`Выбран сертификат ${picked.value}`)
          resolve(picked.value)
        },
      },
      'Подписывать этим',
    )

    clear(area)
    area.append(
      h('p', { class: 'note', text: `Найдено сертификатов: ${list.length}` }),
      box,
      h('div', { class: 'row' }, confirm),
    )
  })
}

/** ПИН спрашивает приложение — своего окна у Рутокен Плагина нет. */
function askPin(area: HTMLElement): Promise<string> {
  return new Promise<string>((resolve) => {
    const field = h('input', { type: 'password', placeholder: 'ПИН токена', autocomplete: 'off' })
    const submit = () => {
      const value = field.value
      clear(area)
      resolve(value)
    }

    clear(area)
    area.append(
      h('p', { class: 'note', text: 'Токен просит ПИН — обращение к закрытому ключу.' }),
      h('div', { class: 'row' }, field, h('button', { class: 'primary', onclick: submit }, 'Продолжить')),
    )
    field.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') submit()
    })
    field.focus()
  })
}

export function createLoginPanel(): HTMLElement {
  const area = h('div', {})
  const output = h('pre', { text: 'Вход ещё не выполнялся.' })

  const picker = h('select', {})
  for (const [index, variant] of ORDERS.entries()) {
    picker.append(h('option', { value: String(index) }, variant.label))
  }

  const run = async (): Promise<void> => {
    const variant = ORDERS[Number(picker.value)] ?? ORDERS[0]
    try {
      const session = await timed(`Вход (${variant.label})`, () =>
        authenticate({
          chooseCertificate: (list) => askCertificate(area, list),
          requestPin: () => askPin(area),
          order: variant.order,
        }),
      )
      sessionStore.set(session)
      log(`Вошли через «${session.providerTitle}»`, 'ok')

      const { subject, issuer, serialNumber, notBefore, notAfter, extendedKeyUsage, der } =
        session.certificate
      output.textContent = pretty({
        средство: `${session.provider} · ${session.providerTitle}`,
        сертификат: session.certificateId,
        серийный: serialNumber,
        субъект: subject,
        издатель: issuer,
        действителен: { с: notBefore, по: notAfter },
        extendedKeyUsage,
        der,
      })
    } catch (error) {
      sessionStore.set(null)
      clear(area)
      // NoProviderError несёт разбор по каждому средству — именно его и надо
      // видеть целиком, это то же, что увидит пользователь без плагинов
      output.textContent =
        error instanceof NoProviderError
          ? pretty({ ошибка: error.message, подсказка: error.hint, попытки: error.attempts })
          : pretty(error)
    }
  }

  return panel(
    '2. Вход по сертификату',
    'authenticate() целиком. Сузьте список, чтобы проверить конкретное средство: опрос останавливается на первом пригодном.',
    h('div', { class: 'row' }, picker, h('button', { class: 'primary', onclick: () => void run() }, 'Войти')),
    area,
    output,
  )
}
