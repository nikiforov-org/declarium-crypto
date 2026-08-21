/**
 * Текущий сеанс — единственное состояние, общее для панелей.
 *
 * Панели друг о друге не знают: вход не дёргает подпись, подпись не лезет в
 * потроха входа. Связывает их только это хранилище — вход кладёт сюда сеанс,
 * подпись на него подписывается. Появится ещё панель, которой нужен сеанс, —
 * она подпишется тем же способом, и трогать существующие не придётся.
 */

import type { Session } from '@declarium/crypto'

type Listener = (session: Session | null) => void

let current: Session | null = null
const listeners = new Set<Listener>()

export const sessionStore = {
  get current(): Session | null {
    return current
  },

  set(session: Session | null): void {
    current = session
    for (const listener of listeners) listener(current)
  },

  /** Слушатель получает текущее значение сразу при подписке. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    listener(current)
    return () => listeners.delete(listener)
  },
}
