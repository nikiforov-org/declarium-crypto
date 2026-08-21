/**
 * Панель 3 — подпись, проверка, разбор CMS.
 *
 * Сеанс берётся из общего хранилища: панель не знает, кто и каким средством
 * его открыл, ей достаточно интерфейса `Session`.
 *
 * Подпись живёт в отдельном редактируемом поле, а не только в выводе.
 * Проверять и разбирать надо не только что подписанное: подпись приходит с
 * сервера, из файла, от другой стороны.
 */

import { certificatesFromCms, type Session } from '@declarium/crypto'

import { h, pretty } from '../shell/dom.js'
import { log, timed } from '../shell/log.js'
import { panel } from '../shell/panel.js'
import { sessionStore } from '../shell/session.js'

export function createSigningPanel(): HTMLElement {
  const dataInput = h('textarea', { rows: 3 })
  dataInput.value = 'Проверка подписи declarium'

  const sigInput = h('textarea', { rows: 5, spellcheck: 'false', placeholder: 'CMS в base64' })
  const output = h('pre', { text: 'Подписи пока нет.' })

  const signButton = h('button', { class: 'primary' }, 'Подписать')
  const verifyButton = h('button', {}, 'Проверить')
  const parseButton = h('button', {}, 'Разобрать CMS')

  const payload = () => new TextEncoder().encode(dataInput.value)
  const signature = () => sigInput.value.replace(/\s+/g, '')

  let session: Session | null = null

  /** Подпись и проверка требуют сеанса, разбор CMS — нет. */
  const refresh = (): void => {
    const hasSignature = signature().length > 0
    signButton.disabled = !session
    verifyButton.disabled = !session || !hasSignature
    parseButton.disabled = !hasSignature
  }

  sessionStore.subscribe((value) => {
    session = value
    refresh()
  })
  sigInput.addEventListener('input', refresh)

  signButton.addEventListener('click', () => {
    void (async () => {
      if (!session) return
      try {
        const cms = await timed(`Подпись через «${session.providerTitle}»`, () => session!.sign(payload()))
        sigInput.value = cms
        output.textContent = `CMS, base64, ${cms.length} символов.`
      } catch (error) {
        // Ошибку показываем здесь же, а не только в журнале: отменённый ввод
        // ПИН и отсутствующий носитель — самый частый исход, и смотрят сюда
        output.textContent = pretty(error)
      }
      refresh()
    })()
  })

  verifyButton.addEventListener('click', () => {
    void (async () => {
      if (!session) return
      // Проверяются байты из верхнего поля: поменяйте текст после подписи, и
      // ответ обязан стать «не подтверждена» — это тоже полезная проверка
      try {
        const result = await timed('Проверка подписи', () => session!.verify(signature(), payload()))
        output.textContent = pretty(result)
        log(
          result.valid ? 'Подпись подтверждена' : `Подпись не подтверждена: ${result.reason ?? '—'}`,
          result.valid ? 'ok' : 'err',
        )
      } catch (error) {
        output.textContent = pretty(error)
      }
    })()
  })

  parseButton.addEventListener('click', () => {
    // Разбор CMS — чистая работа с байтами. Подпись CAdES-BES несёт сертификат
    // подписанта, поэтому опознать его можно не обращаясь ни к токену, ни к
    // плагину: средство подписи для этого не нужно вовсе
    const certificates = certificatesFromCms(signature())
    if (!certificates.length) {
      output.textContent = 'В CMS не нашлось сертификатов — это не SignedData либо подпись повреждена.'
      log('Разбор CMS: сертификатов нет', 'err')
      return
    }
    output.textContent = pretty(
      certificates.map((certificate, index) => ({
        [index === 0 ? 'подписант' : `цепочка ${index}`]: certificate.subject.commonName,
        издатель: certificate.issuer.commonName,
        серийный: certificate.serialNumber,
        действителен: { с: certificate.notBefore, по: certificate.notAfter },
        ИНН: certificate.subject.innFl ?? certificate.subject.innUl,
        СНИЛС: certificate.subject.snils,
        extendedKeyUsage: certificate.extendedKeyUsage,
      })),
    )
    log(`Разбор CMS: сертификатов ${certificates.length}`, 'ok')
  })

  return panel(
    '3. Подпись и проверка',
    'Открепленная CAdES-BES по байтам из верхнего поля. Подпись можно вставить чужую: проверка работает с любой, а разбор CMS — даже без входа.',
    dataInput,
    h('div', { class: 'row' }, signButton, verifyButton, parseButton),
    sigInput,
    output,
  )
}
