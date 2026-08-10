/**
 * Contract: root `npm test` must include the @genoffice/ui workspace so the
 * shared Markdown link suite (and other UI unit tests) is canonical CI coverage.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rootPkg = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json')

describe('root npm test script', () => {
  it('includes npm run test -w @genoffice/ui', () => {
    const pkg = JSON.parse(readFileSync(rootPkg, 'utf8')) as { scripts?: { test?: string } }
    const testScript = pkg.scripts?.test ?? ''
    expect(testScript).toMatch(/npm run test -w @genoffice\/ui/)
  })
})
