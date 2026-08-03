import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ReadablePathGrantRegistry } from '../src/readable-path-grants'

describe('ReadablePathGrantRegistry', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
    }
  })

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'grant-reg-'))
    dirs.push(d)
    return d
  }

  function writeTempFile(dir: string, name: string, body = 'secret'): string {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  }

  it('rejects ungranted paths', () => {
    const dir = tempDir()
    const file = writeTempFile(dir, 'a.txt')
    const reg = new ReadablePathGrantRegistry()
    expect(reg.isAuthorized(1, file)).toBe(false)
  })

  it('allows a path only for the sender that was granted it', () => {
    const dir = tempDir()
    const file = writeTempFile(dir, 'a.txt')
    const reg = new ReadablePathGrantRegistry()
    expect(reg.grant(1, file)).toBeTruthy()
    expect(reg.isAuthorized(1, file)).toBe(true)
    expect(reg.isAuthorized(2, file)).toBe(false)
  })

  it('denies after revokeSender (owner cleanup)', () => {
    const dir = tempDir()
    const file = writeTempFile(dir, 'a.txt')
    const reg = new ReadablePathGrantRegistry()
    reg.grant(7, file)
    expect(reg.isAuthorized(7, file)).toBe(true)
    reg.revokeSender(7)
    expect(reg.isAuthorized(7, file)).toBe(false)
  })

  it('treats alias paths that share a canonical identity as the same grant', () => {
    const dir = tempDir()
    const real = writeTempFile(dir, 'real.txt', 'payload')
    const alias = join(dir, 'alias.txt')
    symlinkSync(real, alias)

    const reg = new ReadablePathGrantRegistry()
    expect(reg.grant(1, alias)).toBeTruthy()
    // Reading via the real path must succeed (same inode / realpath)
    expect(reg.isAuthorized(1, real)).toBe(true)
    expect(reg.isAuthorized(1, alias)).toBe(true)
    expect(realpathSync(alias)).toBe(realpathSync(real))
  })

  it('fails closed if a granted path is retargeted through a symlink after grant', () => {
    const dir = tempDir()
    const allowed = writeTempFile(dir, 'allowed.txt', 'ok')
    const secret = writeTempFile(dir, 'secret.txt', 'nope')
    const link = join(dir, 'link.txt')
    symlinkSync(allowed, link)

    const reg = new ReadablePathGrantRegistry()
    expect(reg.grant(1, link)).toBeTruthy()
    expect(reg.isAuthorized(1, link)).toBe(true)

    // Replace the symlink so it now points at a different file
    rmSync(link)
    symlinkSync(secret, link)

    expect(reg.isAuthorized(1, link)).toBe(false)
    // Direct grant of allowed still works via original path
    expect(reg.isAuthorized(1, allowed)).toBe(true)
    expect(reg.isAuthorized(1, secret)).toBe(false)
  })

  it('grant returns null and does not authorize when path cannot be resolved', () => {
    const reg = new ReadablePathGrantRegistry()
    expect(reg.grant(1, join(tempDir(), 'missing-nope.txt'))).toBeNull()
    expect(reg.isAuthorized(1, join(tempDir(), 'missing-nope.txt'))).toBe(false)
  })

  it('bindSenderCleanup attaches destroyed cleanup only once per sender', () => {
    const dir = tempDir()
    const file = writeTempFile(dir, 'a.txt')
    const reg = new ReadablePathGrantRegistry()
    const binds: Array<() => void> = []
    const sender = {
      id: 42,
      once(event: string, cb: () => void) {
        expect(event).toBe('destroyed')
        binds.push(cb)
      },
    }

    reg.grant(sender.id, file)
    reg.bindSenderCleanup(sender)
    reg.grant(sender.id, file)
    reg.bindSenderCleanup(sender)
    expect(binds).toHaveLength(1)

    binds[0]!()
    expect(reg.isAuthorized(sender.id, file)).toBe(false)
  })
})
