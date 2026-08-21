/** Минимум для сборки разметки без фреймворка. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'class') {
      node.className = String(value)
    } else if (key === 'text') {
      node.textContent = String(value)
    } else {
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: Element): void {
  node.replaceChildren()
}

/**
 * JSON для показа. Uint8Array и Map в JSON.stringify превращаются в мусор
 * («{"0":48,...}» и «{}»), а на стенде смотрят именно на них.
 */
export function pretty(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val: unknown) => {
      if (val instanceof Uint8Array) return `Uint8Array(${val.length}) ${hex(val.slice(0, 24))}${val.length > 24 ? '…' : ''}`
      if (val instanceof Map) return Object.fromEntries(val)
      if (val instanceof Error) return { name: val.name, message: val.message, ...extra(val) }
      if (val instanceof Date) return val.toISOString()
      return val
    },
    2,
  )
}

function extra(error: Error): Record<string, unknown> {
  const known = ['hint', 'code', 'stage', 'attempts']
  const result: Record<string, unknown> = {}
  for (const key of known) {
    const value = (error as unknown as Record<string, unknown>)[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
}
