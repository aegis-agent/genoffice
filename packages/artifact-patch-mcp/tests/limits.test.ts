import { truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_EXPECTED_TEXT_CHARS, MAX_REPLACEMENT_TEXT_CHARS } from '@genoffice/artifact-patch'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { ArtifactPatchMcpError } from '../src/errors'
import {
  DEFAULT_MCP_MAX_COMPRESSED_BYTES,
  MAX_INSPECTION_BLOCKS,
  MAX_INSPECTION_TEXT_CHARS,
  MAX_MCP_MAX_COMPRESSED_BYTES,
  MAX_PATCH_OPERATIONS,
  MAX_PROPOSAL_TEXT_CHARS,
  enforceInspectionBudget,
  readSourceBytesWithinLimit,
} from '../src/limits'
import { createArtifactPatchMcpServer } from '../src/server'
import { docxInspectInputSchema, docxPreviewPatchInputSchema } from '../src/schemas'
import { connectServer, installPairCleanup, withTempRoot } from './helpers/mcp-harness'

describe('MCP resource limits', () => {
  const cleanup = installPairCleanup()

  it('uses a bounded compressed-input default and hard ceiling', () => {
    expect(DEFAULT_MCP_MAX_COMPRESSED_BYTES).toBe(16 * 1024 * 1024)
    expect(MAX_MCP_MAX_COMPRESSED_BYTES).toBe(64 * 1024 * 1024)
    expect(
      docxInspectInputSchema.safeParse({
        sourcePath: 'source.docx',
        maxCompressedBytes: MAX_MCP_MAX_COMPRESSED_BYTES + 1,
      }).success,
    ).toBe(false)
  })

  it('caps the number of patch operations', () => {
    const operation = {
      op: 'replace_block_text' as const,
      docxIndex: 0,
      expectedText: 'a',
      replacementText: 'b',
    }
    const result = docxPreviewPatchInputSchema.safeParse({
      sourcePath: 'source.docx',
      destinationPath: 'out.docx',
      operations: Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, () => operation),
    })
    expect(result.success).toBe(false)
  })

  it('rejects oversized inspection block and text aggregates', () => {
    const base = {
      version: 'docx-inspection/v1' as const,
      source: { sha256: 'a'.repeat(64), byteLength: 1 },
    }
    expect(() =>
      enforceInspectionBudget({
        ...base,
        blocks: Array.from({ length: MAX_INSPECTION_BLOCKS + 1 }, (_, docxIndex) => ({
          docxIndex,
          type: 'paragraph' as const,
          text: '',
          textReplaceSupported: true,
        })),
      }),
    ).toThrow(ArtifactPatchMcpError)

    expect(() =>
      enforceInspectionBudget({
        ...base,
        blocks: [
          {
            docxIndex: 0,
            type: 'paragraph' as const,
            text: 'x'.repeat(MAX_INSPECTION_TEXT_CHARS + 1),
            textReplaceSupported: true,
          },
        ],
      }),
    ).toThrow(ArtifactPatchMcpError)
  })

  it('rejects oversized files before returning source bytes', async () => {
    await withTempRoot(async (root) => {
      const source = join(root, 'oversized.docx')
      await writeFile(source, '')
      await truncate(source, DEFAULT_MCP_MAX_COMPRESSED_BYTES + 1)

      await expect(
        readSourceBytesWithinLimit(source, DEFAULT_MCP_MAX_COMPRESSED_BYTES),
      ).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' })
    })
  })

  it('enforces the default compressed cap through the MCP handler', async () => {
    await withTempRoot(async (root) => {
      const source = join(root, 'oversized.docx')
      await writeFile(source, '')
      await truncate(source, DEFAULT_MCP_MAX_COMPRESSED_BYTES + 1)
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const result = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'oversized.docx' },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'INPUT_TOO_LARGE' })
    })
  })

  it('rejects a source replaced with an oversized file after preview and before apply', async () => {
    await withTempRoot(async (root) => {
      const source = join(root, 'source.docx')
      const bytes = await buildDocx({
        bodyXml: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>',
      })
      await writeFile(source, bytes)
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const previewResult = await pair.client.callTool({
        name: 'docx_preview_patch',
        arguments: {
          sourcePath: 'source.docx',
          destinationPath: 'out.docx',
          operations: [
            {
              op: 'replace_block_text',
              docxIndex: 0,
              expectedText: 'Hello',
              replacementText: 'Goodbye',
            },
          ],
        },
      })
      expect(previewResult.isError).not.toBe(true)
      const preview = previewResult.structuredContent as {
        confirmationRef: string
        proposal: { id: string }
      }

      await truncate(source, DEFAULT_MCP_MAX_COMPRESSED_BYTES + 1)

      const applyResult = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview.confirmationRef,
          proposalId: preview.proposal.id,
          appliedAt: '2026-08-03T00:00:00.000Z',
        },
      })
      expect(applyResult.isError).toBe(true)
      expect(applyResult.structuredContent).toMatchObject({ code: 'INPUT_TOO_LARGE' })
      expect(JSON.stringify(applyResult)).not.toContain(root)
    })
  })

  it('enforces the aggregate inspection-text cap through the MCP handler', async () => {
    await withTempRoot(async (root) => {
      const bytes = await buildDocx({
        bodyXml: `<w:p><w:r><w:t>${'x'.repeat(MAX_INSPECTION_TEXT_CHARS + 1)}</w:t></w:r></w:p>`,
      })
      await writeFile(join(root, 'huge-text.docx'), bytes)
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const result = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'huge-text.docx' },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'INPUT_TOO_LARGE' })
    })
  })

  it('rejects over-budget proposal text in the preview input schema', () => {
    expect(MAX_PROPOSAL_TEXT_CHARS).toBe(262_144)
    // Stay within per-field caps while exceeding the aggregate proposal budget.
    const perField = Math.min(MAX_EXPECTED_TEXT_CHARS, MAX_REPLACEMENT_TEXT_CHARS)
    const opsNeeded = Math.ceil((MAX_PROPOSAL_TEXT_CHARS + 1) / (perField * 2))
    const operations = Array.from(
      { length: Math.min(opsNeeded, MAX_PATCH_OPERATIONS) },
      (_, i) => ({
        op: 'replace_block_text' as const,
        docxIndex: i,
        expectedText: 'e'.repeat(perField),
        replacementText: 'r'.repeat(perField),
      }),
    )
    // Ensure we actually exceed the aggregate with the constructed ops.
    const total = operations.reduce(
      (n, op) => n + op.expectedText.length + op.replacementText.length,
      0,
    )
    expect(total).toBeGreaterThan(MAX_PROPOSAL_TEXT_CHARS)

    const result = docxPreviewPatchInputSchema.safeParse({
      sourcePath: 'source.docx',
      destinationPath: 'out.docx',
      operations,
    })
    expect(result.success).toBe(false)
  })

  it('rejects over-budget proposal text through MCP without leaking paths', async () => {
    await withTempRoot(async (root) => {
      const bytes = await buildDocx({
        bodyXml: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>',
      })
      await writeFile(join(root, 'source.docx'), bytes)
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const perField = Math.min(MAX_EXPECTED_TEXT_CHARS, MAX_REPLACEMENT_TEXT_CHARS)
      const opsNeeded = Math.ceil((MAX_PROPOSAL_TEXT_CHARS + 1) / (perField * 2))
      const operations = Array.from(
        { length: Math.min(opsNeeded, MAX_PATCH_OPERATIONS) },
        (_, i) => ({
          op: 'replace_block_text' as const,
          docxIndex: i,
          expectedText: 'e'.repeat(perField),
          replacementText: 'r'.repeat(perField),
        }),
      )

      try {
        const result = await pair.client.callTool({
          name: 'docx_preview_patch',
          arguments: {
            sourcePath: 'source.docx',
            destinationPath: 'out.docx',
            operations,
          },
        })
        // If the SDK surfaces schema failures as tool errors, still require no path leak.
        expect(JSON.stringify(result)).not.toContain(root)
        expect(JSON.stringify(result)).not.toMatch(/\/home\/|\/tmp\//)
      } catch (err) {
        // Standard MCP InvalidParams path for schema-invalid input.
        const payload = JSON.stringify(err, Object.getOwnPropertyNames(err as object))
        expect(payload).not.toContain(root)
        expect(payload).not.toMatch(/ENOENT|EACCES|\/home\/|\/tmp\//)
        expect(String(err)).toMatch(/Invalid|invalid|params|schema|MCP/i)
      }
    })
  })
})
