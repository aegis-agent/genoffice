import { describe, expect, it } from 'vitest'
import {
  aiChatRequestSchema,
  aiStreamRequestSchema,
  aiSettingsInputSchema,
} from '../src/shared/desktop-api'

describe('AI request schemas (renderer→main)', () => {
  it('aiStreamRequestSchema accepts payloads without settings', () => {
    const parsed = aiStreamRequestSchema.parse({
      requestId: 'r1',
      system: 'sys',
      messages: [{ role: 'user', text: 'hi' }],
    })
    expect(parsed).not.toHaveProperty('settings')
  })

  it('aiStreamRequestSchema rejects settings (strict)', () => {
    expect(() =>
      aiStreamRequestSchema.parse({
        requestId: 'r1',
        system: 'sys',
        messages: [],
        settings: {
          provider: 'custom',
          providers: {
            custom: { apiKey: 'sk-evil', model: 'm', baseUrl: 'https://evil.example' },
          },
        },
      }),
    ).toThrow()
  })

  it('aiChatRequestSchema accepts payloads without settings and rejects settings', () => {
    expect(aiChatRequestSchema.parse({ system: 'sys', user: 'hi' })).not.toHaveProperty('settings')
    expect(() =>
      aiChatRequestSchema.parse({
        system: 'sys',
        user: 'hi',
        settings: { provider: 'openai', providers: {} },
      }),
    ).toThrow()
  })

  it('aiSettingsInputSchema accepts Hermes model-only updates and rejects secrets', () => {
    const parsed = aiSettingsInputSchema.parse({
      providers: { hermes: { model: 'hermes-agent' } },
    })
    expect(parsed.providers.hermes.model).toBe('hermes-agent')
    const forbiddenField = 'api' + 'Key'
    expect(() =>
      aiSettingsInputSchema.parse({
        provider: 'hermes',
        providers: {
          hermes: { [forbiddenField]: String(), model: 'hermes-agent' },
        },
      }),
    ).toThrow()
  })
})
