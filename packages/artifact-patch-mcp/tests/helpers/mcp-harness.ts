import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

export interface ConnectedPair {
  client: Client
  server: McpServer
  close: () => Promise<void>
}

export async function connectServer(server: McpServer): Promise<ConnectedPair> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'artifact-patch-mcp-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    server,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

export async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'ap-mcp-root-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Collect closers for afterEach cleanup. */
export function installPairCleanup(): { track: (pair: ConnectedPair) => void } {
  const pairs: ConnectedPair[] = []
  afterEach(async () => {
    while (pairs.length > 0) {
      const pair = pairs.pop()!
      await pair.close()
    }
  })
  return {
    track(pair: ConnectedPair) {
      pairs.push(pair)
    },
  }
}
