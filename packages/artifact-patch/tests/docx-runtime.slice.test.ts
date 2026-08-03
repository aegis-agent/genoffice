import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import {
  applyDocxPatchToCopy,
  createDocxPatchProposal,
  inspectDocx,
  previewDocxPatch,
} from '../src/index'

const SENTINEL_PATH = 'customXml/sentinel.xml'
const SENTINEL_XML =
  '<?xml version="1.0" encoding="UTF-8"?><sentinel xmlns="urn:genoffice:test">KEEP-ME-BYTE-EXACT</sentinel>'

async function twoParagraphDocx(): Promise<Uint8Array> {
  return buildDocx({
    bodyXml:
      '<w:p><w:r><w:t>Alpha one</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve"> Beta two</w:t></w:r></w:p>',
    extraParts: [
      {
        path: SENTINEL_PATH,
        xml: SENTINEL_XML,
        contentType: 'application/xml',
      },
    ],
  })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('docx transactional runtime slice', () => {
  it('inspects, proposes, previews, applies to copy, validates, and returns provenance', async () => {
    const sourceBytes = await twoParagraphDocx()
    const sourceHash = sha256(sourceBytes)
    const inspection = await inspectDocx(sourceBytes)

    expect(inspection.version).toBe('docx-inspection/v1')
    expect(inspection.source.sha256).toBe(sourceHash)
    expect(inspection.source.byteLength).toBe(sourceBytes.byteLength)

    const editable = inspection.blocks.filter((b) => b.textReplaceSupported)
    expect(editable.length).toBeGreaterThanOrEqual(2)
    const [a, b] = editable
    expect(a.text).toBe('Alpha one')
    expect(b.text).toBe('Bold Beta two')

    const proposal = createDocxPatchProposal(inspection, {
      source: { sha256: sourceHash, byteLength: sourceBytes.byteLength },
      operations: [
        {
          op: 'replace_block_text',
          docxIndex: a.docxIndex,
          expectedText: 'Alpha one',
          replacementText: 'Alpha ONE',
        },
        {
          op: 'replace_block_text',
          docxIndex: b.docxIndex,
          expectedText: 'Bold Beta two',
          replacementText: 'Bold BETA two',
        },
      ],
    })

    const frozenSource = Uint8Array.from(sourceBytes)
    const preview = previewDocxPatch(proposal, inspection)
    expect(preview.entries).toEqual([
      {
        docxIndex: a.docxIndex,
        beforeText: 'Alpha one',
        afterText: 'Alpha ONE',
      },
      {
        docxIndex: b.docxIndex,
        beforeText: 'Bold Beta two',
        afterText: 'Bold BETA two',
      },
    ])
    expect(Buffer.from(sourceBytes).equals(Buffer.from(frozenSource))).toBe(true)

    const dir = await mkdtemp(join(tmpdir(), 'artifact-patch-'))
    const sourcePath = join(dir, 'source.docx')
    const destPath = join(dir, 'out.docx')
    await writeFile(sourcePath, sourceBytes)

    const appliedAt = '2026-08-03T12:00:00.000Z'
    const result = await applyDocxPatchToCopy({
      sourcePath,
      destinationPath: destPath,
      proposal,
      appliedAt,
    })

    const sourceAfter = await readFile(sourcePath)
    expect(sha256(sourceAfter)).toBe(sourceHash)

    const destBytes = await readFile(destPath)
    expect(destBytes.byteLength).toBeGreaterThan(0)
    expect(sha256(destBytes)).toBe(result.manifest.output.sha256)

    const reinspect = await inspectDocx(destBytes)
    const byIndex = new Map(reinspect.blocks.map((blk) => [blk.docxIndex, blk]))
    expect(byIndex.get(a.docxIndex)?.text).toBe('Alpha ONE')
    expect(byIndex.get(b.docxIndex)?.text).toBe('Bold BETA two')

    // Rich formatting survives surgical replacement on the second paragraph.
    const zip = await JSZip.loadAsync(destBytes)
    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('<w:rPr><w:b/></w:rPr>')
    expect(documentXml).toMatch(/<w:t[^>]*>Bold<\/w:t>/)

    const sentinel = await zip.file(SENTINEL_PATH)!.async('string')
    expect(sentinel).toBe(SENTINEL_XML)

    expect(result.manifest.version).toBe('docx-provenance/v1')
    expect(result.manifest.format).toBe('docx')
    expect(result.manifest.proposalId).toBe(proposal.id)
    expect(result.manifest.source.sha256).toBe(sourceHash)
    expect(result.manifest.appliedAt).toBe(appliedAt)
    expect(result.manifest.roundtrip.ok).toBe(true)
    expect(result.manifest.operations).toHaveLength(2)
    for (const op of result.manifest.operations) {
      expect(op.beforeTextSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(op.afterTextSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(op)).not.toMatch(/Alpha|Bold|Beta|ONE|BETA/)
    }
    const manifestJson = JSON.stringify(result.manifest)
    expect(manifestJson).not.toContain('Alpha')
    expect(manifestJson).not.toContain('Bold')
    expect(manifestJson).not.toContain(sourcePath)
    expect(manifestJson).not.toContain(destPath)
  })
})
