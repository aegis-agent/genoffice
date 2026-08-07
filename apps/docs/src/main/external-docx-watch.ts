import { basename, dirname } from 'node:path'

export type DirWatcher = { close: () => void }

export interface ExternalDocxWatchDeps {
  /** Watch a directory; listener receives basename (or null). */
  watchDir: (dir: string, listener: (filename: string | null) => void) => DirWatcher
  /** Content signature of the file at path, or null if unreadable/missing. */
  readSignature: (absolutePath: string) => string | null
  /** Notify one WebContents that its tracked file changed externally (no path payload). */
  sendExternalChange: (webContentsId: number) => void
  debounceMs?: number
  setTimeout?: (cb: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

interface TrackedEntry {
  path: string
  dir: string
  base: string
  signature: string | null
  watcher: DirWatcher
  debounceTimer: unknown | null
}

/**
 * Main-owned per-WebContents DOCX external-change watchers.
 * Paths are supplied only by main after a successful open/create/save-as —
 * never selected by the renderer.
 */
export class ExternalDocxWatchRegistry {
  private readonly entries = new Map<number, TrackedEntry>()
  private readonly debounceMs: number
  private readonly watchDir: ExternalDocxWatchDeps['watchDir']
  private readonly readSignature: ExternalDocxWatchDeps['readSignature']
  private readonly sendExternalChange: ExternalDocxWatchDeps['sendExternalChange']
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (id: unknown) => void

  constructor(deps: ExternalDocxWatchDeps) {
    this.watchDir = deps.watchDir
    this.readSignature = deps.readSignature
    this.sendExternalChange = deps.sendExternalChange
    this.debounceMs = deps.debounceMs ?? 400
    this.setTimeoutFn = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimeoutFn =
      deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  }

  /** Bind this WebContents to a document path owned by main. */
  trackFromMain(webContentsId: number, absolutePath: string): void {
    if (typeof webContentsId !== 'number' || !Number.isFinite(webContentsId)) return
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) return
    if (!/\.docx$/i.test(absolutePath)) return

    const existing = this.entries.get(webContentsId)
    if (existing?.path === absolutePath) {
      // Refresh baseline signature without restarting the watcher
      existing.signature = this.readSignature(absolutePath)
      return
    }

    this.clear(webContentsId)

    const dir = dirname(absolutePath)
    const base = basename(absolutePath)
    const entry: TrackedEntry = {
      path: absolutePath,
      dir,
      base,
      signature: this.readSignature(absolutePath),
      debounceTimer: null,
      watcher: this.watchDir(dir, (filename) => {
        this.onDirEvent(webContentsId, filename)
      }),
    }
    this.entries.set(webContentsId, entry)
  }

  /** After main writes bytes to disk (app save), update known signature(s). */
  noteAppWrite(absolutePath: string, signature: string): void {
    if (typeof absolutePath !== 'string' || typeof signature !== 'string') return
    for (const entry of this.entries.values()) {
      if (entry.path === absolutePath) entry.signature = signature
    }
  }

  getTrackedPath(webContentsId: number): string | null {
    return this.entries.get(webContentsId)?.path ?? null
  }

  clear(webContentsId: number): void {
    const entry = this.entries.get(webContentsId)
    if (!entry) return
    if (entry.debounceTimer != null) {
      this.clearTimeoutFn(entry.debounceTimer)
      entry.debounceTimer = null
    }
    try {
      entry.watcher.close()
    } catch {
      /* ignore */
    }
    this.entries.delete(webContentsId)
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.clear(id)
  }

  private onDirEvent(webContentsId: number, filename: string | null): void {
    const entry = this.entries.get(webContentsId)
    if (!entry) return
    if (filename != null && filename !== entry.base) return

    if (entry.debounceTimer != null) this.clearTimeoutFn(entry.debounceTimer)
    entry.debounceTimer = this.setTimeoutFn(() => {
      entry.debounceTimer = null
      this.emitIfChanged(webContentsId)
    }, this.debounceMs)
  }

  private emitIfChanged(webContentsId: number): void {
    const entry = this.entries.get(webContentsId)
    if (!entry) return
    const next = this.readSignature(entry.path)
    if (next == null) return
    if (entry.signature != null && next === entry.signature) return
    entry.signature = next
    this.sendExternalChange(webContentsId)
  }
}
