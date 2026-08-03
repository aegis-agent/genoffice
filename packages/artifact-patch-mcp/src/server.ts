import {
  applyDocxPatchToCopy,
  createDocxPatchProposal,
  inspectDocx,
  previewDocxPatch,
  type ApplyDocxPatchToCopyFs,
  type DocxInspection,
  type DocxPatchProposal,
} from '@genoffice/artifact-patch'
import { McpServer } from '@modelcontextprotocol/server'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { ConfirmationStore, type ConfirmationStoreOptions } from './confirmation-store'
import { ArtifactPatchMcpError, toolErrorResult } from './errors'
import {
  DEFAULT_MCP_MAX_COMPRESSED_BYTES,
  assertDocxZipPreflight,
  enforceInspectionBudget,
  readSourceBytesWithinLimit,
} from './limits'
import {
  resolveArtifactRoot,
  resolveDestinationDocxPath,
  resolveSourceDocxPath,
} from './path-policy'
import {
  docxApplyPatchToCopyInputSchema,
  docxApplyPatchToCopyOutputSchema,
  docxInspectInputSchema,
  docxInspectOutputSchema,
  docxPreviewPatchInputSchema,
  docxPreviewPatchOutputSchema,
} from './schemas'

export interface CreateArtifactPatchMcpServerOptions extends ConfirmationStoreOptions {
  /** Explicit absolute artifact root directory. Required; no cwd/home fallback. */
  artifactRoot: string
}

export interface ArtifactPatchMcpServerHandle {
  server: McpServer
  confirmationStore: ConfirmationStore
  canonicalRoot: string
}

function successResult<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  }
}

/**
 * Create an MCP server bound to an explicit absolute artifact root.
 * Validates the root (must exist as a real directory) before registering tools.
 */
export async function createArtifactPatchMcpServer(
  options: CreateArtifactPatchMcpServerOptions,
): Promise<ArtifactPatchMcpServerHandle> {
  const { canonicalRoot } = await resolveArtifactRoot(options.artifactRoot)
  return buildServer(canonicalRoot, options)
}

/** @deprecated alias — prefer createArtifactPatchMcpServer */
export const createArtifactPatchMcpServerAsync = createArtifactPatchMcpServer

function buildServer(
  canonicalRoot: string,
  options: CreateArtifactPatchMcpServerOptions,
): ArtifactPatchMcpServerHandle {
  const confirmationStore = new ConfirmationStore(options)
  const server = new McpServer(
    { name: 'genoffice-artifact-patch', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool(
    'docx_inspect',
    {
      title: 'Inspect DOCX',
      description:
        'Read-only inspection of a root-relative .docx under the configured artifact root.',
      inputSchema: docxInspectInputSchema,
      outputSchema: docxInspectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const source = await resolveSourceDocxPath(canonicalRoot, args.sourcePath)
        const maxCompressedBytes = args.maxCompressedBytes ?? DEFAULT_MCP_MAX_COMPRESSED_BYTES
        const bytes = await readSourceBytesWithinLimit(source.absolutePath, maxCompressedBytes)
        assertDocxZipPreflight(bytes)
        const inspection = await inspectDocx(bytes, {
          maxCompressedBytes,
        })
        enforceInspectionBudget(inspection)
        const output = docxInspectOutputSchema.parse(inspection)
        return successResult(output)
      } catch (err) {
        return toolErrorResult(err)
      }
    },
  )

  server.registerTool(
    'docx_preview_patch',
    {
      title: 'Preview DOCX patch',
      description:
        'Preview replace_block_text operations against a source DOCX and bind a short-lived confirmation to a non-existing destination copy path. Does not write files.',
      inputSchema: docxPreviewPatchInputSchema,
      outputSchema: docxPreviewPatchOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const source = await resolveSourceDocxPath(canonicalRoot, args.sourcePath)
        const destination = await resolveDestinationDocxPath(canonicalRoot, args.destinationPath)
        if (source.absolutePath === destination.absolutePath) {
          throw new ArtifactPatchMcpError('SAME_PATH', 'source and destination paths must differ')
        }
        const maxCompressedBytes = args.maxCompressedBytes ?? DEFAULT_MCP_MAX_COMPRESSED_BYTES
        const bytes = await readSourceBytesWithinLimit(source.absolutePath, maxCompressedBytes)
        assertDocxZipPreflight(bytes)
        const inspection: DocxInspection = await inspectDocx(bytes, {
          maxCompressedBytes,
        })
        enforceInspectionBudget(inspection)
        const proposal: DocxPatchProposal = createDocxPatchProposal(inspection, {
          source: inspection.source,
          operations: args.operations,
        })
        const preview = previewDocxPatch(proposal, inspection)
        const { confirmationRef, expiresAt } = confirmationStore.put({
          sourceRelativePath: source.relativePath,
          destinationRelativePath: destination.relativePath,
          proposal,
          maxCompressedBytes,
        })

        const output = docxPreviewPatchOutputSchema.parse({
          sourcePath: source.relativePath,
          destinationPath: destination.relativePath,
          source: inspection.source,
          proposal,
          preview,
          confirmationRef,
          expiresAt,
        })
        return successResult(output)
      } catch (err) {
        return toolErrorResult(err)
      }
    },
  )

  server.registerTool(
    'docx_apply_patch_to_copy',
    {
      title: 'Apply DOCX patch to copy',
      description:
        'Atomically consume a destination-bound confirmation and apply the server-owned proposal to a new copy. Paths cannot be redirected at apply time.',
      inputSchema: docxApplyPatchToCopyInputSchema,
      outputSchema: docxApplyPatchToCopyOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        // Consume before apply — mismatch/failure cannot reuse the ref.
        const record = confirmationStore.consume(args.confirmationRef, args.proposalId)

        // Re-run path policy at apply time.
        const source = await resolveSourceDocxPath(canonicalRoot, record.sourceRelativePath)
        const destination = await resolveDestinationDocxPath(
          canonicalRoot,
          record.destinationRelativePath,
        )

        const maxCompressedBytes = record.maxCompressedBytes ?? DEFAULT_MCP_MAX_COMPRESSED_BYTES

        // Preserve the MCP-level error code before entering the lower runtime, which intentionally
        // sanitizes injected filesystem read failures to IO_ERROR.
        const confirmedSourceBytes = await readSourceBytesWithinLimit(
          source.absolutePath,
          maxCompressedBytes,
        )
        assertDocxZipPreflight(confirmedSourceBytes)

        // The transactional runtime reads both source and published destination through its
        // injected filesystem capability. Bound and preflight the exact bytes returned by every
        // read so there is no unbounded second read after MCP-layer validation.
        const boundedFs: ApplyDocxPatchToCopyFs = {
          open,
          link,
          unlink,
          lstat,
          realpath,
          readFile: async (absolutePath) => {
            const bytes = await readSourceBytesWithinLimit(absolutePath, maxCompressedBytes)
            assertDocxZipPreflight(bytes)
            return bytes
          },
        }

        const result = await applyDocxPatchToCopy(
          {
            sourcePath: source.absolutePath,
            destinationPath: destination.absolutePath,
            proposal: record.proposal,
            appliedAt: args.appliedAt,
            maxCompressedBytes: record.maxCompressedBytes,
          },
          boundedFs,
        )

        const output = docxApplyPatchToCopyOutputSchema.parse({
          destinationPath: record.destinationRelativePath,
          manifest: result.manifest,
        })
        return successResult(output)
      } catch (err) {
        return toolErrorResult(err)
      }
    },
  )

  return { server, confirmationStore, canonicalRoot }
}

export { resolveArtifactRoot }
