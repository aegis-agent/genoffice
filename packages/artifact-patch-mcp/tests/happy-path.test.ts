import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { createArtifactPatchMcpServer } from '../src/server'
import { connectServer, installPairCleanup, withTempRoot } from './helpers/mcp-harness'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function twoParaDocx(): Promise<Uint8Array> {
  return buildDocx({
    bodyXml:
      '<w:p><w:r><w:t>Alpha one</w:t></w:r></w:p>' + '<w:p><w:r><w:t>Beta two</w:t></w:r></w:p>',
  })
}

function isErrorResult(result: { isError?: boolean }): boolean {
  return result.isError === true
}

describe('inspect → preview → apply happy path', () => {
  const cleanup = installPairCleanup()

  it('inspects, previews without writing, then applies once with strict manifest', async () => {
    await withTempRoot(async (root) => {
      const sourceBytes = await twoParaDocx()
      const sourceHash = sha256(sourceBytes)
      await writeFile(join(root, 'source.docx'), sourceBytes)

      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const inspectResult = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'source.docx' },
      })
      expect(isErrorResult(inspectResult)).toBe(false)
      const inspection = inspectResult.structuredContent as {
        version: string
        source: { sha256: string; byteLength: number }
        blocks: Array<{ docxIndex: number; text: string; textReplaceSupported: boolean }>
      }
      expect(inspection.version).toBe('docx-inspection/v1')
      expect(inspection.source.sha256).toBe(sourceHash)
      const editable = inspection.blocks.filter((b) => b.textReplaceSupported)
      expect(editable.length).toBeGreaterThanOrEqual(2)
      const [a, b] = editable

      // Destination must not exist before apply.
      await expect(access(join(root, 'out.docx'))).rejects.toMatchObject({ code: 'ENOENT' })

      const previewResult = await pair.client.callTool({
        name: 'docx_preview_patch',
        arguments: {
          sourcePath: 'source.docx',
          destinationPath: 'out.docx',
          operations: [
            {
              op: 'replace_block_text',
              docxIndex: a.docxIndex,
              expectedText: a.text,
              replacementText: 'Alpha ONE',
            },
            {
              op: 'replace_block_text',
              docxIndex: b.docxIndex,
              expectedText: b.text,
              replacementText: 'Beta TWO',
            },
          ],
        },
      })
      expect(isErrorResult(previewResult)).toBe(false)
      const preview = previewResult.structuredContent as {
        confirmationRef: string
        expiresAt: string
        proposal: { id: string }
        destinationPath: string
        sourcePath: string
      }
      expect(preview.sourcePath).toBe('source.docx')
      expect(preview.destinationPath).toBe('out.docx')
      expect(preview.confirmationRef.length).toBeGreaterThanOrEqual(16)
      expect(preview.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      // Still no destination write after preview.
      await expect(access(join(root, 'out.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
      const sourceAfterPreview = await readFile(join(root, 'source.docx'))
      expect(sha256(sourceAfterPreview)).toBe(sourceHash)

      const appliedAt = '2026-08-03T18:00:00.000Z'
      const applyResult = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview.confirmationRef,
          proposalId: preview.proposal.id,
          appliedAt,
        },
      })
      expect(isErrorResult(applyResult)).toBe(false)
      const applied = applyResult.structuredContent as {
        destinationPath: string
        manifest: {
          version: string
          proposalId: string
          appliedAt: string
          source: { sha256: string }
          output: { sha256: string; byteLength: number }
          roundtrip: { ok: boolean }
        }
      }
      expect(applied.destinationPath).toBe('out.docx')
      expect(applied.manifest.version).toBe('docx-provenance/v1')
      expect(applied.manifest.proposalId).toBe(preview.proposal.id)
      expect(applied.manifest.appliedAt).toBe(appliedAt)
      expect(applied.manifest.source.sha256).toBe(sourceHash)
      expect(applied.manifest.roundtrip.ok).toBe(true)

      // Never returns absolute paths.
      const appliedJson = JSON.stringify(applied)
      expect(appliedJson).not.toContain(root)
      expect(applied.destinationPath.startsWith('/')).toBe(false)

      const sourceAfter = await readFile(join(root, 'source.docx'))
      expect(sha256(sourceAfter)).toBe(sourceHash)
      const destBytes = await readFile(join(root, 'out.docx'))
      expect(sha256(destBytes)).toBe(applied.manifest.output.sha256)
      expect(destBytes.byteLength).toBe(applied.manifest.output.byteLength)
    })
  })

  it('supports nested relative destination under existing parents', async () => {
    await withTempRoot(async (root) => {
      await mkdir(join(root, 'nested', 'dir'), { recursive: true })
      const sourceBytes = await twoParaDocx()
      await writeFile(join(root, 'nested', 'src.docx'), sourceBytes)

      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const inspectResult = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'nested/src.docx' },
      })
      const inspection = inspectResult.structuredContent as {
        blocks: Array<{ docxIndex: number; text: string; textReplaceSupported: boolean }>
      }
      const a = inspection.blocks.find((b) => b.textReplaceSupported)!

      const previewResult = await pair.client.callTool({
        name: 'docx_preview_patch',
        arguments: {
          sourcePath: 'nested/src.docx',
          destinationPath: 'nested/dir/out.docx',
          operations: [
            {
              op: 'replace_block_text',
              docxIndex: a.docxIndex,
              expectedText: a.text,
              replacementText: 'Changed',
            },
          ],
        },
      })
      const preview = previewResult.structuredContent as {
        confirmationRef: string
        proposal: { id: string }
      }
      const applyResult = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview.confirmationRef,
          proposalId: preview.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(isErrorResult(applyResult)).toBe(false)
      await access(join(root, 'nested', 'dir', 'out.docx'))
    })
  })
})
