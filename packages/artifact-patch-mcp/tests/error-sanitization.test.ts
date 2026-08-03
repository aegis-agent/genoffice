import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { createArtifactPatchMcpServer } from '../src/server'
import { connectServer, installPairCleanup, withTempRoot } from './helpers/mcp-harness'

describe('error sanitization', () => {
  const cleanup = installPairCleanup()

  it('never leaks root, absolute paths, or dependency sentinel text', async () => {
    await withTempRoot(async (root) => {
      const sentinel = 'DEP_SENTINEL_raw_node_message_XYZ'
      // invalid docx bytes that might surface parser text if leaked
      await writeFile(join(root, 'bad.docx'), Buffer.from(`not-a-docx-${sentinel}`))

      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const invalid = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'bad.docx' },
      })
      expect(invalid.isError).toBe(true)
      const payload = JSON.stringify(invalid)
      expect(payload).not.toContain(root)
      expect(payload).not.toContain(sentinel)
      expect(payload).not.toMatch(/\/home\/|\/tmp\/|\\\\/)
      const sc = invalid.structuredContent as { code: string; message: string }
      expect(sc.code).toBe('INVALID_DOCX')
      expect(sc.message).not.toContain(sentinel)

      const missing = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'nope.docx' },
      })
      expect(missing.isError).toBe(true)
      const missingJson = JSON.stringify(missing)
      expect(missingJson).not.toContain(root)
      expect(missingJson).not.toContain('ENOENT')

      // Valid inspect path shape but absolute
      const abs = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: join(root, 'bad.docx') },
      })
      expect(abs.isError).toBe(true)
      expect(JSON.stringify(abs)).not.toContain(root)
    })
  })

  it('returns structured error codes for invalid proposal ops', async () => {
    await withTempRoot(async (root) => {
      const bytes = await buildDocx({
        bodyXml: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>',
      })
      await writeFile(join(root, 'source.docx'), bytes)
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const result = await pair.client.callTool({
        name: 'docx_preview_patch',
        arguments: {
          sourcePath: 'source.docx',
          destinationPath: 'out.docx',
          operations: [
            {
              op: 'replace_block_text',
              docxIndex: 0,
              expectedText: 'WRONG',
              replacementText: 'X',
            },
          ],
        },
      })
      expect(result.isError).toBe(true)
      const sc = result.structuredContent as { code: string }
      expect(sc.code).toBe('STALE_EXPECTED_TEXT')
      expect(JSON.stringify(result)).not.toContain(root)
    })
  })

  it('schema-invalid input fails closed without absolute paths or raw filesystem errors', async () => {
    await withTempRoot(async (root) => {
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const cases: Array<Record<string, unknown>> = [
        // Wrong type for required string path.
        { sourcePath: 123 },
        // Missing required field.
        {},
        // Operations must be an array of objects.
        {
          sourcePath: 'source.docx',
          destinationPath: 'out.docx',
          operations: 'not-an-array',
        },
        // Negative size is schema-invalid.
        { sourcePath: 'source.docx', maxCompressedBytes: -1 },
      ]

      for (const args of cases) {
        const toolName = 'operations' in args ? 'docx_preview_patch' : 'docx_inspect'
        try {
          const result = await pair.client.callTool({
            name: toolName,
            arguments: args,
          })
          // Prefer InvalidParams throw; if surfaced as a result, still require no leaks.
          const payload = JSON.stringify(result)
          expect(payload).not.toContain(root)
          expect(payload).not.toMatch(/ENOENT|EACCES|ELOOP/)
          expect(payload).not.toMatch(/\/home\/|\/tmp\/|\\\\/)
          // Must not look like a successful structured handler error with absolute paths.
          if (result.structuredContent && typeof result.structuredContent === 'object') {
            const sc = result.structuredContent as { message?: string }
            if (typeof sc.message === 'string') {
              expect(sc.message).not.toContain(root)
            }
          }
        } catch (err) {
          const payload = JSON.stringify(err, Object.getOwnPropertyNames(err as object))
          expect(payload).not.toContain(root)
          expect(payload).not.toMatch(/ENOENT|EACCES|ELOOP/)
          expect(payload).not.toMatch(/\/home\/hermes|\/var\/|\\\\/)
        }
      }
    })
  })
})
