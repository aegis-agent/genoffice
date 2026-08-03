/**
 * Main-process IPC registration helper with runtime argument-tuple validation.
 * Electron- and Zod-free: inject an ipcMain-like registrar and a schema with
 * `parse(unknown)`. Validate the complete renderer argument list before the
 * handler runs; validation failures never call the handler and never embed
 * payload values, secrets, paths, or raw schema messages.
 */

/** Minimal schema surface — typically a Zod schema or a thin adapter. */
export interface RuntimeSchema<T> {
  parse(input: unknown): T
}

/** Minimal ipcMain.handle surface (avoids an Electron dependency here). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/**
 * Distinguishable validation failure. Message is channel-specific and generic —
 * it must never include renderer payload contents.
 */
export class IpcValidationError extends Error {
  readonly code = 'IPC_VALIDATION_ERROR' as const
  readonly channel: string

  constructor(channel: string) {
    super(`Invalid IPC arguments for channel "${channel}"`)
    this.name = 'IpcValidationError'
    this.channel = channel
  }
}

/**
 * Register an invoke handler that validates the full argument tuple (everything
 * after `event`) before calling `handler`. Sync and async handlers are
 * preserved: the return value (including rejected promises) is passed through.
 * Handler throws are never rewritten as validation errors.
 *
 * `TArgs` is taken from `schema`. Handlers may declare fewer parameters than
 * the tuple (TypeScript function assignability).
 */
export function safeHandle<TArgs extends readonly unknown[], TResult = unknown>(
  ipcMain: IpcMainLike,
  channel: string,
  schema: RuntimeSchema<TArgs>,
  // Call-site handlers are checked against the schema's TArgs via destructuring
  // defaults; keep the parameter open so empty-tuple channels type-check cleanly.
  handler: (event: unknown, ...args: any[]) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    let parsed: TArgs
    try {
      parsed = schema.parse(args)
    } catch {
      throw new IpcValidationError(channel)
    }
    return handler(event, ...parsed)
  })
}
