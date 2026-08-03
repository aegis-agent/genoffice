import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(import.meta.dirname, '../src')

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('no HTTP/listen/socket server surface', () => {
  it('package source does not open network listeners or HTTP transports', () => {
    const files = listTsFiles(SRC_DIR)
    expect(files.length).toBeGreaterThan(0)
    const joined = files.map((f) => readFileSync(f, 'utf8')).join('\n')

    const banned = [
      'createServer(',
      'listen(',
      'StreamableHTTPServerTransport',
      'WebStandardStreamableHTTPServerTransport',
      'createMcpHandler',
      'express(',
      'fastify(',
      'hono(',
      'node:http',
      'node:https',
      'node:net',
      '.listen(',
    ]
    for (const token of banned) {
      expect(joined, `banned token ${token}`).not.toContain(token)
    }

    // Allowed: stdio only
    expect(joined).toContain('serveStdio')
    expect(joined).not.toMatch(/from\s+['"]http['"]/)
    expect(joined).not.toMatch(/from\s+['"]node:http['"]/)
  })
})
