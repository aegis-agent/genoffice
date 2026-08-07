import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ExternalDocxWatchRegistry,
  type DirWatcher,
  type ExternalDocxWatchDeps,
} from '../src/main/external-docx-watch'

function sig(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

type FakeWatch = {
  dir: string
  listener: (filename: string | null) => void
  close: ReturnType<typeof vi.fn>
}

function createHarness(options?: { debounceMs?: number }) {
  const watchers: FakeWatch[] = []
  const signatures = new Map<string, string>()
  const sent: number[] = []
  let nextTimerId = 1
  const timers = new Map<number, { cb: () => void; ms: number }>()

  const deps: ExternalDocxWatchDeps = {
    debounceMs: options?.debounceMs ?? 40,
    watchDir(dir, listener) {
      const close = vi.fn()
      const entry: FakeWatch = { dir, listener, close }
      watchers.push(entry)
      return { close } satisfies DirWatcher
    },
    readSignature(path) {
      return signatures.get(path) ?? null
    },
    sendExternalChange(webContentsId) {
      sent.push(webContentsId)
    },
    setTimeout(cb, ms) {
      const id = nextTimerId++
      timers.set(id, { cb, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id as number)
    },
  }

  const registry = new ExternalDocxWatchRegistry(deps)

  return {
    registry,
    watchers,
    signatures,
    sent,
    timers,
    flushTimers() {
      // Run currently scheduled timers once (order of insertion).
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, t] of pending) t.cb()
    },
    fire(dir: string, filename: string | null) {
      for (const w of watchers) {
        if (w.dir === dir && !w.close.mock.calls.length) w.listener(filename)
      }
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ExternalDocxWatchRegistry (main-owned)', () => {
  it('A: has no renderer path input surface and isolates two WebContents', () => {
    const h = createHarness()
    // Public API is (webContentsId, absolutePath) only — main supplies both.
    expect(typeof h.registry.trackFromMain).toBe('function')
    expect(typeof h.registry.clear).toBe('function')
    expect(
      (h.registry as unknown as { trackFromRenderer?: unknown }).trackFromRenderer,
    ).toBeUndefined()
    expect((h.registry as unknown as { trackFile?: unknown }).trackFile).toBeUndefined()

    h.signatures.set('/docs/a.docx', sig('A'))
    h.signatures.set('/docs/b.docx', sig('B'))
    h.registry.trackFromMain(1, '/docs/a.docx')
    h.registry.trackFromMain(2, '/docs/b.docx')

    expect(h.registry.getTrackedPath(1)).toBe('/docs/a.docx')
    expect(h.registry.getTrackedPath(2)).toBe('/docs/b.docx')
    expect(h.watchers).toHaveLength(2)

    // External change on a.docx notifies only wc 1
    h.signatures.set('/docs/a.docx', sig('A2'))
    h.fire('/docs', 'a.docx')
    h.flushTimers()
    expect(h.sent).toEqual([1])

    // External change on b.docx notifies only wc 2
    h.signatures.set('/docs/b.docx', sig('B2'))
    h.fire('/docs', 'b.docx')
    h.flushTimers()
    expect(h.sent).toEqual([1, 2])
  })

  it('B: same-content app save is suppressed; different external content emits once after debounce', () => {
    const h = createHarness({ debounceMs: 50 })
    const path = '/tmp/note.docx'
    const dir = '/tmp'
    const base = 'note.docx'
    const contentA = Buffer.from('same-bytes')
    const contentB = Buffer.from('changed-bytes')

    h.signatures.set(path, sig(contentA))
    h.registry.trackFromMain(7, path)
    // App save wrote identical bytes — update known signature to match disk
    h.registry.noteAppWrite(path, sig(contentA))

    h.fire(dir, base)
    h.fire(dir, base)
    h.fire(dir, base)
    h.flushTimers()
    expect(h.sent).toEqual([])

    // Truly external different content
    h.signatures.set(path, sig(contentB))
    h.fire(dir, base)
    h.fire(dir, base)
    expect(h.sent).toEqual([]) // still debouncing
    h.flushTimers()
    expect(h.sent).toEqual([7])

    // No further emit without another content change
    h.fire(dir, base)
    h.flushTimers()
    expect(h.sent).toEqual([7])
  })

  it('C: atomic rename/replacement is observed; unrelated basename is ignored', () => {
    const h = createHarness()
    const path = '/work/report.docx'
    h.signatures.set(path, sig('v1'))
    h.registry.trackFromMain(3, path)

    // Unrelated file in same dir
    h.fire('/work', 'other.docx')
    h.fire('/work', 'report.docx.tmp')
    h.flushTimers()
    expect(h.sent).toEqual([])

    // Atomic replace: write temp then rename onto basename (dir watcher sees basename)
    h.signatures.set(path, sig('v2'))
    h.fire('/work', 'report.docx')
    h.flushTimers()
    expect(h.sent).toEqual([3])
  })

  it('D: destroy/document-switch closes watcher and cancels pending timers', () => {
    const h = createHarness()
    const path = '/x/doc.docx'
    h.signatures.set(path, sig('1'))
    h.registry.trackFromMain(9, path)
    expect(h.watchers).toHaveLength(1)

    h.signatures.set(path, sig('2'))
    h.fire('/x', 'doc.docx')
    expect(h.timers.size).toBe(1)

    h.registry.clear(9)
    expect(h.watchers[0].close).toHaveBeenCalledTimes(1)
    expect(h.timers.size).toBe(0)
    expect(h.registry.getTrackedPath(9)).toBeNull()

    // Switched document starts a fresh watcher; old pending would not fire
    h.signatures.set('/x/other.docx', sig('o1'))
    h.registry.trackFromMain(9, '/x/other.docx')
    expect(h.watchers).toHaveLength(2)
    expect(h.watchers[1].close).not.toHaveBeenCalled()
    h.flushTimers()
    expect(h.sent).toEqual([])

    // Destroy again
    h.registry.clear(9)
    expect(h.watchers[1].close).toHaveBeenCalledTimes(1)
  })
})
