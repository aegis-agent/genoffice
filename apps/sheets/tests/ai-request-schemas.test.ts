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
            custom: { apiKey: 'sk', model: 'm', baseUrl: 'https://evil.example' },
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

  it('aiSettingsInputSchema still validates preference-shaped objects for set-settings', () => {
    // Main sanitizes further; schema only needs a structured object.
    const parsed = aiSettingsInputSchema.parse({
      provider: 'genspark',
      providers: {
        genspark: { apiKey: '', model: 'claude-opus-4-7' },
      },
    })
    expect(parsed.provider).toBe('genspark')
  })
})
