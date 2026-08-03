import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
  'utf8',
)

/**
 * macOS clean-shutdown contract: app.quit() → before-quit → window close guard
 * may event.preventDefault(), which cancels the quit. window-all-closed does not
 * call app.quit() on darwin, so after the async guard confirms it must resume
 * app.quit() only when an application quit was requested — not on plain ⌘W.
 */
describe('macOS quit resume after async window close guard', () => {
  it('records application quit from before-quit lifecycle', () => {
    expect(mainSource).toMatch(/let applicationQuitRequested = false/)
    const flagDecl = mainSource.indexOf('let applicationQuitRequested = false')
    const beforeQuit = mainSource.indexOf("app.on('before-quit'")
    const setFlag = mainSource.indexOf('applicationQuitRequested = true', beforeQuit)
    expect(flagDecl).toBeGreaterThan(-1)
    expect(beforeQuit).toBeGreaterThan(flagDecl)
    expect(setFlag).toBeGreaterThan(beforeQuit)
  })

  it('prevents default then resumes app.quit only when quit was requested', () => {
    const closeHandler = mainSource.indexOf("win.on('close'")
    const preventDefault = mainSource.indexOf('event.preventDefault()', closeHandler)
    const closeConfirmed = mainSource.indexOf('closeConfirmed = true', closeHandler)
    const winClose = mainSource.indexOf('win.close()', closeConfirmed)
    const resumeQuit = mainSource.indexOf(
      'if (applicationQuitRequested) app.quit()',
      closeConfirmed,
    )

    expect(closeHandler).toBeGreaterThan(-1)
    expect(preventDefault).toBeGreaterThan(closeHandler)
    expect(closeConfirmed).toBeGreaterThan(preventDefault)
    expect(winClose).toBeGreaterThan(closeConfirmed)
    expect(resumeQuit).toBeGreaterThan(winClose)
  })

  it('clears quit intent when a close-guard prompt is cancelled', () => {
    const closeHandler = mainSource.indexOf("win.on('close'")
    const abortHelper = mainSource.indexOf('const abortClose = (): void =>', closeHandler)
    const clearFlag = mainSource.indexOf('applicationQuitRequested = false', abortHelper)
    // abort must run on cancel paths before any resume quit
    const resumeQuit = mainSource.indexOf('if (applicationQuitRequested) app.quit()', closeHandler)

    expect(abortHelper).toBeGreaterThan(closeHandler)
    expect(clearFlag).toBeGreaterThan(abortHelper)
    expect(resumeQuit).toBeGreaterThan(clearFlag)
    // every dirty-prompt failure must call abortClose (not bare return)
    const guardRegion = mainSource.slice(closeHandler, resumeQuit)
    expect(guardRegion).toContain('abortClose()')
    expect(guardRegion).not.toMatch(
      /if \(!\(await request(?:Sheets|Pdf|Slides|Docs)Close\([^)]*\)\)\) return/,
    )
  })

  it('keeps macOS window-all-closed from quitting on plain window close', () => {
    expect(mainSource).toMatch(
      /app\.on\('window-all-closed'[\s\S]*?if \(process\.platform !== 'darwin'\) app\.quit\(\)/,
    )
  })
})
