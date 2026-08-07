import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'

export type AiProviderId =
  | 'hermes'
  | 'genspark'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'openai'
  | 'custom'

/** Genspark account status (gsk login state; the sole auth source for AI features) */
export interface GenSparkAccountStatus {
  loggedIn: boolean
  email?: string
}

export interface AiProviderConfig {
  apiKey: string
  model: string
  /** only used by the custom (OpenAI-compatible) provider */
  baseUrl?: string | undefined
}

export interface AiProviderMeta {
  id: AiProviderId
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
  /** default baseUrl when needsBaseUrl (e.g. the local Hermes gateway) */
  defaultBaseUrl?: string
}

export interface AiSettings {
  provider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
}

/** pre-provider settings shape (single OpenAI-compatible endpoint); migrated into "custom" */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
}

/**
 * Renderer→main one-shot chat request. Provider config and API keys are
 * main-owned and MUST NOT appear on this payload.
 */
export interface AiChatRequest {
  system: string
  user: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  error?: string
}

/**
 * Renderer→main streaming request. Provider config and API keys are
 * main-owned and MUST NOT appear on this payload.
 */
export interface AiStreamRequest {
  requestId: string
  system: string
  messages: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
  /**
   * Stable per-document conversation id (project-store chatId).
   * Sent as X-Hermes-Session-Id for Hermes gateway session continuity only.
   */
  sessionId?: string
}

export interface AiStreamChunk {
  requestId: string
  type: 'delta' | 'tool-call' | 'done' | 'error'
  text?: string
  /** complete parsed tool call (emitted once its arguments finish streaming) */
  toolCall?: AgentToolCall
  error?: string
}

/**
 * Explicit network-policy hook required for provider=custom. Fixed known
 * providers continue to use global fetch; custom must not silently do so.
 */
export type CustomProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface ProviderNetworkOptions {
  customFetch?: CustomProviderFetch
}
