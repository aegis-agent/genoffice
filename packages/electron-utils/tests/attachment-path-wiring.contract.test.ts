/**
 * Source-level wiring contracts for Docs/Slides/Sheets attachment IPC.
 * Proves each app main path authorizes via ReadablePathGrantRegistry before
 * text/image reads, and each preload gates renderer-supplied dropped paths.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

const MAIN_FILES = [
  'apps/docs/src/main/docs-main.ts',
  'apps/slides/src/main/attachments-ipc.ts',
  'apps/sheets/src/main/sheets-main.ts',
] as const

const PRELOAD_FILES = [
  'apps/docs/src/preload/index.ts',
  'apps/slides/src/preload/index.ts',
  'apps/sheets/src/preload/index.ts',
] as const

const PRELOAD_CONFIG_FILES = [
  'apps/docs/electron.vite.config.ts',
  'apps/slides/electron.vite.config.ts',
  'apps/sheets/electron.vite.config.ts',
] as const

describe('attachment path hardening wiring', () => {
  for (const file of MAIN_FILES) {
    it(`${file} grants on pick/add/paste and authorizes before text/image reads`, () => {
      const src = read(file)
      expect(src).toMatch(/ReadablePathGrantRegistry/)
      expect(src).toMatch(/\.isAuthorized\(/)
      expect(src).toMatch(/\.grant\(/)
      expect(src).toMatch(/bindSenderCleanup/)
      // Both read channels must authorize. Prefer a shared helper invoked twice
      // (def + 2 call sites => 3 matches), or two direct isAuthorized checks.
      const authorizeCount = (src.match(/\.isAuthorized\(/g) ?? []).length
      const denyHelperCount = (src.match(/denyUnlessGranted\(/g) ?? []).length
      expect(
        authorizeCount >= 2 || denyHelperCount >= 3,
        `expected dual-read auth in ${file}; isAuthorized=${authorizeCount} denyUnlessGranted=${denyHelperCount}`,
      ).toBe(true)
      expect(src).toMatch(/files:read|files-read|filesRead/)
      expect(src).toMatch(/files:read-image|files-read-image|filesReadImage|read-image/)
    })
  }

  for (const file of PRELOAD_FILES) {
    it(`${file} issues dropped-path permits from getPathForFile and gates addAttachmentPaths`, () => {
      const src = read(file)
      expect(src).toMatch(/DroppedPathPermitGate/)
      expect(src).toMatch(/\.issue\(/)
      expect(src).toMatch(/\.consumeAll\(/)
      expect(src).toMatch(/getPathForFile/)
      expect(src).toMatch(/addAttachmentPaths/)
      // Import the browser-safe subpath, not the package barrel. The barrel has
      // main-process node:* imports that crash Electron's sandboxed preload.
      expect(src).toContain("from '@genoffice/electron-utils/dropped-path-permits'")
      expect(src).not.toContain("from '@genoffice/electron-utils'")
    })
  }

  for (const file of PRELOAD_CONFIG_FILES) {
    it(`${file} bundles the browser-safe permit gate into the sandboxed preload`, () => {
      const src = read(file)
      const preloadConfig = src.slice(src.indexOf('preload:'), src.indexOf('renderer:'))
      expect(preloadConfig).toContain("'@genoffice/electron-utils/dropped-path-permits'")
      expect(preloadConfig).toMatch(/externalizeDepsPlugin/)
    })
  }
})
