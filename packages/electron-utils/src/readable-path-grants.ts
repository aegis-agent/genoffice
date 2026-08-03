/// Sender-scoped grants for main-process attachment reads.
/// Paths are authorized by canonical identity (realpath). A grant for a path
/// that is later retargeted via symlink fails closed because authorization
/// re-resolves and compares against the granted canonical set.

import { realpathSync } from 'node:fs'

export type RealpathFn = (path: string) => string

/** Minimal sender surface used for destroyed cleanup (Electron WebContents). */
export interface GrantCleanupSender {
  id: number
  once(event: 'destroyed', listener: () => void): void
}

/**
 * Registry of readable filesystem paths granted per IPC sender id.
 * Pure aside from the injectable realpath function (defaults to fs.realpathSync).
 */
export class ReadablePathGrantRegistry {
  private readonly grants = new Map<number, Set<string>>()
  private readonly cleanupBound = new Set<number>()

  constructor(private readonly realpath: RealpathFn = defaultRealpath) {}

  /**
   * Grant `path` to `senderId` under its current canonical identity.
   * Returns the canonical path, or null if the path cannot be resolved.
   */
  grant(senderId: number, path: string): string | null {
    if (typeof path !== 'string' || path.length === 0) return null
    let canonical: string
    try {
      canonical = this.realpath(path)
    } catch {
      return null
    }
    let set = this.grants.get(senderId)
    if (!set) {
      set = new Set()
      this.grants.set(senderId, set)
    }
    set.add(canonical)
    return canonical
  }

  /** True iff `path` currently realpath-resolves to a grant held by `senderId`. */
  isAuthorized(senderId: number, path: string): boolean {
    if (typeof path !== 'string' || path.length === 0) return false
    const set = this.grants.get(senderId)
    if (!set || set.size === 0) return false
    try {
      return set.has(this.realpath(path))
    } catch {
      return false
    }
  }

  /** Drop every grant for a sender (e.g. on WebContents destroyed). */
  revokeSender(senderId: number): void {
    this.grants.delete(senderId)
    this.cleanupBound.delete(senderId)
  }

  /**
   * Bind a one-shot `destroyed` listener that revokes this sender's grants.
   * Idempotent per sender id — safe to call after every grant batch.
   */
  bindSenderCleanup(sender: GrantCleanupSender): void {
    const senderId = sender.id
    if (this.cleanupBound.has(senderId)) return
    this.cleanupBound.add(senderId)
    sender.once('destroyed', () => {
      this.revokeSender(senderId)
    })
  }
}

function defaultRealpath(path: string): string {
  return realpathSync(path)
}
