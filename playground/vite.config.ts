import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

import { CERT, KEY, ensureCert } from './scripts/make-cert.mjs'

/**
 * Стенд подключает библиотеку ИСХОДНИКАМИ, а не собранным dist: правки в
 * `../src` видно сразу, а в стеке ошибок стоят настоящие файлы. Ради этого
 * приходится разрешить Vite читать каталог выше корня стенда.
 */
const repo = fileURLToPath(new URL('..', import.meta.url))
const source = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url))

/**
 * https, а не http.
 *
 * Расширения средств подписи сверяют источник страницы со своими списками
 * доверенных узлов, и у http и https он разный. Проверять библиотеку надо в
 * тех же условиях, в которых она будет работать на сайте.
 */
const made = ensureCert()
if (made) console.log(`Сертификат стенда выпущен: ${made.how}`)

export default defineConfig({
  resolve: {
    // порядок важен: подпуть должен совпасть раньше корня пакета
    alias: {
      '@declarium/crypto/internals': source('internals.ts'),
      '@declarium/crypto': source('index.ts'),
    },
  },
  // Пакет Актива — CommonJS без поля exports; без явного включения
  // предварительная сборка зависимостей его не находит: он импортируется
  // из файла за пределами корня стенда.
  optimizeDeps: { include: ['@aktivco/rutoken-plugin'] },
  server: {
    port: 5180,
    strictPort: true,
    https: { cert: readFileSync(CERT), key: readFileSync(KEY) },
    fs: { allow: [repo] },
  },
})
