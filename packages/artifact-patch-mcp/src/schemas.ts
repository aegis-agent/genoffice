import {
  MAX_EXPECTED_TEXT_CHARS,
  MAX_REPLACEMENT_TEXT_CHARS,
  docxProvenanceManifestSchema,
} from '@genoffice/artifact-patch'
import { z } from 'zod'
import {
  DEFAULT_MCP_MAX_COMPRESSED_BYTES,
  MAX_MCP_MAX_COMPRESSED_BYTES,
  MAX_PATCH_OPERATIONS,
  MAX_PROPOSAL_TEXT_CHARS,
} from './limits'
import { MAX_RELATIVE_PATH_CHARS } from './path-policy'
import { mcpErrorOutputSchema } from './errors'

/** Relative root path string — shape only; semantic policy enforced in path-policy. */
export const relativeDocxPathSchema = z
  .string()
  .min(1)
  .max(MAX_RELATIVE_PATH_CHARS)
  .describe('Root-relative path to a .docx under the configured artifact root')

export const maxCompressedBytesSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_MCP_MAX_COMPRESSED_BYTES)
  .optional()
  .describe(`Optional compressed size cap (default ${DEFAULT_MCP_MAX_COMPRESSED_BYTES})`)

export const replaceBlockTextOpInputSchema = z
  .object({
    op: z.literal('replace_block_text'),
    docxIndex: z.number().int().nonnegative(),
    expectedText: z.string().max(MAX_EXPECTED_TEXT_CHARS),
    replacementText: z.string().max(MAX_REPLACEMENT_TEXT_CHARS),
  })
  .strict()

const sourceBindingSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
  })
  .strict()

const inspectedBlockSchema = z
  .object({
    docxIndex: z.number().int().nonnegative(),
    type: z.string(),
    text: z.string(),
    textReplaceSupported: z.boolean(),
  })
  .strict()

export const docxInspectInputSchema = z
  .object({
    sourcePath: relativeDocxPathSchema,
    maxCompressedBytes: maxCompressedBytesSchema,
  })
  .strict()

export const docxInspectOutputSchema = z
  .object({
    version: z.literal('docx-inspection/v1'),
    source: sourceBindingSchema,
    blocks: z.array(inspectedBlockSchema),
  })
  .strict()

const previewOperationsSchema = z
  .array(replaceBlockTextOpInputSchema)
  .min(1)
  .max(MAX_PATCH_OPERATIONS)
  .superRefine((operations, ctx) => {
    let total = 0
    for (const op of operations) {
      total += op.expectedText.length + op.replacementText.length
      if (total > MAX_PROPOSAL_TEXT_CHARS) {
        ctx.addIssue({
          code: 'custom',
          message: `proposal text exceeds ${MAX_PROPOSAL_TEXT_CHARS} characters`,
        })
        return
      }
    }
  })

export const docxPreviewPatchInputSchema = z
  .object({
    sourcePath: relativeDocxPathSchema,
    destinationPath: relativeDocxPathSchema,
    operations: previewOperationsSchema,
    maxCompressedBytes: maxCompressedBytesSchema,
  })
  .strict()

const proposalSchema = z
  .object({
    version: z.literal('docx-proposal/v1'),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    source: sourceBindingSchema,
    operations: z.array(replaceBlockTextOpInputSchema).min(1),
  })
  .strict()

const previewEntrySchema = z
  .object({
    docxIndex: z.number().int().nonnegative(),
    beforeText: z.string(),
    afterText: z.string(),
  })
  .strict()

export const docxPreviewPatchOutputSchema = z
  .object({
    sourcePath: z.string().min(1).max(MAX_RELATIVE_PATH_CHARS),
    destinationPath: z.string().min(1).max(MAX_RELATIVE_PATH_CHARS),
    source: sourceBindingSchema,
    proposal: proposalSchema,
    preview: z
      .object({
        proposalId: z.string().regex(/^[a-f0-9]{64}$/),
        entries: z.array(previewEntrySchema).min(1),
      })
      .strict(),
    confirmationRef: z.string().min(16).max(128),
    expiresAt: z.iso.datetime(),
  })
  .strict()

export const docxApplyPatchToCopyInputSchema = z
  .object({
    confirmationRef: z.string().min(1).max(128),
    proposalId: z.string().regex(/^[a-f0-9]{64}$/),
    appliedAt: z.iso.datetime(),
  })
  .strict()

export const docxApplyPatchToCopyOutputSchema = z
  .object({
    destinationPath: z.string().min(1).max(MAX_RELATIVE_PATH_CHARS),
    manifest: docxProvenanceManifestSchema,
  })
  .strict()

export { mcpErrorOutputSchema }
