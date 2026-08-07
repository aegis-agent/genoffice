import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { sseLines, streamForProvider } from '../src/stream'
import { okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

function collector() {
  const deltas: string[] = []
  const toolCalls: AgentToolCall[] = []
  return {
    deltas,
    toolCalls,
    cb: {
      signal: new AbortController().signal,
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => toolCalls.push(call),
    },
  }
}

describe('sseLines', () => {
  it('splits a stream into lines, including a trailing line with no newline', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\ndata: b\n'))
        controller.enqueue(encoder.encode('data: c')) // no trailing newline
        controller.close()
      },
    })
    const lines: string[] = []
    for await (const line of sseLines(body)) lines.push(line)
    expect(lines).toEqual(['data: a', 'data: b', 'data: c'])
  })
})

describe('streamForProvider: anthropic', () => {
  it('emits text deltas and a completed tool call', async () => {
    const body = sseStream([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"do_thing"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider(
      'anthropic',
      { apiKey: 'k', model: 'claude-sonnet-5' },
      'system',
      [{ role: 'user', text: 'hi' }],
      [],
      100,
      cb,
    )
    expect(deltas.join('')).toBe('hello world')
    expect(toolCalls).toEqual([{ id: 't1', name: 'do_thing', input: { a: 1 } }])
  })

  it('repairs unescaped quotes inside tool input string values', async () => {
    const partial = JSON.stringify({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"topic": "from "future" to "present""}' },
    })
    const body = sseStream([
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"gen"}}',
      `data: ${partial}`,
      'data: {"type":"content_block_stop","index":1}',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { toolCalls, cb } = collector()
    await streamForProvider('anthropic', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(toolCalls).toEqual([
      { id: 't1', name: 'gen', input: { topic: 'from "future" to "present"' } },
    ])
  })

  it('unparseable tool input becomes inputError instead of killing the stream', async () => {
    const partial = JSON.stringify({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"a": 1,' }, // truncated JSON, unrepairable
    })
    const body = sseStream([
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"gen"}}',
      `data: ${partial}`,
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"after"}}',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider('anthropic', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.input).toEqual({})
    expect(toolCalls[0]!.inputError).toContain('raw: {"a": 1,')
    expect(deltas.join('')).toBe('after') // the stream was not interrupted
  })

  it('throws on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })))
    const { cb } = collector()
    await expect(
      streamForProvider('anthropic', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/Claude HTTP 401/)
  })

  it('replaces an HTML error body (e.g. a gateway block page) with a readable note', async () => {
    const html =
      '<!doctype html>\n<html>\n<head><title>Genspark</title></head><body>app shell</body></html>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html, { status: 403 })))
    const { cb } = collector()
    await expect(
      streamForProvider('anthropic', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/Claude HTTP 403: .*web page instead of an API response/)
  })
})

describe('streamForProvider: gemini', () => {
  it('emits text and a whole (non-partial) function call', async () => {
    const body = sseStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"hi there"}]}}]}',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"set_cell","args":{"a1":"42"}}}]}}]}',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider(
      'gemini',
      { apiKey: 'k', model: 'gemini-2.5-flash' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(deltas.join('')).toBe('hi there')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ name: 'set_cell', input: { a1: '42' } })
  })
})

describe('streamForProvider: openai-compatible', () => {
  it('reassembles fragmented tool call arguments and flushes on finish_reason', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"partial "}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"replace"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider(
      'openai',
      { apiKey: 'k', model: 'gpt-4.1-mini' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(deltas.join('')).toBe('partial ')
    expect(toolCalls).toEqual([{ id: 'c1', name: 'replace', input: { x: 1 } }])
  })

  it('routes deepseek and openai to their fixed base URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'deepseek',
      { apiKey: 'k', model: 'deepseek-chat' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/chat/completions',
      expect.anything(),
    )
  })

  it('fail-closes the custom provider without an explicit customFetch, without calling global fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await expect(
      streamForProvider(
        'custom',
        { apiKey: 'k', model: 'm', baseUrl: 'https://my-endpoint.example.com/v1' },
        'sys',
        [],
        [],
        100,
        cb,
      ),
    ).rejects.toThrow(/customFetch/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes custom streaming through the supplied customFetch, not global fetch', async () => {
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)
    const customFetch = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    const { cb } = collector()
    await streamForProvider(
      'custom',
      { apiKey: 'k', model: 'm', baseUrl: 'https://my-endpoint.example.com/v1' },
      'sys',
      [],
      [],
      100,
      cb,
      { customFetch },
    )
    expect(globalFetch).not.toHaveBeenCalled()
    expect(customFetch).toHaveBeenCalledWith(
      'https://my-endpoint.example.com/v1/chat/completions',
      expect.anything(),
    )
  })

  it('rejects the custom provider without a base URL even when customFetch is supplied', async () => {
    const customFetch = vi.fn()
    const { cb } = collector()
    await expect(
      streamForProvider('custom', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb, {
        customFetch,
      }),
    ).rejects.toThrow(/Base URL/)
    expect(customFetch).not.toHaveBeenCalled()
  })
})

