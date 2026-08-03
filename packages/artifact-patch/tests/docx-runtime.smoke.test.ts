/**
 * Workspace end-to-end smoke: full inspect -> propose -> preview -> applyToCopy
 * path against real generated DOCX bytes and real temp filesystem paths.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import {
  applyDocxPatchToCopy,
  createDocxPatchProposal,
  inspectDocx,
  previewDocxPatch,
} from '../src/index'

describe('workspace e2e smoke', () => {
  it('runs the full vertical slice via package public exports', async () => {
    const bytes = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t>Smoke A</w:t></w:r></w:p>' + '<w:p><w:r><w:t>Smoke B</w:t></w:r></w:p>',
    })
    const inspection = await inspectDocx(bytes)
    const editable = inspection.blocks.filter((b) => b.textReplaceSupported)
    const proposal = createDocxPatchProposal(inspection, {
      source: inspection.source,
      operations: [
        {
          op: 'replace_block_text',
          docxIndex: editable[0].docxIndex,
          expectedText: editable[0].text,
          replacementText: 'Smoke A2',
        },
        {
          op: 'replace_block_text',
          docxIndex: editable[1].docxIndex,
          expectedText: editable[1].text,
          replacementText: 'Smoke B2',
        },
      ],
    })
    const preview = previewDocxPatch(proposal, inspection)
    expect(preview.entries.map((e) => e.afterText)).toEqual(['Smoke A2', 'Smoke B2'])

    const dir = await mkdtemp(join(tmpdir(), 'ap-smoke-'))
    const src = join(dir, 'in.docx')
    const dst = join(dir, 'out.docx')
    await writeFile(src, bytes)
    const { manifest } = await applyDocxPatchToCopy({
      sourcePath: src,
      destinationPath: dst,
      proposal,
      appliedAt: '2026-08-03T15:00:00.000Z',
    })
    const out = await readFile(dst)
    expect(createHash('sha256').update(out).digest('hex')).toBe(manifest.output.sha256)
    const after = await inspectDocx(out)
    expect(after.blocks.filter((b) => b.textReplaceSupported).map((b) => b.text)).toEqual([
      'Smoke A2',
      'Smoke B2',
    ])
    expect(manifest.roundtrip.ok).toBe(true)
  })
})
