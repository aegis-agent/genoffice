/**
 * Source-level wiring contracts for Docs/Slides/Sheets AI IPC trust boundary (P0 C2).
 * Malicious renderer settings must not select provider/baseUrl/key for AI calls;
 * get-settings redacts keys; set-settings sanitizes; runtime config is main-owned Genspark+gsk.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

const MAIN_AI_FILES = [
  'apps/docs/src/main/docs-main.ts',
  'apps/slides/src/main/ai-ipc.ts',
  'apps/sheets/src/main/sheets-main.ts',
] as const

describe('AI main-owned config wiring', () => {
  for (const file of MAIN_AI_FILES) {
    it(`${file} resolves AI calls via resolveMainOwnedAiConfig and never trusts request.settings`, () => {
      const src = read(file)
      expect(src).toMatch(/resolveMainOwnedAiConfig/)
      expect(src).toMatch(/publicAiSettings/)
      expect(src).toMatch(/sanitizeRendererAiSettingsUpdate/)
      // Stream/chat handlers must not read authority from the renderer payload.
      expect(src).not.toMatch(/request\.settings/)
      expect(src).toMatch(/gskApiKey/)
    })
  }

  it('sheets schemas reject settings on ai chat/stream requests', () => {
    const src = read('apps/sheets/src/shared/desktop-api.ts')
    expect(src).toMatch(/aiChatRequestSchema/)
    expect(src).toMatch(/aiStreamRequestSchema/)
    // Request schemas must not accept a settings field.
    const chatBlock = src.slice(
      src.indexOf('export const aiChatRequestSchema'),
      src.indexOf('export const aiStreamRequestSchema'),
    )
    const streamBlock = src.slice(
      src.indexOf('export const aiStreamRequestSchema'),
      src.indexOf('export type AiSettingsInput'),
    )
    expect(chatBlock).not.toMatch(/settings:/)
    expect(streamBlock).not.toMatch(/settings:/)
  })

  it('agent-core IPC transport no longer injects settings into stream starts', () => {
    const src = read('packages/agent-core/src/electron-transport.ts')
    expect(src).not.toMatch(/settings:/)
    expect(src).not.toMatch(/getSettings/)
  })

  it('renderer transports do not supply getSettings into stream starts', () => {
    for (const file of [
      'apps/docs/src/renderer/ai/transport.ts',
      'apps/slides/src/renderer/ai/transport.ts',
      'apps/sheets/src/renderer/ai/transport.ts',
      'apps/pdf/src/renderer/ai/transport.ts',
    ]) {
      const src = read(file)
      expect(src).not.toMatch(/getSettings/)
      expect(src).toMatch(/createIpcTransport/)
    }
  })
})