describe('streamForProvider: hermes session continuity', () => {
  it('sends X-Hermes-Session-Id when a safe sessionId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'hermes',
      { apiKey: 'hk', model: 'hermes-agent', baseUrl: 'http://127.0.0.1:8642/v1' },
      'sys',
      [],
      [],
      100,
      cb,
      undefined,
      'doc-abc123',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer hk',
          'X-Hermes-Session-Id': 'doc-abc123',
        }),
      }),
    )
  })

  it('omits X-Hermes-Session-Id when no sessionId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'hermes',
      { apiKey: 'hk', model: 'hermes-agent', baseUrl: 'http://127.0.0.1:8642/v1' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers['X-Hermes-Session-Id']).toBeUndefined()
  })

  it('omits X-Hermes-Session-Id for unsafe session values (does not trust Fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'hermes',
      { apiKey: 'hk', model: 'hermes-agent', baseUrl: 'http://127.0.0.1:8642/v1' },
      'sys',
      [],
      [],
      100,
      cb,
      undefined,
      'bad\r\nsession',
    )
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers['X-Hermes-Session-Id']).toBeUndefined()
  })

  it('does not send X-Hermes-Session-Id for non-hermes providers even if sessionId is passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'openai',
      { apiKey: 'ok', model: 'gpt-4.1-mini' },
      'sys',
      [],
      [],
      100,
      cb,
      undefined,
      'doc-abc123',
    )
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers['X-Hermes-Session-Id']).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.anything(),
    )
  })

  it('defaults hermes base URL to the local gateway when unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider('hermes', { apiKey: 'hk', model: 'hermes-agent' }, 'sys', [], [], 100, cb)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/v1/chat/completions',
      expect.anything(),
    )
  })

  it('strips tools and never serializes tools/tool_choice for hermes even when caller supplies mutation tools', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    const mutationTools = [
      {
        name: 'replace_blocks',
        description: 'mutate live doc',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'propose_operations',
        description: 'mutate workbook',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    await streamForProvider(
      'hermes',
      { apiKey: 'hk', model: 'hermes-agent', baseUrl: 'http://127.0.0.1:8642/v1' },
      'sys',
      [{ role: 'user', text: 'edit it' }],
      mutationTools,
      100,
      cb,
      undefined,
      'doc-1',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(JSON.stringify(body)).not.toMatch(/replace_blocks|propose_operations/)
  })

  it('still serializes tools for non-hermes openai-compatible providers when supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'openai',
      { apiKey: 'sk', model: 'gpt-4.1-mini' },
      'sys',
      [],
      [
        {
          name: 'replace_blocks',
          description: 'ok for non-hermes',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      100,
      cb,
    )
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as { tools?: Array<{ function?: { name?: string } }> }
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'replace_blocks' }),
      }),
    ])
  })
})

describe('streamForProvider: genspark', () => {
  it('routes claude models to the Anthropic-compatible proxy endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream([])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'genspark',
      { apiKey: 'gsk-k', model: 'claude-opus-4-7' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.genspark.ai/api/anthropic/v1/messages',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'gsk-k' }) }),
    )
  })

  it('routes gemini models to the Gemini proxy with header auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream([])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'genspark',
      { apiKey: 'gsk-k', model: 'gemini-3-flash-preview' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.genspark.ai/api/llm_proxy/gemini/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-goog-api-key': 'gsk-k' }) }),
    )
  })

  it('routes other models to the OpenAI-compatible proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'genspark',
      { apiKey: 'gsk-k', model: 'gpt-5.2' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.genspark.ai/api/llm_proxy/v1/chat/completions',
      expect.anything(),
    )
  })
})

it('rejects an unknown provider id', async () => {
  const { cb } = collector()
  await expect(
    streamForProvider('unknown' as never, { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
  ).rejects.toThrow(/Unknown provider/)
})
