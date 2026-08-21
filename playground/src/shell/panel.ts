/** Каркас панели стенда. Ничего, кроме разметки. */

import { h } from './dom.js'

export function panel(title: string, note: string, ...body: (Node | string)[]): HTMLElement {
  return h('section', {}, h('h2', {}, title), h('p', { class: 'note' }, note), ...body)
}
