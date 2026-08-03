import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { DocxInspection, DocxPatchProposal } from '@genoffice/artifact-patch'
import { ArtifactPatchMcpError } from './errors'

export const DEFAULT_MCP_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024
export const MAX_MCP_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
export const MAX_PATCH_OPERATIONS = 64
export const MAX_INSPECTION_BLOCKS = 10_000
export const MAX_INSPECTION_TEXT_CHARS = 1_000_000

/** Per-proposal retained text budget (sum of expectedText + replacementText lengths). */
export const MAX_PROPOSAL_TEXT_CHARS = 262_144

/** Aggregate pending confirmation text-character budget across all records. */
export const MAX_PENDING_CONFIRMATION_TEXT_CHARS = 1_048_576

const READ_CHUNK_BYTES = 64 * 1024

export {
  MAX_DOCX_ZIP_ENTRIES,
  MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_DOCX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  assertDocxZipPreflight,
} from './docx-zip-preflight'

/** Count characters retained when a proposal is held in the confirmation store. */
export function proposalRetainedTextChars(proposal: DocxPatchProposal): number {
  let total = 0
  for (const op of proposal.operations) {
    total += op.expectedText.length + op.replacementText.length
  }
  return total
}

/**
 * Read a regular source file through a bounded descriptor.
 * The size check happens before allocation, and the read loop never consumes
 * more than maxCompressedBytes + 1 even if a same-UID process grows the file.
 */
export async function readSourceBytesWithinLimit(
  absolutePath: string,
  maxCompressedBytes: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maxCompressedBytes) ||
    maxCompressedBytes <= 0 ||
    maxCompressedBytes > MAX_MCP_MAX_COMPRESSED_BYTES
  ) {
    throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'source byte cap is invalid')
  }

  let handle
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP') {
      throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'source symlink is not allowed')
    }
    throw new ArtifactPatchMcpError('IO_ERROR', 'failed to open source')
  }

  try {
    const st = await handle.stat()
    if (!st.isFile()) {
      throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'source must be a regular file')
    }
    if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > maxCompressedBytes) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'compressed input exceeds MCP cap')
    }

    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxCompressedBytes) {
      const remaining = maxCompressedBytes + 1 - total
      if (remaining === 0) break
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > maxCompressedBytes) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'compressed input exceeds MCP cap')
    }
    return Buffer.concat(chunks, total)
  } catch (err) {
    if (err instanceof ArtifactPatchMcpError) throw err
    throw new ArtifactPatchMcpError('IO_ERROR', 'failed to read source')
  } finally {
    await handle.close()
  }
}

/** Bound successful MCP payloads independently of the lower-level DOCX parser limits. */
export function enforceInspectionBudget(inspection: DocxInspection): void {
  if (inspection.blocks.length > MAX_INSPECTION_BLOCKS) {
    throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'inspection contains too many blocks')
  }

  let textChars = 0
  for (const block of inspection.blocks) {
    textChars += block.text.length
    if (textChars > MAX_INSPECTION_TEXT_CHARS) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'inspection text exceeds MCP output cap')
    }
  }
}
