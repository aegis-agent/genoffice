/**
 * Quiet stdio MCP entry for trusted local hosts.
 *
 * Usage (from monorepo root or package dir):
 *   ARTIFACT_ROOT=/absolute/path/to/artifacts ./node_modules/.bin/tsx packages/artifact-patch-mcp/src/cli.ts
 *   npm run --silent start -w @genoffice/artifact-patch-mcp
 *
 * stdout is MCP JSON-RPC only. Diagnostics go to stderr.
 * Requires env ARTIFACT_ROOT = absolute existing directory.
 *
 * Same-UID filesystem races are out of scope: this is not a sandbox against
 * another process running as the same user.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createArtifactPatchMcpServer, resolveArtifactRoot } from './server'

function readArtifactRootFromEnv(): string {
  const root = process.env.ARTIFACT_ROOT
  if (!root || root.trim() === '') {
    console.error('ARTIFACT_ROOT is required and must be an absolute directory')
    process.exit(2)
  }
  return root
}

async function main(): Promise<void> {
  const artifactRoot = readArtifactRootFromEnv()
  // Fail closed on bad root before opening the stdio transport.
  await resolveArtifactRoot(artifactRoot)
  serveStdio(
    async () => {
      const { server } = await createArtifactPatchMcpServer({ artifactRoot })
      return server
    },
    {
      onerror: () => console.error('artifact patch MCP transport error'),
    },
  )
}

void main().catch(() => {
  console.error('ARTIFACT_ROOT failed root capability policy')
  process.exitCode = 2
})
