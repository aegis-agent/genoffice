/// One-time permit gate for preload-observed drag/drop and File-input paths.
/// Trusted preload code issues a permit when webUtils.getPathForFile returns a
/// nonempty path; addAttachmentPaths may forward only paths that still hold an
/// unconsumed permit. Renderer-supplied arbitrary strings never get a permit.

export type ConsumeAllResult = { ok: true; paths: string[] } | { ok: false }

/**
 * Preload-private permit bag. Not shared with the renderer; lives only in the
 * preload closure. Fail-closed: mixed lists never partially authorize.
 */
export class DroppedPathPermitGate {
  /** path → remaining permit count */
  private readonly permits = new Map<string, number>()

  /** Record that trusted preload observed this path via getPathForFile. */
  issue(path: string): void {
    if (typeof path !== 'string' || path.length === 0) return
    this.permits.set(path, (this.permits.get(path) ?? 0) + 1)
  }

  /**
   * Atomically consume one permit per entry in `paths`.
   * On any missing permit (or invalid entry), consume nothing and return ok:false.
   */
  consumeAll(paths: readonly string[]): ConsumeAllResult {
    if (!Array.isArray(paths)) return { ok: false }

    const needed = new Map<string, number>()
    for (const p of paths) {
      if (typeof p !== 'string' || p.length === 0) return { ok: false }
      needed.set(p, (needed.get(p) ?? 0) + 1)
    }

    for (const [p, n] of needed) {
      if ((this.permits.get(p) ?? 0) < n) return { ok: false }
    }

    for (const [p, n] of needed) {
      const left = (this.permits.get(p) ?? 0) - n
      if (left <= 0) this.permits.delete(p)
      else this.permits.set(p, left)
    }

    return { ok: true, paths: [...paths] }
  }
}
