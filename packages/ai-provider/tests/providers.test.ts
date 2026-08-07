import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, defaultAiSettings, resolveAiSettings } from '../src/providers'
import { publicAiSettings } from '../src/main-owned-config'

describe('defaultAiSettings', () => {
  it('gives every provider its default model and an empty key by default', () => {
    const settings = defaultAiSettings()
    // Integration: native Hermes is the default (local gateway), not genspark
    expect(settings.provider).toBe('hermes')
    for (const meta of AI_PROVIDERS) {
      expect(settings.providers[meta.id].apiKey).toBe('')
      expect(settings.providers[meta.id].model).toBe(meta.defaultModel)
    }
    // Hermes carries the local gateway default baseUrl
    expect(settings.providers.hermes.baseUrl).toBe('http://127.0.0.1:8642/v1')
    expect(settings.providers.hermes.model).toBe('hermes-agent')
    expect(settings.providers.custom.baseUrl).toBe('')
    expect(settings.providers.anthropic.baseUrl).toBeUndefined()
  })

  it('lists hermes as a first-class provider with the local gateway contract', () => {
    const hermes = AI_PROVIDERS.find((p) => p.id === 'hermes')
    expect(hermes).toBeDefined()
    expect(hermes!.defaultModel).toBe('hermes-agent')
    expect(hermes!.models).toContain('hermes-agent')
    expect(hermes!.defaultBaseUrl).toBe('http://127.0.0.1:8642/v1')
    expect(hermes!.needsBaseUrl).toBe(true)
  })

  it('applies caller-supplied default keys only to the listed providers', () => {
    const settings = defaultAiSettings({ anthropic: '«redacted:sk-…»' })
    expect(settings.providers.anthropic.apiKey).toBe('«redacted:sk-…»')
    expect(settings.providers.gemini.apiKey).toBe('')
  })
})

describe('resolveAiSettings', () => {
  it('returns fresh defaults when nothing is stored', () => {
    const defaults = defaultAiSettings({ anthropic: '«redacted:sk-…»' })
    expect(resolveAiSettings({}, defaults)).toEqual(defaults)
  })

  it('migrates the pre-provider single-endpoint shape into the custom provider', () => {
    const defaults = defaultAiSettings()
    const resolved = resolveAiSettings(
      { apiKey: 'legacy-key', model: 'legacy-model', baseUrl: 'https://legacy.example.com/v1' },
      defaults,
    )
    expect(resolved.providers.custom).toEqual({
      apiKey: 'legacy-key',
      model: 'legacy-model',
      baseUrl: 'https://legacy.example.com/v1',
    })
    // untouched providers keep their defaults
    expect(resolved.providers.anthropic).toEqual(defaults.providers.anthropic)
  })

  it('defaults the legacy base URL to the OpenAI endpoint when omitted', () => {
    const resolved = resolveAiSettings({ apiKey: 'k' }, defaultAiSettings())
    expect(resolved.providers.custom.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('merges stored multi-provider settings over the defaults, provider by provider', () => {
    const defaults = defaultAiSettings({ anthropic: 'preset-key' })
    const resolved = resolveAiSettings(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'store...ey', model: 'gemini-2.5-pro' },
        } as never,
      },
      defaults,
    )
    expect(resolved.provider).toBe('gemini')
    expect(resolved.providers.gemini).toEqual({ apiKey: 'store...ey', model: 'gemini-2.5-pro' })
    // provider not mentioned in stored.providers keeps the computed default
    expect(resolved.providers.anthropic.apiKey).toBe('preset-key')
  })
})

describe('publicAiSettings (hermes default + secret redaction)', () => {
  it('defaults public provider to hermes and redacts every apiKey including hermes', () => {
    const settings = defaultAiSettings({
      anthropic: '«redacted:sk-…»',
      openai: '«redacted:sk-…»',
    })
    settings.provider = 'custom'
    settings.providers.custom = {
      apiKey: 'evil-key',
      model: 'm',
      baseUrl: 'https://evil.example/v1',
    }
    settings.providers.hermes.apiKey = 'hermes-secret-must-not-leak'
    settings.providers.hermes.model = 'hermes-agent'

    const pub = publicAiSettings(settings)
    expect(pub.provider).toBe('hermes')
    for (const meta of AI_PROVIDERS) {
      expect(pub.providers[meta.id].apiKey).toBe('')
    }
    expect(pub.providers.hermes.model).toBe('hermes-agent')
    expect(pub.providers.hermes.baseUrl).toBe('http://127.0.0.1:8642/v1')
    expect(pub.providers.custom.baseUrl).toBe('')
    // never mutates the input
    expect(settings.providers.anthropic.apiKey).toBe('«redacted:sk-…»')
    expect(settings.providers.hermes.apiKey).toBe('hermes-secret-must-not-leak')
  })
})
