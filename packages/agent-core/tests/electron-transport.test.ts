import { describe, expect, it, vi } from 'vitest'
import { createIpcTransport, type IpcStreamChunk, type IpcStreamStart } from '../src'

function setup() {
  let listener: ((chunk: IpcStreamChunk) => void) | undefined
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const started: IpcStreamStart[] = []
  const cancelled: string[] = []
  const transport = createIpcTransport({
    onStream: (l) => {
      listener = l
      return unsubscribe
    },
    start: (request) => started.push(request),
    cancel: (requestId) => cancelled.push(requestId),
    unknownErrorText: () => 'unknown error',
  })
  const cb = {
    onDelta: vi.fn(),
    onToolCall: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
  const handle = transport.stream({ system: 'sys', messages: [], tools: [] }, cb)
  const emit = (chunk: Omit<IpcStreamChunk, 'requestId'> & { requestId?: string }) =>
    listener?.({ requestId: started[0]!.requestId, ...chunk })
  return { started, cancelled, cb, handle, emit, unsubscribe }
}

describe('createIpcTransport', () => {
  it('starts one request without settings and forwards deltas and tool calls', () => {
    const { started, cb, emit } = setup()
    expect(started).toHaveLength(1)
    expect(started[0]).not.toHaveProperty('settings')
    expect(started[0]!.system).toBe('sys')
    expect(started[0]!.messages).toEqual([])
    expect(started[0]!.tools).toEqual([])

    emit({ type: 'delta', text: 'hi' })
    emit({ type: 'delta' })
    emit({ type: 'tool-call', toolCall: { id: 'c1', name: 'read', input: {} } })
    expect(cb.onDelta).toHaveBeenNthCalledWith(1, 'hi')
    expect(cb.onDelta).toHaveBeenNthCalledWith(2, '')
    expect(cb.onToolCall).toHaveBeenCalledWith({ id: 'c1', name: 'read', input: {} })
  })

  it('ignores chunks for other requestIds', () => {
    const { cb, emit } = setup()
    emit({ requestId: 'someone-else', type: 'delta', text: 'nope' })
    expect(cb.onDelta).not.toHaveBeenCalled()
  })

  it('unsubscribes on done', () => {
    const { cb, emit, unsubscribe } = setup()
    emit({ type: 'done' })
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('maps error chunks to onError with the localized fallback', () => {
    const { cb, emit, unsubscribe } = setup()
    emit({ type: 'error' })
    expect(cb.onError).toHaveBeenCalledWith('unknown error')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('cancel forwards the requestId to the bridge', () => {
    const { started, cancelled, handle } = setup()
    handle.cancel()
    expect(cancelled).toEqual([started[0]!.requestId])
  })

  it('forwards sessionId on start when present on the agent stream request', () => {
    const started: IpcStreamStart[] = []
    const transport = createIpcTransport({
      onStream: () => () => undefined,
      start: (request) => started.push(request),
      cancel: () => undefined,
      unknownErrorText: () => 'unknown error',
    })
    transport.stream(
      { system: 'sys', messages: [], tools: [], sessionId: 'doc-chat-42' },
      { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    )
    expect(started[0]).toMatchObject({ sessionId: 'doc-chat-42', system: 'sys' })
  })

  it('omits sessionId on start when the agent stream request has none', () => {
    const { started } = setup()
    expect(started[0]).not.toHaveProperty('sessionId')
  })
})
