import { describe, expect, it } from 'vitest'
import {
  HERMES_SESSION_ID_MAX,
  sanitizeHermesSessionId,
} from '../src/hermes-session'

describe('sanitizeHermesSessionId', () => {
  it('accepts safe chat-like ids (hex, unsaved-*, path-ish tokens)', () => {
    expect(sanitizeHermesSessionId('abcdef0123456789')).toBe('abcdef0123456789')
    expect(sanitizeHermesSessionId('unsaved-abc')).toBe('unsaved-abc')
    expect(sanitizeHermesSessionId('doc:chat/1')).toBe('doc:chat/1')
    expect(sanitizeHermesSessionId('  padded  ')).toBe('padded')
  })

  it('rejects empty, non-string, overlong, CR/LF/NUL, and charset violations', () => {
    expect(sanitizeHermesSessionId(undefined)).toBeUndefined()
    expect(sanitizeHermesSessionId(null)).toBeUndefined()
    expect(sanitizeHermesSessionId(42)).toBeUndefined()
    expect(sanitizeHermesSessionId('')).toBeUndefined()
    expect(sanitizeHermesSessionId('   ')).toBeUndefined()
    expect(sanitizeHermesSessionId('a'.repeat(HERMES_SESSION_ID_MAX + 1))).toBeUndefined()
    expect(sanitizeHermesSessionId('bad\rid')).toBeUndefined()
    expect(sanitizeHermesSessionId('bad\nid')).toBeUndefined()
    expect(sanitizeHermesSessionId('bad\0id')).toBeUndefined()
    expect(sanitizeHermesSessionId('has space')).toBeUndefined()
    expect(sanitizeHermesSessionId('semi;colon')).toBeUndefined()
    expect(sanitizeHermesSessionId('quote"x')).toBeUndefined()
  })

  it('accepts exactly HERMES_SESSION_ID_MAX length when otherwise safe', () => {
    const exact = 'a'.repeat(HERMES_SESSION_ID_MAX)
    expect(sanitizeHermesSessionId(exact)).toBe(exact)
  })
})
