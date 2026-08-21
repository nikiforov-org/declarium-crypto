/**
 * Сертификат для стенда.
 *
 * Стенд обязан работать по https, а не только по http://localhost. Причины
 * две. Расширения средств подписи ведут списки доверенных узлов и сверяют их с
 * источником страницы, а он у http и https разный. И проверять библиотеку надо
 * в тех же условиях, в которых она будет жить на сайте, — иначе на боевом
 * домене вылезет то, чего на стенде не было.
 *
 * Ключ и сертификат не попадают в репозиторий: закрытому ключу там не место,
 * даже отладочному. Скрипт идемпотентен и вызывается перед запуском стенда.
 *
 * ── Чем выпускаем ───────────────────────────────────────────────────────────
 * Если в системе есть mkcert с установленным локальным УЦ — берём его:
 * браузер такому сертификату верит молча. Иначе openssl и самоподписанный, с
 * предупреждением в браузере, которое придётся один раз проскочить.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(root, 'certs')
export const CERT = join(dir, 'dev-cert.pem')
export const KEY = join(dir, 'dev-key.pem')

/** Дополнительные имена задаются через DEV_CERT_HOSTS, через запятую. */
function hosts() {
  const extra = (process.env.DEV_CERT_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
  return ['localhost', '127.0.0.1', '::1', ...extra]
}

function has(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Локальный УЦ mkcert должен быть не только создан, но и внесён в доверие. */
function mkcertReady() {
  if (!has('mkcert')) return false
  try {
    const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim()
    return existsSync(join(caRoot, 'rootCA.pem'))
  } catch {
    return false
  }
}

function withMkcert(names) {
  execFileSync('mkcert', ['-cert-file', CERT, '-key-file', KEY, ...names], { stdio: 'inherit' })
  return 'mkcert (браузер доверяет молча)'
}

function withOpenssl(names) {
  const san = names
    .map((name) => (/^[\d.]+$|:/.test(name) ? `IP:${name}` : `DNS:${name}`))
    .join(',')
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256',
      // 825 дней — предел, после которого сертификату не верит macOS
      '-days', '825', '-nodes',
      '-keyout', KEY, '-out', CERT,
      '-subj', '/CN=localhost',
      '-addext', `subjectAltName=${san}`,
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  return 'openssl, самоподписанный (браузер предупредит один раз)'
}

export function ensureCert({ force = false } = {}) {
  if (force) rmSync(dir, { recursive: true, force: true })
  if (existsSync(CERT) && existsSync(KEY)) return null

  mkdirSync(dir, { recursive: true })

  const names = hosts()
  const how = mkcertReady() ? withMkcert(names) : withOpenssl(names)
  return { how, names }
}

// Запуск напрямую: node scripts/make-cert.mjs [--force]
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const made = ensureCert({ force: process.argv.includes('--force') })
  console.log(
    made
      ? `Сертификат стенда выпущен: ${made.how}\n  имена: ${made.names.join(', ')}`
      : 'Сертификат стенда уже есть. Перевыпуск: npm run cert',
  )
}
