import { AI_PROVIDERS, HERMES_LLM_BASE_URL, defaultAiSettings, resolveAiSettings } from './providers'
import type { AiProviderConfig, AiProviderId, AiSettings, LegacyAiSettings } from './types'

const HERMES_META = AI_PROVIDERS.find((p) => p.id === 'hermes')!

function allowlistedHermesModel(candidate: unknown): string {
  if (typeof candidate === 'string' && HERMES_META.models.includes(candidate)) {
    return candidate
  }
  return HERMES_META.defaultModel
}

/**
 * Settings shape safe to hand to a renderer or write without secrets.
 * Forces provider=hermes, blanks every apiKey, clears non-default custom baseUrl,
 * and exposes only the non-secret Hermes gateway default baseUrl.
 */
export function publicAiSettings(settings: AiSettings): AiSettings {
  const providers = {} as AiSettings['providers']
  for (const meta of AI_PROVIDERS) {
    const src = settings.providers[meta.id] ?? {
      apiKey: '',
      model: meta.defaultModel,
      baseUrl: meta.defaultBaseUrl ?? (meta.needsBaseUrl ? '' : undefined),
    }
    providers[meta.id] = {
      apiKey: '',
      model:
        meta.id === 'hermes'
          ? allowlistedHermesModel(src.model)
          : (src.model ?? meta.defaultModel),
      baseUrl:
        meta.id === 'hermes'
          ? (meta.defaultBaseUrl ?? HERMES_LLM_BASE_URL)
          : meta.needsBaseUrl
            ? ''
            : undefined,
    }
  }
  return { provider: 'hermes', providers }
}

/**
 * Sanitize a renderer-originated ai:set-settings payload for disk.
 * Preference-only: allowlisted Hermes model survives; provider/keys/baseUrl cannot.
 */
export function sanitizeRendererAiSettingsUpdate(input: unknown): AiSettings {
  const defaults = defaultAiSettings()
  let model = defaults.providers.hermes.model
  if (input && typeof input === 'object') {
    const obj = input as Partial<AiSettings> & {
      providers?: Partial<Record<AiProviderId, Partial<AiProviderConfig>>>
    }
    const candidate = obj.providers?.hermes?.model
    model = allowlistedHermesModel(candidate)
  }
  const out = defaultAiSettings()
  out.provider = 'hermes'
  out.providers.hermes.model = model
  for (const meta of AI_PROVIDERS) {
    out.providers[meta.id].apiKey = ''
    if (meta.id === 'hermes') {
      out.providers[meta.id].baseUrl = meta.defaultBaseUrl ?? HERMES_LLM_BASE_URL
    } else if (meta.needsBaseUrl) {
      out.providers[meta.id].baseUrl = ''
    }
  }
  return out
}

export interface MainOwnedAiConfig {
  provider: 'hermes'
  config: AiProviderConfig
}

/**
 * Resolve runtime AI config entirely in main. Provider is always hermes;
 * model comes from sanitized persisted Hermes preferences; API key comes
 * only from the supplied getter (main-owned — never renderer). baseUrl is
 * the local Hermes gateway default (non-secret loopback endpoint).
 */
export function resolveMainOwnedAiConfig(
  stored: Partial<AiSettings> & LegacyAiSettings,
  getApiKey: () => string,
): MainOwnedAiConfig {
  const resolved = resolveAiSettings(stored, defaultAiSettings())
  const model = allowlistedHermesModel(resolved.providers.hermes?.model)
  return {
    provider: 'hermes',
    config: {
      apiKey: getApiKey(),
      model,
      baseUrl: HERMES_LLM_BASE_URL,
    },
  }
}
