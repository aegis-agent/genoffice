/**
 * Source-level wiring contracts for high-risk file/AI IPC runtime schema checks (P0 C4).
 * Proves Docs/Slides/Sheets register those channels through shared safeHandle rather than
 * bare ipcMain.handle, and that sandboxed preloads do not import the main-only barrel.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

const DOCS_MAIN = 'apps/docs/src/main/docs-main.ts'
const SLIDES_AI = 'apps/slides/src/main/ai-ipc.ts'
const SLIDES_FILES = 'apps/slides/src/main/attachments-ipc.ts'
const SHEETS_MAIN = 'apps/sheets/src/main/sheets-main.ts'

const DOCS_AI_CHANNELS = [
  'ai:get-settings',
  'ai:gsk-status',
  'ai:gsk-login',
  'ai:set-settings',
  'ai:stream',
  'ai:stream-cancel',
  'ai:chat',
] as const

const DOCS_FILE_CHANNELS = [
  'files:pick',
  'files:add',
  'files:read',
  'files:read-image',
  'files:add-pasted-image',
  'docs:pick-image',
] as const

const SLIDES_AI_CHANNELS = [
  'ai:get-settings',
  'ai:gsk-status',
  'ai:gsk-login',
  'ai:set-settings',
  'ai:stream',
  'ai:stream-cancel',
] as const

const SLIDES_FILE_CHANNELS = [
  'slides:files-pick',
  'slides:files-add',
  'slides:files-read',
  'slides:files-read-image',
  'slides:files-add-pasted-image',
] as const

const SHEETS_AI_CONSTS = [
  'aiGetSettings',
  'aiGskStatus',
  'aiGskLogin',
  'aiSetSettings',
  'aiChat',
  'aiStream',
  'aiStreamCancel',
] as const

const SHEETS_FILE_CONSTS = [
  'filesPick',
  'filesAdd',
  'filesRead',
  'filesReadImage',
  'filesAddPastedImage',
] as const

function expectSafeHandleChannel(src: string, channel: string, file: string): void {
  // safeHandle(ipcMain, 'channel' | IPC_CHANNELS.x, schema, handler)
  const literal = new RegExp(
    `safeHandle\\(\\s*ipcMain\\s*,\\s*['"]${channel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['"]`,
  )
  expect(src, `${file} must safeHandle ${channel}`).toMatch(literal)
  // No bare handle for the same channel string.
  const bare = new RegExp(
    `ipcMain\\.handle\\(\\s*['"]${channel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['"]`,
  )
  expect(src, `${file} must not bare-handle ${channel}`).not.toMatch(bare)
}

function expectSafeHandleConst(src: string, constName: string, file: string): void {
  const re = new RegExp(`safeHandle\\(\\s*ipcMain\\s*,\\s*IPC_CHANNELS\\.${constName}\\b`)
  expect(src, `${file} must safeHandle IPC_CHANNELS.${constName}`).toMatch(re)
  const bare = new RegExp(`ipcMain\\.handle\\(\\s*IPC_CHANNELS\\.${constName}\\b`)
  expect(src, `${file} must not bare-handle IPC_CHANNELS.${constName}`).not.toMatch(bare)
}

describe('P0 C4 high-risk IPC safeHandle wiring', () => {
  it(`${DOCS_MAIN} migrates required AI + file channels through safeHandle`, () => {
    const src = read(DOCS_MAIN)
    expect(src).toMatch(/safeHandle/)
    for (const ch of DOCS_AI_CHANNELS) expectSafeHandleChannel(src, ch, DOCS_MAIN)
    for (const ch of DOCS_FILE_CHANNELS) expectSafeHandleChannel(src, ch, DOCS_MAIN)
    expect(src).toMatch(/aiSetSettingsArgsSchema|aiSettingsPreferencesUpdateSchema/)
  })

  it(`${SLIDES_AI} migrates required AI channels through safeHandle`, () => {
    const src = read(SLIDES_AI)
    expect(src).toMatch(/safeHandle/)
    for (const ch of SLIDES_AI_CHANNELS) expectSafeHandleChannel(src, ch, SLIDES_AI)
  })

  it(`${SLIDES_FILES} migrates required file channels through safeHandle`, () => {
    const src = read(SLIDES_FILES)
    expect(src).toMatch(/safeHandle/)
    for (const ch of SLIDES_FILE_CHANNELS) expectSafeHandleChannel(src, ch, SLIDES_FILES)
  })

  it(`${SHEETS_MAIN} migrates required AI + file channels through safeHandle (keeps sessionFor)`, () => {
    const src = read(SHEETS_MAIN)
    expect(src).toMatch(/safeHandle/)
    expect(src).toMatch(/sessionFor\(/)
    for (const c of SHEETS_AI_CONSTS) expectSafeHandleConst(src, c, SHEETS_MAIN)
    for (const c of SHEETS_FILE_CONSTS) expectSafeHandleConst(src, c, SHEETS_MAIN)
  })

  it('canonical AI request schemas live in @genoffice/ai-provider', () => {
    const src = read('packages/ai-provider/src/request-schemas.ts')
    expect(src).toMatch(/export const aiStreamRequestSchema/)
    expect(src).toMatch(/export const aiChatRequestSchema/)
    expect(src).toMatch(/export const aiSettingsPreferencesUpdateSchema/)
    expect(src).toMatch(/\.strict\(\)/)
    // Preference update must not model apiKey/baseUrl fields.
    const pref = src.slice(
      src.indexOf('export const aiSettingsPreferencesUpdateSchema'),
      src.indexOf('export type AiChatRequestParsed'),
    )
    expect(pref).not.toMatch(/apiKey/)
    expect(pref).not.toMatch(/baseUrl/)
  })

  it('sandboxed preloads do not import @genoffice/electron-utils barrel (safeHandle stays main-only)', () => {
    for (const file of [
      'apps/docs/src/preload/index.ts',
      'apps/slides/src/preload/index.ts',
      'apps/sheets/src/preload/index.ts',
    ]) {
      const src = read(file)
      expect(src).not.toContain("from '@genoffice/electron-utils'")
      expect(src).not.toMatch(/\bsafeHandle\b/)
      expect(src).not.toMatch(/\bIpcValidationError\b/)
    }
  })
})
