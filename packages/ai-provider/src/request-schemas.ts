/**
 * Canonical runtime schemas for renderer→main AI IPC payloads.
 * Strict at every object boundary. Provider authority (provider/apiKey/baseUrl)
 * is never accepted on request or preference-update shapes.
 */
import { z } from 'zod'
import { HERMES_SESSION_ID_MAX, sanitizeHermesSessionId } from './hermes-session'
import type { AiChatRequest, AiStreamRequest } from './types'

// ── DoS-oriented bounds (keep legitimate tool/image payloads working) ─────

/** requestId is an opaque correlator from the renderer transport */
export const AI_REQUEST_ID_MAX = 128
/** system / user / message text caps — large enough for long docs context */
export const AI_TEXT_MAX = 1_000_000
export const AI_MESSAGES_MAX = 500
export const AI_TOOLS_MAX = 50
export const AI_IMAGES_PER_MESSAGE_MAX = 20
/** ~5 MiB binary → base64 expansion ≈ 4/3; leave headroom for padding */
export const AI_IMAGE_BASE64_MAX = 7_500_000
export const AI_IMAGE_MIME_MAX = 64
export const AI_TOOL_NAME_MAX = 128
export const AI_TOOL_DESCRIPTION_MAX = 16_384
export const AI_TOOL_OUTPUT_MAX = 1_000_000
export const AI_TOOL_CALL_ID_MAX = 128
export const AI_TOOL_INPUT_JSON_MAX = 200_000
export const AI_TOOL_SCHEMA_JSON_MAX = 50_000
export const AI_TOOL_SCHEMA_KEYS_MAX = 256
export const AI_MAX_TOKENS_MIN = 1
export const AI_MAX_TOKENS_MAX = 128_000
export const AI_MODEL_NAME_MAX = 128

function boundedJsonRecord(maxKeys: number, maxJsonChars: number) {
  return z.record(z.string().max(256), z.unknown()).superRefine((val, ctx) => {
    const keys = Object.keys(val)
    if (keys.length > maxKeys) {
      ctx.addIssue({ code: 'custom', message: 'too many keys' })
      return
    }
    let json: string
    try {
      json = JSON.stringify(val)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not json-serializable' })
      return
    }
    if (json.length > maxJsonChars) {
      ctx.addIssue({ code: 'custom', message: 'json too large' })
    }
  })
}

const agentImageSchema = z
  .object({
    base64: z.string().min(1).max(AI_IMAGE_BASE64_MAX),
    mime: z.string().min(1).max(AI_IMAGE_MIME_MAX),
  })
  .strict()

const agentToolCallSchema = z
  .object({
    id: z.string().min(1).max(AI_TOOL_CALL_ID_MAX),
    name: z.string().min(1).max(AI_TOOL_NAME_MAX),
    input: boundedJsonRecord(AI_TOOL_SCHEMA_KEYS_MAX, AI_TOOL_INPUT_JSON_MAX),
    inputError: z.string().max(AI_TOOL_DESCRIPTION_MAX).optional(),
  })
  .strict()

const agentToolResultSchema = z
  .object({
    id: z.string().min(1).max(AI_TOOL_CALL_ID_MAX),
    name: z.string().min(1).max(AI_TOOL_NAME_MAX),
    output: z.string().max(AI_TOOL_OUTPUT_MAX),
    isError: z.boolean().optional(),
  })
  .strict()

const agentMessageSchema = z.union([
  z
    .object({
      role: z.literal('user'),
      text: z.string().max(AI_TEXT_MAX),
      images: z.array(agentImageSchema).max(AI_IMAGES_PER_MESSAGE_MAX).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      text: z.string().max(AI_TEXT_MAX),
      toolCalls: z.array(agentToolCallSchema).max(AI_TOOLS_MAX).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      results: z.array(agentToolResultSchema).max(AI_TOOLS_MAX),
    })
    .strict(),
])

const agentToolDefSchema = z
  .object({
    name: z.string().min(1).max(AI_TOOL_NAME_MAX),
    description: z.string().max(AI_TOOL_DESCRIPTION_MAX),
    inputSchema: boundedJsonRecord(AI_TOOL_SCHEMA_KEYS_MAX, AI_TOOL_SCHEMA_JSON_MAX),
  })
  .strict()

