/**
 * Base64 для двоичных данных.
 *
 * Плагины принимают и отдают двоичные данные строками base64 — подпись,
 * зашифрованный блок, сертификат, — поэтому кодировка входит в поверхность
 * пакета: без неё результатом невозможно пользоваться.
 */

/** Кодирует байты в base64. Кусками, чтобы не упереться в предел аргументов. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Принимает и «голый» base64, и PEM — провайдеры отдают по-разному. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
