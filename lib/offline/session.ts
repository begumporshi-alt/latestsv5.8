/**
 * Offline session continuity.
 *
 * auth-js keeps the session in localStorage and does NOT sign the user out
 * when a token refresh fails because the network is down (that is a retryable
 * fetch error — GoTrueClient keeps the session and skips _removeSession). But
 * once the access token has actually expired, getSession() resolves
 * `session: null` anyway (GoTrueClient.__loadSession). Without a fallback,
 * every local read — which is namespaced by user id — would return nothing,
 * and the ERP layout would bounce to /login, which needs the internet.
 *
 * So we remember the last successfully signed-in user locally and use it
 * whenever the live session is unavailable. The id only namespaces local,
 * per-user-encrypted data; it grants no server access — syncing after
 * reconnect still requires a real, unexpired token.
 */
import { getMeta, setMeta } from './db'
import { supabaseRaw } from '../supabase-raw'
import { getSupabaseConfig } from '../runtime-config'

export interface LastKnownUser {
  id: string
  email: string | null
  at: number
}

const META_KEY = 'session:last-user'
const REWRITE_INTERVAL_MS = 10 * 60_000

let memory: LastKnownUser | null | undefined
let lastPersistedAt = 0

/** Remember who is signed in (called from every successful session read). */
export async function rememberUser(user: { id: string; email?: string | null }): Promise<void> {
  const next: LastKnownUser = { id: user.id, email: user.email ?? null, at: Date.now() }
  const changed = !memory || memory.id !== next.id
  memory = next
  if (!changed && Date.now() - lastPersistedAt < REWRITE_INTERVAL_MS) return
  lastPersistedAt = Date.now()
  try {
    await setMeta(META_KEY, next)
  } catch {
    // Best-effort: the in-memory value still covers this session.
  }
}

/** Last signed-in user, or null when this browser never signed anyone in. */
export async function getLastUser(): Promise<LastKnownUser | null> {
  if (memory !== undefined) return memory
  try {
    memory = (await getMeta<LastKnownUser>(META_KEY)) ?? readStoredSessionUser()
  } catch {
    memory = readStoredSessionUser()
  }
  return memory
}

/** Cleared on a real sign-out (which also wipes the local database). */
export async function clearLastUser(): Promise<void> {
  memory = null
  lastPersistedAt = Date.now()
  try {
    await setMeta(META_KEY, null)
  } catch {
    // best-effort
  }
}

/**
 * The user id for local data access: the identity the auth library currently
 * has on disk, or the last known user. Reads and the outbox are namespaced
 * with it; it is not proof of a valid server session.
 *
 * Why this does not simply await getSession():
 *
 * getSession() is local *until* the access token expires, at which point it
 * performs a network refresh. Awaiting it here put that refresh in front of
 * every local read — a cold POS open waited on a token round trip before it
 * could look at its own encrypted cache, which is the entire point of having
 * the cache. On a laptop opened the next morning the token is always expired,
 * so the "fast" path was never taken.
 *
 * The stored session in localStorage is the exact record auth-js itself will
 * use, and reading it is synchronous. When it names a user we answer
 * immediately and let the session resolve behind us: the background call still
 * refreshes the token and updates the remembered user for the paths that need
 * a real session (server reads, the outbox drain).
 *
 * With no stored session — first visit, or signed out (which removes the
 * record and wipes the local database) — there is no identity to use, and
 * auth-js is the only source, so we wait for it.
 */
export async function resolveUserId(): Promise<string | null> {
  const stored = readStoredSessionUser()
  if (stored?.id) {
    // Refresh in the background — never awaited. Failures are irrelevant
    // here: local reads do not need a live token, and a genuinely dead
    // session surfaces on the next server call.
    void supabaseRaw.auth
      .getSession()
      .then(({ data }) => {
        const user = data.session?.user
        if (user?.id) void rememberUser({ id: user.id, email: user.email })
      })
      .catch(() => {})
    void rememberUser({ id: stored.id, email: stored.email })
    return stored.id
  }

  try {
    const { data } = await supabaseRaw.auth.getSession()
    const user = data.session?.user
    if (user?.id) {
      void rememberUser({ id: user.id, email: user.email })
      return user.id
    }
  } catch {
    // fall through to the remembered user
  }
  return (await getLastUser())?.id ?? null
}

/**
 * Read the session auth-js still has on disk (offline, the access token may be
 * expired while the session itself is preserved). Handles the chunked storage
 * variant too.
 */
function readStoredSessionUser(): LastKnownUser | null {
  if (typeof window === 'undefined') return null
  try {
    const url = getSupabaseConfig().url
    const ref = new URL(url).hostname.split('.')[0]
    if (!ref) return null
    const key = `sb-${ref}-auth-token`
    let raw = window.localStorage.getItem(key)
    if (!raw) {
      const parts: string[] = []
      for (let i = 0; i < 8; i++) {
        const part = window.localStorage.getItem(`${key}.${i}`)
        if (!part) break
        parts.push(part)
      }
      if (parts.length > 0) raw = parts.join('')
    }
    if (!raw) return null
    const parsed = JSON.parse(raw) as { user?: { id?: string; email?: string | null } }
    const id = parsed?.user?.id
    if (!id) return null
    return { id, email: parsed.user?.email ?? null, at: Date.now() }
  } catch {
    return null
  }
}
