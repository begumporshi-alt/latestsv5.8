/**
 * Synchronous, offline-safe read of the session record auth-js keeps in
 * localStorage.
 *
 * Split out of lib/offline/session.ts deliberately: session.ts imports the
 * Supabase client (supabaseRaw), which is wrapped by read-fallback — so the
 * read fallback cannot import session.ts without an import cycle. This module
 * touches only localStorage, making it safe for the low-level read wrapper.
 */

import { getSupabaseConfig } from '../runtime-config'

export interface StoredSessionUser {
  id: string
  email: string | null
  at: number
}

/**
 * Read the session auth-js still has on disk (offline, the access token may
 * be expired while the session itself is preserved). Handles the chunked
 * storage variant too.
 */
export function readStoredSessionUser(): StoredSessionUser | null {
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

/**
 * True when auth-js still has a session record on disk. False means every
 * outgoing request would leave unauthenticated — PostgREST would answer with
 * an anon-role, RLS-filtered (usually empty) 200, which callers must not
 * mistake for real data.
 */
export function hasStoredSessionUser(): boolean {
  return readStoredSessionUser() !== null
}
