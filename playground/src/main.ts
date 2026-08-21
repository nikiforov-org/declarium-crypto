/**
 * Стенд для @declarium/crypto — сборка страницы.
 *
 * Здесь только порядок панелей. Каждая панель — отдельный модуль в `panels/`,
 * отвечающий за свою задачу целиком; панели не знают друг о друге, а общее у
 * них ровно одно — текущий сеанс в `shell/session.ts`. Так же устроена и сама
 * библиотека: сабмодуль на средство подписи, обёртка сверху.
 *
 * Библиотека подключена исходниками (см. alias в vite.config.ts), поэтому в
 * стеке ошибок стоят настоящие файлы из ../src.
 */

import './styles.css'

import { createKonturRawPanel } from './panels/kontur-raw.js'
import { createLoginPanel } from './panels/login.js'
import { createProvidersPanel } from './panels/providers.js'
import { createSigningPanel } from './panels/signing.js'
import { log, logBody } from './shell/log.js'
import { panel } from './shell/panel.js'

const app = document.querySelector<HTMLElement>('#app')

if (!app) throw new Error('Разметка стенда не содержит #app')

app.append(
  createProvidersPanel(),
  createLoginPanel(),
  createSigningPanel(),
  createKonturRawPanel(),
  panel('Журнал', 'Все вызовы со временем выполнения.', logBody),
)

log(`Стенд готов. Источник: ${location.origin}`)
