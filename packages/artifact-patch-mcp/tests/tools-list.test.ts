import { describe, expect, it } from 'vitest'
import { createArtifactPatchMcpServer } from '../src/server'
import { connectServer, installPairCleanup, withTempRoot } from './helpers/mcp-harness'

const EXPECTED_TOOLS = [
  {
    name: 'docx_inspect',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'docx_preview_patch',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'docx_apply_patch_to_copy',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const

describe('tools/list contract', () => {
  const cleanup = installPairCleanup()

  it('advertises exactly three tools with closed schemas and exact annotations', async () => {
    await withTempRoot(async (root) => {
      const { server } = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(server)
      cleanup.track(pair)

      const listed = await pair.client.listTools()
      expect(listed.tools.map((t) => t.name).sort()).toEqual(
        EXPECTED_TOOLS.map((t) => t.name)
          .slice()
          .sort(),
      )
      expect(listed.tools).toHaveLength(3)

      for (const expected of EXPECTED_TOOLS) {
        const tool = listed.tools.find((t) => t.name === expected.name)
        expect(tool, expected.name).toBeDefined()
        expect(tool!.annotations).toEqual(expected.annotations)
        expect(tool!.inputSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
        })
        expect(tool!.outputSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
        })
      }
    })
  })
})
