import type { OpenFileResult } from '../shared/ipc'

export type ExternalReloadResult = 'reloaded' | 'declined' | 'stale' | 'noop'

export interface ExternalDocxReloadHandlers {
  isDirty: () => boolean
  /** Current editor document path; re-checked after async gaps. */
  getPath: () => string | null | undefined
  confirm: () => boolean | Promise<boolean>
  /** No-path reload via main (tracked path for this WebContents only). */
  reload: () => Promise<OpenFileResult | null>
  apply: (result: OpenFileResult) => void | Promise<void>
}

/**
 * Handle a main-originated external-change signal.
 * Never takes a path from the event — reload is main-tracked only.
 * Re-checks path after async confirm/reload so stale callbacks cannot clobber a newer doc.
 */
export async function handleExternalDocxChange(
  handlers: ExternalDocxReloadHandlers,
): Promise<ExternalReloadResult> {
  const pathAtStart = handlers.getPath()
  if (!pathAtStart) return 'noop'

  if (handlers.isDirty()) {
    const ok = await handlers.confirm()
    if (!ok) return 'declined'
    if (handlers.getPath() !== pathAtStart) return 'stale'
  }

  const result = await handlers.reload()
  if (handlers.getPath() !== pathAtStart) return 'stale'
  if (!result) return 'noop'

  await handlers.apply(result)
  return 'reloaded'
}
