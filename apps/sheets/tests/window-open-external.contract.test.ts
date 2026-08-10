/**
 * Sheets must route window.open / target=_blank through safeExternalUrl +
 * shell.openExternal and always deny in-app BrowserWindows — matching Docs/Slides.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { safeExternalUrl } from '@genoffice/electron-utils'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Same control flow Sheets main handlers must implement. */
function sheetsWindowOpenHandler(
  url: string,
  openExternal: (safeUrl: string) => void,
): { action: 'deny' } {
  const target = safeExternalUrl(url)
  if (target) openExternal(target)
  return { action: 'deny' }
}

describe('Sheets window-open external contract', () => {
  it('passes only safeExternalUrl results to openExternal and always denies in-app windows', () => {
    const opened: string[] = []
    const openExternal = vi.fn((u: string) => {
      opened.push(u)
    })

    expect(sheetsWindowOpenHandler('https://example.com/a', openExternal)).toEqual({
      action: 'deny',
    })
    expect(sheetsWindowOpenHandler('http://example.com', openExternal)).toEqual({ action: 'deny' })
    expect(sheetsWindowOpenHandler('javascript:alert(1)', openExternal)).toEqual({ action: 'deny' })
    expect(sheetsWindowOpenHandler('file:///etc/passwd', openExternal)).toEqual({ action: 'deny' })
    expect(sheetsWindowOpenHandler('mailto:a@b.com', openExternal)).toEqual({ action: 'deny' })
    expect(sheetsWindowOpenHandler('/relative', openExternal)).toEqual({ action: 'deny' })
    expect(sheetsWindowOpenHandler('not a url', openExternal)).toEqual({ action: 'deny' })

    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(opened).toEqual(['https://example.com/a', 'http://example.com'])
    for (const u of opened) {
      expect(safeExternalUrl(u)).toBe(u)
    }
  })

  it('createSheetsWindow/View wire setWindowOpenHandler through safeExternalUrl + shell.openExternal', () => {
    const src = readFileSync(join(root, 'apps/sheets/src/main/sheets-main.ts'), 'utf8')

    // No blanket deny-only handlers left on the AI-capable webContents.
    expect(src).not.toMatch(/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/)

    // Both window and view paths open allowlisted URLs externally, then deny.
    const handlerBlocks =
      src.match(/setWindowOpenHandler\(\(\{\s*url\s*\}\)\s*=>\s*\{[\s\S]*?\}\)/g) ?? []
    expect(handlerBlocks.length).toBeGreaterThanOrEqual(2)
    for (const block of handlerBlocks) {
      expect(block).toMatch(/safeExternalUrl\(\s*url\s*\)/)
      expect(block).toMatch(/shell\.openExternal\(\s*target\s*\)/)
      expect(block).toMatch(/action:\s*'deny'/)
    }

    // In-app navigation stays blocked.
    expect(src).toMatch(/will-navigate['"]?\s*,\s*\(event\)\s*=>\s*event\.preventDefault\(\)/)
  })
})
