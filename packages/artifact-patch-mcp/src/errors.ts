import { ArtifactPatchError, type ArtifactPatchErrorCode } from '@genoffice/artifact-patch'
import { z } from 'zod'

/** Boundary error codes added by the MCP package (plus ArtifactPatchError codes). */
export type McpBoundaryErrorCode =
  | ArtifactPatchErrorCode
  | 'ROOT_POLICY_VIOLATION'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_MISMATCH'
  | 'INTERNAL_ERROR'

export class ArtifactPatchMcpError extends Error {
  readonly code: McpBoundaryErrorCode

  constructor(code: McpBoundaryErrorCode, message: string) {
    super(message)
    this.name = 'ArtifactPatchMcpError'
    this.code = code
  }
}

export const mcpErrorCodeSchema = z.enum([
  'INPUT_TOO_LARGE',
  'INVALID_DOCX',
  'INVALID_PROPOSAL',
  'DUPLICATE_ANCHOR',
  'CR_LF_REJECTED',
  'STALE_EXPECTED_TEXT',
  'ANCHOR_NOT_EDITABLE',
  'SOURCE_HASH_MISMATCH',
  'PROPOSAL_ID_MISMATCH',
  'SAME_PATH',
  'DESTINATION_EXISTS',
  'APPLY_FAILED',
  'ROUNDTRIP_FAILED',
  'PUBLICATION_FAILED',
  'IO_ERROR',
  'ROOT_POLICY_VIOLATION',
  'CONFIRMATION_REQUIRED',
  'CONFIRMATION_EXPIRED',
  'CONFIRMATION_MISMATCH',
  'INTERNAL_ERROR',
])

export const mcpErrorOutputSchema = z
  .object({
    code: mcpErrorCodeSchema,
    message: z.string().min(1).max(512),
  })
  .strict()

export type McpErrorOutput = z.infer<typeof mcpErrorOutputSchema>

const SAFE_MESSAGES: Record<McpBoundaryErrorCode, string> = {
  INPUT_TOO_LARGE: 'compressed input exceeds configured size cap',
  INVALID_DOCX: 'input is not a valid supported DOCX',
  INVALID_PROPOSAL: 'proposal failed validation',
  DUPLICATE_ANCHOR: 'duplicate docxIndex in operations',
  CR_LF_REJECTED: 'CR/LF is not allowed in expectedText or replacementText',
  STALE_EXPECTED_TEXT: 'expectedText does not match current source inspection',
  ANCHOR_NOT_EDITABLE: 'operation targets a non-editable anchor',
  SOURCE_HASH_MISMATCH: 'source content no longer matches the bound proposal',
  PROPOSAL_ID_MISMATCH: 'proposal id does not match canonical body',
  SAME_PATH: 'source and destination paths must differ',
  DESTINATION_EXISTS: 'destination already exists',
  APPLY_FAILED: 'apply failed',
  ROUNDTRIP_FAILED: 'roundtrip validation failed',
  PUBLICATION_FAILED: 'failed to publish destination copy',
  IO_ERROR: 'filesystem operation failed',
  ROOT_POLICY_VIOLATION: 'path failed root capability policy',
  CONFIRMATION_REQUIRED: 'a valid confirmation is required',
  CONFIRMATION_EXPIRED: 'confirmation expired',
  CONFIRMATION_MISMATCH: 'confirmation does not match the requested apply',
  INTERNAL_ERROR: 'internal error',
}

export function safeMessageFor(code: McpBoundaryErrorCode): string {
  return SAFE_MESSAGES[code]
}

/**
 * Map any thrown value to a stable boundary error.
 * Never forwards raw Node/dependency messages.
 */
export function mapToBoundaryError(err: unknown): ArtifactPatchMcpError {
  if (err instanceof ArtifactPatchMcpError) {
    return err
  }
  if (err instanceof ArtifactPatchError) {
    return new ArtifactPatchMcpError(err.code, safeMessageFor(err.code))
  }
  return new ArtifactPatchMcpError('INTERNAL_ERROR', safeMessageFor('INTERNAL_ERROR'))
}

export function toolErrorResult(err: unknown): {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: McpErrorOutput
  isError: true
} {
  const mapped = mapToBoundaryError(err)
  const structuredContent: McpErrorOutput = {
    code: mapped.code,
    message: safeMessageFor(mapped.code),
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  }
}
