/**
 * Hermes gateway session continuity header helpers.
 *
 * Contract (deterministic, tested):
 * - Accept only non-empty strings
 * - Max length HERMES_SESSION_ID_MAX (inclusive)
 * - Reject CR/LF/NUL and other C0 controls
 * - Allow only a conservative charset safe in HTTP headers:
 *   A–Z a–z 0–9 . _ : @ / -
 *   (covers project-store chatId = sha256 hex and unsaved-* ids)
 * - On any violation: return undefined (caller omits the header)
 *
 * Never trust Fetch to strip bad header values — validate before set.
 */

export const HERMES_SESSION_ID_MAX = 128
export const HERMES_SESSION_ID_HEADER = 'X-Hermes-Session-Id'

const SAFE_SESSION_ID = /^[A-Za-z0-9._:@/-]+$/

/**
 * Validate a candidate thread/session id for X-Hermes-Session-Id.
 * Returns the trimmed value when safe; otherwise undefined (omit header).
 */
export function sanitizeHermesSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > HERMES_SESSION_ID_MAX) return undefined
  // Explicit control-char reject (including CR/LF/NUL) before charset check
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return undefined
  }
  if (!SAFE_SESSION_ID.test(trimmed)) return undefined
  return trimmed
}
