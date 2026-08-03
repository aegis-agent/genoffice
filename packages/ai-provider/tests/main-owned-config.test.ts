import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, defaultAiSettings } from '../src/providers'
import {
  publicAiSettings,
  resolveMainOwnedAiConfig,
  sanitizeRendererAiSettingsUpdate,
} from '../src/main-owned-config'
import type { AiSettings } from '../src/types'

describe('publicAiSettings', () => {
  it('forces provider genspark and redacts every apiKey', () => {
    const settings = defaultAiSettings({
      anthropic: 'sk-secret-anthropic',
      openai: 'sk-secret-openai',
    })
    settings.provider = 'custom'
    settings.providers.custom = {
      apiKey: 'sk-custom',
      model: 'm',
      baseUrl: 'https://evil.example/v1',
    }
    settings.providers.genspark.apiKey = 'should-not-leak'
    settings.providers.genspark.model = 'claude-opus-4-7'

    const pub = publicAiSettings(settings)
    expect(pub.provider).toBe('genspark')
    for (const meta of AI_PROVIDERS) {
      expect(pub.providers[meta.id].apiKey).toBe('')
    }
    expect(pub.providers.custom.baseUrl).toBe('')
    expect(pub.providers.genspark.model).toBe('claude-opus-4-7')
    // never mutates the input
    expect(settings.providers.anthropic.apiKey).toBe('sk-secret-anthropic')
  })
})

describe('sanitizeRendererAiSettingsUpdate', () => {
  it('persists only an allowlisted Genspark model and clears secrets/baseUrl', () => {
    const malicious = {
      provider: 'custom',
      providers: {
        custom: {
          apiKey: 'sk-attacker',
          model: 'attacker-model',
          baseUrl: 'https://attacker.example/v1',
        },
        genspark: { apiKey: 'fake-gsk', model: 'claude-sonnet-4-6' },
        anthropic: { apiKey: 'sk-anth', model: 'claude-opus-4-7' },
      },
    }

    const sanitized = sanitizeRendererAiSettingsUpdate(malicious)
    expect(sanitized.provider).toBe('genspark')
    expect(sanitized.providers.genspark.model).toBe('claude-sonnet-4-6')
    for (const meta of AI_PROVIDERS) {
      expect(sanitized.providers[meta.id].apiKey).toBe('')
    }
    expect(sanitized.providers.custom.baseUrl).toBe('')
    expect(sanitized.providers.custom.model).toBe(defaultAiSettings().providers.custom.model)
  })

  it('rejects unknown Genspark models and falls back to the default', () => {
    const sanitized = sanitizeRendererAiSettingsUpdate({
      provider: 'genspark',
      providers: {
        genspark: { apiKey: '', model: 'not-a-real-model' },
      },
    })
    expect(sanitized.provider).toBe('genspark')
    expect(sanitized.providers.genspark.model).toBe(
      AI_PROVIDERS.find((p) => p.id === 'genspark')!.defaultModel,
    )
  })

  it('ignores non-object / garbage input and returns safe defaults', () => {
    for (const garbage of [null, undefined, 'x', 42, [], { provider: 'openai' }]) {
      const sanitized = sanitizeRendererAiSettingsUpdate(garbage)
      expect(sanitized.provider).toBe('genspark')
      expect(sanitized.providers.genspark.apiKey).toBe('')
      expect(sanitized.providers.custom.baseUrl).toBe('')
    }
  })

  it('cannot persist a non-genspark provider selection', () => {
    const sanitized = sanitizeRendererAiSettingsUpdate({
      provider: 'anthropic',
      providers: {
        anthropic: { apiKey: 'sk-x', model: 'claude-opus-4-7' },
      },
    } as Partial<AiSettings>)
    expect(sanitized.provider).toBe('genspark')
    expect(sanitized.providers.anthropic.apiKey).toBe('')
  })
})

describe('resolveMainOwnedAiConfig', () => {
  it('always selects genspark and reads the key from the supplied getter', () => {
    const stored = {
      provider: 'custom' as const,
      providers: {
        custom: {
          apiKey: 'sk-disk',
          model: 'x',
          baseUrl: 'https://evil.example/v1',
        },
        genspark: { apiKey: 'disk-key-must-not-win', model: 'gpt-5.2' },
      },
    } as Partial<AiSettings>

    const resolved = resolveMainOwnedAiConfig(stored, () => 'live-gsk-key')
    expect(resolved.provider).toBe('genspark')
    expect(resolved.config).toEqual({ apiKey: 'live-gsk-key', model: 'gpt-5.2' })
    // secrets/baseUrl from disk never appear on the runtime config
    expect(resolved.config).not.toHaveProperty('baseUrl')
  })

  it('falls back to the default Genspark model when stored model is unknown or missing', () => {
    const defaults = defaultAiSettings()
    expect(
      resolveMainOwnedAiConfig(
        { provider: 'genspark', providers: { genspark: { apiKey: '', model: 'nope' } } } as never,
        () => 'k',
      ).config.model,
    ).toBe(defaults.providers.genspark.model)

    expect(resolveMainOwnedAiConfig({}, () => 'k').config.model).toBe(
      defaults.providers.genspark.model,
    )
  })

  it('ignores legacy non-genspark provider selection when resolving runtime config', () => {
    const resolved = resolveMainOwnedAiConfig(
      {
        provider: 'openai',
        providers: {
          openai: { apiKey: 'sk-oai', model: 'gpt-4.1' },
          genspark: { apiKey: '', model: 'gemini-3-flash-preview' },
        },
      } as never,
      () => 'gsk',
    )
    expect(resolved.provider).toBe('genspark')
    expect(resolved.config.model).toBe('gemini-3-flash-preview')
    expect(resolved.config.apiKey).toBe('gsk')
  })
})
