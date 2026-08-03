import { AI_PROVIDERS, defaultAiSettings, resolveAiSettings } from './providers'
import type { AiProviderConfig, AiProviderId, AiSettings, LegacyAiSettings } from './types'

const GENSPARK_META = AI_PROVIDERS.find((p) => p.id === 'genspark')!

function allowlistedGensparkModel(candidate: unknown): string {
  if (typeof candidate === 'string' && GENSPARK_META.models.includes(candidate)) {
    return candidate
  }
  return GENSPARK_META.defaultModel
}

/**
 * Settings shape safe to hand to a renderer or write without secrets.
 * Forces provider=genspark, blanks every apiKey, and clears custom baseUrl.
 */
export function publicAiSettings(settings: AiSettings): AiSettings {
  const providers = {} as AiSettings['providers']
  for (const meta of AI_PROVIDERS) {
    const src = settings.providers[meta.id] ?? {
      apiKey: '',
      model: meta.defaultModel,
      baseUrl: meta.needsBaseUrl ? '' : undefined,
    }
    providers[meta.id] = {
      apiKey: '',
      model:
        meta.id === 'genspark'
          ? allowlistedGensparkModel(src.model)
          : (src.model ?? meta.defaultModel),
      baseUrl: meta.needsBaseUrl ? '' : undefined,
    }
  }
  return { provider: 'genspark', providers }
}

/**
 * Sanitize a renderer-originated ai:set-settings payload for disk.
 * Preference-only: allowlisted Genspark model survives; provider/keys/baseUrl cannot.
 */
export function sanitizeRendererAiSettingsUpdate(input: unknown): AiSettings {
  const defaults = defaultAiSettings()
  let model = defaults.providers.genspark.model
  if (input && typeof input === 'object') {
    const obj = input as Partial<AiSettings> & {
      providers?: Partial<Record<AiProviderId, Partial<AiProviderConfig>>>
    }
    const candidate = obj.providers?.genspark?.model
    model = allowlistedGensparkModel(candidate)
  }
  const out = defaultAiSettings()
  out.provider = 'genspark'
  out.providers.genspark.model = model
  for (const meta of AI_PROVIDERS) {
    out.providers[meta.id].apiKey = ''
    if (meta.needsBaseUrl) out.providers[meta.id].baseUrl = ''
  }
  return out
}

export interface MainOwnedAiConfig {
  provider: 'genspark'
  config: AiProviderConfig
}

/**
 * Resolve runtime AI config entirely in main. Provider is always genspark;
 * model comes from sanitized persisted Genspark preferences; API key comes
 * only from the supplied getter (gskApiKey at the call site).
 */
export function resolveMainOwnedAiConfig(
  stored: Partial<AiSettings> & LegacyAiSettings,
  getApiKey: () => string,
): MainOwnedAiConfig {
  const resolved = resolveAiSettings(stored, defaultAiSettings())
  const model = allowlistedGensparkModel(resolved.providers.genspark?.model)
  return {
    provider: 'genspark',
    config: {
      apiKey: getApiKey(),
      model,
    },
  }
}
