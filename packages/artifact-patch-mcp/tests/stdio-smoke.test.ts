import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, describe, expect, it } from 'vitest'

const PKG_ROOT = join(import.meta.dirname, '..')
const REPO_ROOT = join(PKG_ROOT, '../..')
const CLI = join(PKG_ROOT, 'src/cli.ts')

describe('stdio child-process smoke', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!()
    }
  })

  it('lists tools over stdio with protocol-clean stdout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ap-mcp-stdio-'))
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const transport = new StdioClientTransport({
      command: join(REPO_ROOT, 'node_modules/.bin/tsx'),
      args: [CLI],
      env: {
        ...process.env,
        ARTIFACT_ROOT: root,
      },
      stderr: 'pipe',
    })
    const transportErrors: string[] = []
    transport.onerror = (error) => transportErrors.push(error.message)

    const client = new Client({ name: 'stdio-smoke', version: '0.0.0' })
    await client.connect(transport)
    cleanups.push(async () => {
      await client.close()
    })

    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      ['docx_apply_patch_to_copy', 'docx_inspect', 'docx_preview_patch'].sort(),
    )
    // The SDK's stdio parser reports any non-JSON-RPC stdout line through onerror.
    // A successful handshake alone is insufficient because the parser can continue after noise.
    expect(transportErrors).toEqual([])
  })
})