/**
 * Optional session id on stream requests. Empty / overlong / CR-LF / unsafe
 * values are rejected at the schema boundary (not silently accepted for later
 * Fetch to mishandle). Callers may also pre-sanitize with sanitizeHermesSessionId.
 */
const sessionIdSchema = z
  .string()
  .min(1)
  .max(HERMES_SESSION_ID_MAX)
  .superRefine((val, ctx) => {
    if (sanitizeHermesSessionId(val) === undefined) {
      ctx.addIssue({ code: 'custom', message: 'unsafe hermes session id' })
    }
  })

/** One-shot chat request (no settings / provider authority). */
export const aiChatRequestSchema = z
  .object({
    system: z.string().max(AI_TEXT_MAX),
    user: z.string().max(AI_TEXT_MAX),
  })
  .strict()

/** Streaming agent request (no settings / provider authority). */
export const aiStreamRequestSchema = z
  .object({
    requestId: z.string().min(1).max(AI_REQUEST_ID_MAX),
    system: z.string().max(AI_TEXT_MAX),
    messages: z.array(agentMessageSchema).max(AI_MESSAGES_MAX),
    tools: z.array(agentToolDefSchema).max(AI_TOOLS_MAX).optional(),
    maxTokens: z.number().int().min(AI_MAX_TOKENS_MIN).max(AI_MAX_TOKENS_MAX).optional(),
    sessionId: sessionIdSchema.optional(),
  })
  .strict()

/**
 * Preference-only update for ai:set-settings.
 * Rejects provider/apiKey/baseUrl and any unknown keys rather than stripping.
 */
export const aiSettingsPreferencesUpdateSchema = z
  .object({
    providers: z
      .object({
        hermes: z
          .object({
            model: z.string().min(1).max(AI_MODEL_NAME_MAX),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

export type AiChatRequestParsed = z.infer<typeof aiChatRequestSchema>
export type AiStreamRequestParsed = z.infer<typeof aiStreamRequestSchema>
export type AiSettingsPreferencesUpdate = z.infer<typeof aiSettingsPreferencesUpdateSchema>

/** Prove schema output is assignable to the public request interfaces. */
export function asAiChatRequest(parsed: AiChatRequestParsed): AiChatRequest {
  return parsed
}

export function asAiStreamRequest(parsed: AiStreamRequestParsed): AiStreamRequest {
  const out: AiStreamRequest = {
    requestId: parsed.requestId,
    system: parsed.system,
    messages: parsed.messages,
  }
  if (parsed.tools !== undefined) out.tools = parsed.tools
  if (parsed.maxTokens !== undefined) out.maxTokens = parsed.maxTokens
  if (parsed.sessionId !== undefined) out.sessionId = parsed.sessionId
  return out
}

// ── Argument-tuple schemas for safeHandle ─────────────────────────────────

/** Local mirror of electron-utils RuntimeSchema — keeps packages decoupled. */
type TupleSchema<T extends readonly unknown[]> = { parse(input: unknown): T }

export const aiEmptyArgsSchema: TupleSchema<[]> = z.tuple([])

export const aiGskStatusArgsSchema: TupleSchema<[] | [boolean] | [undefined]> = z.union([
  z.tuple([]),
  z.tuple([z.boolean()]),
  z.tuple([z.undefined()]),
])

export const aiSetSettingsArgsSchema: TupleSchema<[AiSettingsPreferencesUpdate]> = z.tuple([
  aiSettingsPreferencesUpdateSchema,
])

export const aiChatArgsSchema: TupleSchema<[AiChatRequestParsed]> = z.tuple([aiChatRequestSchema])

export const aiStreamArgsSchema: TupleSchema<[AiStreamRequestParsed]> = z.tuple([
  aiStreamRequestSchema,
])

export const aiStreamCancelArgsSchema: TupleSchema<[string]> = z.tuple([
  z.string().min(1).max(AI_REQUEST_ID_MAX),
])
