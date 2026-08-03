import { describe, expect, it, vi } from 'vitest'

import {
  IpcValidationError,
  safeHandle,
  type IpcMainLike,
  type RuntimeSchema,
} from '../src/safe-handle'

type Registered = {
  channel: string
  listener: (event: unknown, ...args: unknown[]) => unknown
}

function mockIpc(): { ipc: IpcMainLike; handlers: Registered[] } {
  const handlers: Registered[] = []
  const ipc: IpcMainLike = {
    handle(channel: string, listener: Registered['listener']) {
      handlers.push({ channel, listener })
    },
  }
  return { ipc, handlers }
}

function tupleSchema<T extends readonly unknown[]>(parse: (input: unknown) => T): RuntimeSchema<T> {
  return { parse }
}

async function invoke(
  listener: Registered['listener'],
  event: unknown,
  ...args: unknown[]
): Promise<unknown> {
  return await listener(event, ...args)
}

describe('safeHandle', () => {
  it('dispatches valid argument tuples to the handler', async () => {
    const { ipc, handlers } = mockIpc()
    const handler = vi.fn((_event: unknown, a: string, b: number) => `${a}:${b}`)
    const schema = tupleSchema((input: unknown): [string, number] => {
      if (!Array.isArray(input) || input.length !== 2) throw new Error('bad len')
      if (typeof input[0] !== 'string' || typeof input[1] !== 'number') throw new Error('bad types')
      return [input[0], input[1]]
    })

    safeHandle(ipc, 'test:channel', schema, handler)
    expect(handlers).toHaveLength(1)
    expect(handlers[0]!.channel).toBe('test:channel')

    const result = await invoke(handlers[0]!.listener, { sender: 1 }, 'hello', 42)
    expect(result).toBe('hello:42')
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ sender: 1 }, 'hello', 42)
  })

  it('blocks invalid tuples and never calls the handler', async () => {
    const { ipc, handlers } = mockIpc()
    const handler = vi.fn()
    const schema = tupleSchema((input: unknown): [string] => {
      if (!Array.isArray(input) || typeof input[0] !== 'string') throw new Error('nope')
      return [input[0]]
    })

    safeHandle(ipc, 'files:add', schema, handler)

    await expect(invoke(handlers[0]!.listener, {}, 123)).rejects.toBeInstanceOf(IpcValidationError)
    await expect(invoke(handlers[0]!.listener, {}, 123)).rejects.toThrow(/files:add/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('blocks strict-object unknown keys via schema failure', async () => {
    const { ipc, handlers } = mockIpc()
    const handler = vi.fn()
    const schema = tupleSchema((input: unknown): [{ id: string }] => {
      if (!Array.isArray(input) || input.length !== 1) throw new Error('len')
      const obj = input[0]
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('obj')
      const keys = Object.keys(obj as object)
      if (keys.some((k) => k !== 'id')) throw new Error('unknown key')
      if (typeof (obj as { id?: unknown }).id !== 'string') throw new Error('id')
      return [{ id: (obj as { id: string }).id }]
    })

    safeHandle(ipc, 'ai:stream', schema, handler)
    await expect(
      invoke(handlers[0]!.listener, {}, { id: 'ok', extra: 'nope', apiKey: 'sk-secret' }),
    ).rejects.toBeInstanceOf(IpcValidationError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('validation errors never include payload values, secrets, or paths', async () => {
    const { ipc, handlers } = mockIpc()
    const secret = 'sk-super-secret-key-do-not-leak'
    const path = '/home/victim/.ssh/id_rsa'
    const schema = tupleSchema((_input: unknown): [string] => {
      // Schema errors often embed the bad value — safeHandle must strip that.
      throw new Error(`Invalid path ${path} apiKey=${secret} baseUrl=https://evil.example`)
    })

    safeHandle(ipc, 'files:read', schema, () => 'ok')

    let caught: unknown
    try {
      await invoke(handlers[0]!.listener, {}, path, secret)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(IpcValidationError)
    const message = caught instanceof Error ? caught.message : String(caught)
    const stack = caught instanceof Error ? (caught.stack ?? '') : ''
    for (const leak of [secret, path, 'evil.example', 'id_rsa', 'sk-super']) {
      expect(message).not.toContain(leak)
      expect(stack).not.toContain(leak)
    }
    expect(message).toContain('files:read')
  })

  it('preserves async handler success and rejection', async () => {
    const { ipc, handlers } = mockIpc()
    const schema = tupleSchema((input: unknown): [number] => {
      if (!Array.isArray(input) || typeof input[0] !== 'number') throw new Error('n')
      return [input[0]]
    })

    safeHandle(ipc, 'ai:chat', schema, async (_e: unknown, n: number) => {
      if (n < 0) throw new Error('handler boom')
      return n * 2
    })

    await expect(invoke(handlers[0]!.listener, {}, 21)).resolves.toBe(42)

    let handlerErr: unknown
    try {
      await invoke(handlers[0]!.listener, {}, -1)
    } catch (err) {
      handlerErr = err
    }
    expect(handlerErr).toBeInstanceOf(Error)
    expect(handlerErr).not.toBeInstanceOf(IpcValidationError)
    expect((handlerErr as Error).message).toBe('handler boom')
  })

  it('does not mislabel handler errors as validation errors', async () => {
    const { ipc, handlers } = mockIpc()
    const schema = tupleSchema((input: unknown): [] => {
      if (!Array.isArray(input) || input.length !== 0) throw new Error('args')
      return []
    })

    safeHandle(ipc, 'ai:gsk-login', schema, () => {
      throw new Error('disk full at /var/secret/path')
    })

    let caught: unknown
    try {
      await invoke(handlers[0]!.listener, {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(IpcValidationError)
    expect((caught as Error).message).toBe('disk full at /var/secret/path')
  })

  it('supports zero-argument channels', async () => {
    const { ipc, handlers } = mockIpc()
    const handler = vi.fn(() => 'pong')
    const schema = tupleSchema((input: unknown): [] => {
      if (!Array.isArray(input) || input.length !== 0) throw new Error('empty only')
      return []
    })
    safeHandle(ipc, 'ai:get-settings', schema, handler)
    await expect(invoke(handlers[0]!.listener, {})).resolves.toBe('pong')
    expect(handler).toHaveBeenCalledWith({})
  })
})
