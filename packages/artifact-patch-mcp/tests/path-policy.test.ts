import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { createArtifactPatchMcpServer } from '../src/server'
import { resolveArtifactRoot } from '../src/path-policy'
import { connectServer, installPairCleanup, withTempRoot } from './helpers/mcp-harness'

async function simpleDocx(): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>',
  })
}

function errorCode(result: { isError?: boolean; structuredContent?: unknown }): string {
  expect(result.isError).toBe(true)
  const sc = result.structuredContent as { code: string; message: string }
  expect(sc.code).toBeTruthy()
  return sc.code
}

function leakCheck(result: unknown, root: string, sentinels: string[]): void {
  const text = JSON.stringify(result)
  expect(text).not.toContain(root)
  for (const s of sentinels) {
    expect(text).not.toContain(s)
  }
}

describe('path capability policy', () => {
  const cleanup = installPairCleanup()

  it('rejects absolute, traversal, backslash, drive, and non-docx paths', async () => {
    await withTempRoot(async (root) => {
      await writeFile(join(root, 'ok.docx'), await simpleDocx())
      await writeFile(join(root, 'foo\\bar.docx'), await simpleDocx())
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const badPaths = [
        '/etc/passwd.docx',
        root + '/ok.docx',
        '../ok.docx',
        'foo/../ok.docx',
        './ok.docx',
        'foo\\bar.docx',
        'C:\\temp\\x.docx',
        'C:/temp/x.docx',
        'ok.txt',
        'ok.docx.exe',
        'has\0null.docx',
      ]

      for (const sourcePath of badPaths) {
        const result = await pair.client.callTool({
          name: 'docx_inspect',
          arguments: { sourcePath },
        })
        expect(errorCode(result)).toBe('ROOT_POLICY_VIOLATION')
        leakCheck(result, root, ['EACCES', 'ENOENT', 'passwd'])
      }

      // Empty string fails input schema before handler.
      const empty = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: '' },
      })
      expect(empty.isError).toBe(true)
      leakCheck(empty, root, [])

      const actualNul = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'has\0null.docx' },
      })
      expect(errorCode(actualNul)).toBe('ROOT_POLICY_VIOLATION')
      leakCheck(actualNul, root, [])
    })
  })

  it('rejects a symlink supplied as the artifact root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ap-mcp-root-policy-'))
    try {
      const realRoot = join(parent, 'real-root')
      const linkedRoot = join(parent, 'linked-root')
      await mkdir(realRoot)
      await symlink(realRoot, linkedRoot)
      await expect(resolveArtifactRoot(linkedRoot)).rejects.toMatchObject({
        code: 'ROOT_POLICY_VIOLATION',
      })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects source symlink, parent symlink, dangling destination symlink, and existing destination', async () => {
    await withTempRoot(async (root) => {
      const bytes = await simpleDocx()
      await writeFile(join(root, 'real.docx'), bytes)
      await mkdir(join(root, 'subdir'))
      await symlink(join(root, 'real.docx'), join(root, 'link.docx'))
      await symlink(join(root, 'subdir'), join(root, 'linkdir'))
      await symlink(join(root, 'missing-target.docx'), join(root, 'dangling.docx'))
      await writeFile(join(root, 'exists.docx'), bytes)

      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const sourceLink = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'link.docx' },
      })
      expect(errorCode(sourceLink)).toBe('ROOT_POLICY_VIOLATION')
      leakCheck(sourceLink, root, [])

      // Parent symlink for destination
      const parentSym = await pair.client.callTool({
        name: 'docx_preview_patch',
        arguments: {
          sourcePath: 'real.docx',
          destinationPath: 'linkdir/out.docx',
          operations: [
            {
              op: 'replace_block_text',
              docxIndex: 0,
              expectedText: 'Hello',
              replacementText: 'Hi',
            },
          ],
        },
      })
      expect(errorCode(parentSym)).toBe('ROOT_POLICY_VIOLATION')

      const dangling = await pair.client.callTool({
        name: 'docx_preview_patch',
        arguments: {
          sourcePath: 'real.docx',
          destinationPath: 'dangling.docx',
          operations: [
            {
              op: 'replace_block_text',
              docxIndex: 0,
              expectedText: 'Hello',
              replacementText: 'Hi',
            },
          ],
        },
      })
      expect(errorCode(dangling)).toBe('ROOT_POLICY_VIOLATION')

      const exists = await pair.client.callTool({
        name: 'docx_preview_patch',
        arguments: {
          sourcePath: 'real.docx',
          destinationPath: 'exists.docx',
          operations: [
            {
              op: 'replace_block_text',
              docxIndex: 0,
              expectedText: 'Hello',
              replacementText: 'Hi',
            },
          ],
        },
      })
      expect(errorCode(exists)).toBe('DESTINATION_EXISTS')
      leakCheck(exists, root, [])
    })
  })
})
