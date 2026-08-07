import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, HERMES_LLM_BASE_URL, defaultAiSettings } from '../src/providers'
import {
  publicAiSettings,
  resolveMainOwnedAiConfig,
  sanitizeRendererAiSettingsUpdate,
} from '../src/main-owned-config'
import type { AiSettings } from '../src/types'

describe('publicAiSettings', () => {
  it('forces provider hermes and redacts every apiKey', () => {
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
    settings.providers.hermes.apiKey = 'should-not-leak'
    settings.providers.hermes.model = 'hermes-agent'

    const pub = publicAiSettings(settings)
    expect(pub.provider).toBe('hermes')
    for (const meta of AI_PROVIDERS) {
      expect(pub.providers[meta.id].apiKey).toBe('')
    }
    expect(pub.providers.custom.baseUrl).toBe('')
    expect(pub.providers.hermes.model).toBe('hermes-agent')
    expect(pub.providers.hermes.baseUrl).toBe(HERMES_LLM_BASE_URL)
    // never mutates the input
    expect(settings.providers.anthropic.apiKey).toBe('«redacted:sk-…»')
  })
})

describe('sanitizeRendererAiSettingsUpdate', () => {
  it('persists only an allowlisted Hermes model and clears secrets/baseUrl', () => {
    const malicious = {
      provider: 'custom',
      providers: {
        custom: {
          apiKey: 'stolen',
          model: 'attacker-model',
          baseUrl: 'https://attacker.example/v1',
        },
        hermes: { apiKey: 'leak-me', model: 'hermes-agent' },
        anthropic: { apiKey: 'also-leak', model: 'claude-opus-4-7' },
      },
    }

    const sanitized = sanitizeRendererAiSettingsUpdate(malicious)
    expect(sanitized.provider).toBe('hermes')
    expect(sanitized.providers.hermes.model).toBe('hermes-agent')
    for (const meta of AI_PROVIDERS) {
      expect(sanitized.providers[meta.id].apiKey).toBe('')
    }
    expect(sanitized.providers.custom.baseUrl).toBe('')
    expect(sanitized.providers.custom.model).toBe(defaultAiSettings().providers.custom.model)
  })

  it('rejects unknown Hermes models and falls back to the default', () => {
    const sanitized = sanitizeRendererAiSettingsUpdate({
      provider: 'hermes',
      providers: {
        hermes: { apiKey: 'x', model: 'not-a-real-model' },
      },
    })
    expect(sanitized.provider).toBe('hermes')
    expect(sanitized.providers.hermes.model).toBe(
      AI_PROVIDERS.find((p) => p.id === 'hermes')!.defaultModel,
    )
  })

  it('ignores non-object / garbage input and returns safe defaults', () => {
    for (const garbage of [null, undefined, 'x', 42, [], { provider: 'openai' }]) {
      const sanitized = sanitizeRendererAiSettingsUpdate(garbage)
      expect(sanitized.provider).toBe('hermes')
      expect(sanitized.providers.hermes.apiKey).toBe('')
      expect(sanitized.providers.custom.baseUrl).toBe('')
    }
  })

  it('cannot persist a non-hermes provider selection', () => {
    const sanitized = sanitizeRendererAiSettingsUpdate({
      provider: 'anthropic',
      providers: {
        anthropic: { apiKey: 'k', model: 'claude-opus-4-7' },
      },
    } as Partial<AiSettings>)
    expect(sanitized.provider).toBe('hermes')
    expect(sanitized.providers.anthropic.apiKey).toBe('')
  })
})

describe('resolveMainOwnedAiConfig', () => {
  it('always selects hermes and reads the key from the supplied getter', () => {
    const stored = {
      provider: 'custom' as const,
      providers: {
        custom: {
          apiKey: 'disk-custom',
          model: 'x',
          baseUrl: 'https://evil.example/v1',
        },
        hermes: { apiKey: 'disk-hermes', model: 'hermes-agent' },
      },
    } as Partial<AiSettings>

    const resolved = resolveMainOwnedAiConfig(stored, () => 'live-hermes-key')
    expect(resolved.provider).toBe('hermes')
    expect(resolved.config).toEqual({
      apiKey: 'live-hermes-key',
      model: 'hermes-agent',
      baseUrl: HERMES_LLM_BASE_URL,
    })
    // disk secrets never override the main-owned getter
    expect(resolved.config.apiKey).not.toBe('disk-hermes')
  })

  it('falls back to the default Hermes model when stored model is unknown or missing', () => {
    const defaults = defaultAiSettings()
    expect(
      resolveMainOwnedAiConfig(
        { provider: 'hermes', providers: { hermes: { apiKey: '', model: 'nope' } } } as never,
        () => 'k',
      ).config.model,
    ).toBe(defaults.providers.hermes.model)

    expect(resolveMainOwnedAiConfig({}, () => 'k').config.model).toBe(
      defaults.providers.hermes.model,
    )
  })

  it('ignores legacy non-hermes provider selection when resolving runtime config', () => {
    const resolved = resolveMainOwnedAiConfig(
      {
        provider: 'openai',
        providers: {
          openai: { apiKey: 'oai', model: 'gpt-4.1' },
          hermes: { apiKey: '', model: 'hermes-agent' },
        },
      } as never,
      () => 'hermes-key',
    )
    expect(resolved.provider).toBe('hermes')
    expect(resolved.config.model).toBe('hermes-agent')
    expect(resolved.config.apiKey).toBe('hermes-key')
    expect(resolved.config.baseUrl).toBe(HERMES_LLM_BASE_URL)
  })
})
