import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
  'utf8',
)

describe('packaged userData isolation contract', () => {
  it('honors an explicit test profile before the unpackaged default', () => {
    const overrideDeclaration = mainSource.indexOf(
      'const userDataOverride = process.env.GENOFFICE_USER_DATA?.trim()',
    )
    const overrideSetPath = mainSource.indexOf("app.setPath('userData', userDataOverride)")
    const devFallback = mainSource.indexOf('else if (!app.isPackaged)')

    expect(overrideDeclaration).toBeGreaterThan(-1)
    expect(overrideSetPath).toBeGreaterThan(overrideDeclaration)
    expect(devFallback).toBeGreaterThan(overrideSetPath)
  })

  it('never imports a real legacy profile into an isolated acceptance profile', () => {
    expect(mainSource).toContain('if (app.isPackaged && !userDataOverride)')
  })
})
