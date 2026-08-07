import { describe, expect, it } from 'vitest'
import {
  AI_IMAGE_BASE64_MAX,
  AI_MESSAGES_MAX,
  AI_TEXT_MAX,
  AI_TOOLS_MAX,
  aiChatRequestSchema,
  aiSettingsPreferencesUpdateSchema,
  aiStreamRequestSchema,
  asAiChatRequest,
  asAiStreamRequest,
} from '../src/request-schemas'

const validStream = {
  requestId: 'req-1',
  system: 'You are helpful.',
  messages: [
    { role: 'user' as const, text: 'hi' },
    {
      role: 'assistant' as const,
      text: '',
      toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }],
    },
    {
      role: 'tool' as const,
      results: [{ id: 'c1', name: 'search', output: 'ok' }],
    },
  ],
  tools: [
    {
      name: 'search',
      description: 'web search',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    },
  ],
  maxTokens: 4096,
}

describe('aiStreamRequestSchema / aiChatRequestSchema', () => {
  it('accepts a realistic multi-turn tool payload', () => {
    const parsed = aiStreamRequestSchema.parse(validStream)
    const typed = asAiStreamRequest(parsed)
    expect(typed.requestId).toBe('req-1')
    expect(typed.messages).toHaveLength(3)
    expect(typed.tools?.[0]?.name).toBe('search')
  })

  it('accepts user messages with vision images (base64, no data-url prefix required)', () => {
    const parsed = aiStreamRequestSchema.parse({
      requestId: 'img-1',
      system: 'sys',
      messages: [
        {
          role: 'user',
          text: 'what is this?',
          images: [{ base64: 'iVBORw0KGgo=', mime: 'image/png' }],
        },
      ],
    })
    expect(parsed.messages[0]).toMatchObject({ role: 'user' })
  })

  it('accepts a valid chat request', () => {
    const parsed = aiChatRequestSchema.parse({ system: 's', user: 'u' })
    expect(asAiChatRequest(parsed)).toEqual({ system: 's', user: 'u' })
  })

  it('accepts a safe sessionId and maps it through asAiStreamRequest', () => {
    const parsed = aiStreamRequestSchema.parse({
      ...validStream,
      sessionId: 'abcdef0123456789',
    })
    expect(asAiStreamRequest(parsed).sessionId).toBe('abcdef0123456789')
  })

  it('rejects unsafe sessionId values at the schema boundary', () => {
    expect(() =>
      aiStreamRequestSchema.parse({ ...validStream, sessionId: '' }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({ ...validStream, sessionId: 'bad\r\nid' }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({ ...validStream, sessionId: 'a'.repeat(129) }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({ ...validStream, sessionId: 'has space' }),
    ).toThrow()
  })

  it('rejects settings / provider / apiKey / baseUrl on stream and chat', () => {
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        settings: { provider: 'custom', apiKey: 'sk-leak', baseUrl: 'https://evil' },
      }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        provider: 'anthropic',
      }),
    ).toThrow()
    expect(() =>
      aiChatRequestSchema.parse({
        system: 's',
        user: 'u',
        apiKey: 'sk-leak',
      }),
    ).toThrow()
    expect(() =>
      aiChatRequestSchema.parse({
        system: 's',
        user: 'u',
        baseUrl: 'https://evil.example',
      }),
    ).toThrow()
  })

  it('rejects unknown keys on nested message / tool objects', () => {
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        messages: [{ role: 'user', text: 'x', evil: true }],
      }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        tools: [
          {
            name: 't',
            description: 'd',
            inputSchema: {},
            execute: 'nope',
          },
        ],
      }),
    ).toThrow()
  })

  it('enforces message / tool / text bounds', () => {
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        messages: Array.from({ length: AI_MESSAGES_MAX + 1 }, () => ({
          role: 'user',
          text: 'x',
        })),
      }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        tools: Array.from({ length: AI_TOOLS_MAX + 1 }, (_, i) => ({
          name: `t${i}`,
          description: 'd',
          inputSchema: {},
        })),
      }),
    ).toThrow()
    expect(() =>
      aiChatRequestSchema.parse({
        system: 'x'.repeat(AI_TEXT_MAX + 1),
        user: 'u',
      }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        maxTokens: 0,
      }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({
        ...validStream,
        maxTokens: 999_999,
      }),
    ).toThrow()
    expect(() =>
      aiStreamRequestSchema.parse({
        requestId: 'r',
        system: 's',
        messages: [
          {
            role: 'user',
            text: 'x',
            images: [{ base64: 'a'.repeat(AI_IMAGE_BASE64_MAX + 1), mime: 'image/png' }],
          },
        ],
      }),
    ).toThrow()
  })
})

describe('aiSettingsPreferencesUpdateSchema', () => {
  it('accepts preference-only hermes model updates', () => {
    const parsed = aiSettingsPreferencesUpdateSchema.parse({
      providers: { hermes: { model: 'hermes-agent' } },
    })
    expect(parsed.providers.hermes.model).toBe('hermes-agent')
  })

  it('rejects full public AiSettings shapes with blank keys', () => {
    expect(() =>
      aiSettingsPreferencesUpdateSchema.parse({
        provider: 'hermes',
        providers: {
          hermes: { apiKey: '', model: 'hermes-agent', baseUrl: undefined },
          anthropic: { apiKey: '', model: 'x' },
        },
      }),
    ).toThrow()
  })

  it('rejects apiKey / baseUrl / provider / unknown fields rather than stripping', () => {
    expect(() =>
      aiSettingsPreferencesUpdateSchema.parse({
        providers: {
          hermes: { model: 'hermes-agent', apiKey: 'secret' },
        },
      }),
    ).toThrow()
    expect(() =>
      aiSettingsPreferencesUpdateSchema.parse({
        providers: {
          hermes: { model: 'hermes-agent', baseUrl: 'https://evil.example' },
        },
      }),
    ).toThrow()
    expect(() =>
      aiSettingsPreferencesUpdateSchema.parse({
        provider: 'custom',
        providers: { hermes: { model: 'hermes-agent' } },
      }),
    ).toThrow()
    expect(() =>
      aiSettingsPreferencesUpdateSchema.parse({
        providers: {
          hermes: { model: 'hermes-agent' },
          custom: { model: 'x', apiKey: 'k', baseUrl: 'https://evil' },
        },
      }),
    ).toThrow()
  })
})
