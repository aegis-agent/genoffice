import { createHash } from 'node:crypto'
import {
  open as fsOpen,
  link as fsLink,
  lstat,
  readFile,
  realpath,
  unlink,
  mkdtemp,
  stat,
  writeFile,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import {
  ArtifactPatchError,
  applyDocxPatch,
  applyDocxPatchToCopy,
  createDocxPatchProposal,
  inspectDocx,
  previewDocxPatch,
  validateDocxRoundtrip,
  type ApplyDocxPatchToCopyFs,
  type DocxPatchProposal,
} from '../src/index'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function simpleTwoPara(): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: '<w:p><w:r><w:t>First</w:t></w:r></w:p>' + '<w:p><w:r><w:t>Second</w:t></w:r></w:p>',
  })
}

async function proposalFor(
  bytes: Uint8Array,
  ops: Array<{ docxIndex: number; expectedText: string; replacementText: string }>,
): Promise<DocxPatchProposal> {
  const inspection = await inspectDocx(bytes)
  return createDocxPatchProposal(inspection, {
    source: inspection.source,
    operations: ops.map((o) => ({ op: 'replace_block_text' as const, ...o })),
  })
}

describe('input validation', () => {
  it('maps invalid DOCX bytes to a stable non-leaking error', async () => {
    const invalid = Buffer.from('private-invalid-docx-marker')
    await expect(inspectDocx(invalid)).rejects.toMatchObject({ code: 'INVALID_DOCX' })
    try {
      await inspectDocx(invalid)
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('private-invalid-docx-marker')
    }
  })
})

describe('proposal validation', () => {
  it('rejects unknown fields via strict schema', async () => {
    const bytes = await simpleTwoPara()
    const inspection = await inspectDocx(bytes)
    expect(() =>
      createDocxPatchProposal(inspection, {
        source: inspection.source,
        operations: [
          {
            op: 'replace_block_text',
            docxIndex: 0,
            expectedText: 'First',
            replacementText: 'X',
            extra: true,
          },
        ],
      }),
    ).toThrow(ArtifactPatchError)
  })

  it('rejects duplicate anchors at creation', async () => {
    const bytes = await simpleTwoPara()
    const inspection = await inspectDocx(bytes)
    expect(() =>
      createDocxPatchProposal(inspection, {
        source: inspection.source,
        operations: [
          {
            op: 'replace_block_text',
            docxIndex: 0,
            expectedText: 'First',
            replacementText: 'A',
          },
          {
            op: 'replace_block_text',
            docxIndex: 0,
            expectedText: 'First',
            replacementText: 'B',
          },
        ],
      }),
    ).toThrow(/DUPLICATE_ANCHOR|duplicate/i)
  })

  it('rejects CR/LF in replacement text', async () => {
    const bytes = await simpleTwoPara()
    const inspection = await inspectDocx(bytes)
    expect(() =>
      createDocxPatchProposal(inspection, {
        source: inspection.source,
        operations: [
          {
            op: 'replace_block_text',
            docxIndex: 0,
            expectedText: 'First',
            replacementText: 'A\nB',
          },
        ],
      }),
    ).toThrow(ArtifactPatchError)
  })

  it('rejects stale expected text at creation', async () => {
    const bytes = await simpleTwoPara()
    const inspection = await inspectDocx(bytes)
    try {
      createDocxPatchProposal(inspection, {
        source: inspection.source,
        operations: [
          {
            op: 'replace_block_text',
            docxIndex: 0,
            expectedText: 'NOT-First',
            replacementText: 'X',
          },
        ],
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactPatchError)
      expect((e as ArtifactPatchError).code).toBe('STALE_EXPECTED_TEXT')
    }
  })

  it('rejects source hash/byte-length mismatch at creation', async () => {
    const bytes = await simpleTwoPara()
    const inspection = await inspectDocx(bytes)
    try {
      createDocxPatchProposal(inspection, {
        source: { sha256: 'ab'.repeat(32), byteLength: bytes.byteLength },
        operations: [
          {
            op: 'replace_block_text',
            docxIndex: 0,
            expectedText: 'First',
            replacementText: 'X',
          },
        ],
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactPatchError)
      expect((e as ArtifactPatchError).code).toBe('SOURCE_HASH_MISMATCH')
    }
  })

  it('rejects protected/non-editable anchors at creation', async () => {
    const bytes = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t>Before</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '<w:p><w:r><w:t>After</w:t></w:r></w:p>',
    })
    const inspection = await inspectDocx(bytes)
    const table = inspection.blocks.find((b) => b.type === 'table')
    expect(table).toBeTruthy()
    expect(table!.textReplaceSupported).toBe(false)
    try {
      createDocxPatchProposal(inspection, {
        source: inspection.source,
        operations: [
          {
            op: 'replace_block_text',
            docxIndex: table!.docxIndex,
            expectedText: table!.text,
            replacementText: 'Nope',
          },
        ],
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactPatchError)
      expect((e as ArtifactPatchError).code).toBe('ANCHOR_NOT_EDITABLE')
    }
  })

  it('rejects tampered proposal id', async () => {
    const bytes = await simpleTwoPara()
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])
    const tampered = { ...proposal, id: '0'.repeat(64) }
    const inspection = await inspectDocx(bytes)
    expect(() => previewDocxPatch(tampered, inspection)).toThrow(ArtifactPatchError)
    try {
      previewDocxPatch(tampered, inspection)
    } catch (e) {
      expect((e as ArtifactPatchError).code).toBe('PROPOSAL_ID_MISMATCH')
    }
  })

  it('rejects apply when live bytes diverge from proposal source binding', async () => {
    const bytes = await simpleTwoPara()
    const other = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>Other</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>',
    })
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])
    await expect(
      applyDocxPatch(other, proposal, { appliedAt: '2026-08-03T12:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'SOURCE_HASH_MISMATCH' })
  })
})

describe('filesystem publication policy', () => {
  it('refuses same path without writing', async () => {
    const bytes = await simpleTwoPara()
    const dir = await mkdtemp(join(tmpdir(), 'ap-same-'))
    const path = join(dir, 'doc.docx')
    await writeFile(path, bytes)
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])
    await expect(
      applyDocxPatchToCopy({
        sourcePath: path,
        destinationPath: path,
        proposal,
        appliedAt: '2026-08-03T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'SAME_PATH' })
    expect(sha256(await readFile(path))).toBe(sha256(bytes))
  })

  it('refuses existing destination including symlink without modifying it', async () => {
    const bytes = await simpleTwoPara()
    const dir = await mkdtemp(join(tmpdir(), 'ap-exist-'))
    const sourcePath = join(dir, 'source.docx')
    const destPath = join(dir, 'dest.docx')
    const target = join(dir, 'target.bin')
    await writeFile(sourcePath, bytes)
    await writeFile(target, Buffer.from('sentinel-dest'))
    await symlink(target, destPath)
    const before = await readFile(destPath)
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])
    await expect(
      applyDocxPatchToCopy({
        sourcePath,
        destinationPath: destPath,
        proposal,
        appliedAt: '2026-08-03T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
    expect(Buffer.from(await readFile(destPath)).equals(before)).toBe(true)
    expect(sha256(await readFile(sourcePath))).toBe(sha256(bytes))
  })

  it('multi-operation failure leaves no destination', async () => {
    const bytes = await simpleTwoPara()
    const dir = await mkdtemp(join(tmpdir(), 'ap-fail-'))
    const sourcePath = join(dir, 'source.docx')
    const destPath = join(dir, 'dest.docx')
    await writeFile(sourcePath, bytes)
    await expect(
      proposalFor(bytes, [
        { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
        { docxIndex: 1, expectedText: 'WRONG', replacementText: 'Y' },
      ]),
    ).rejects.toMatchObject({ code: 'STALE_EXPECTED_TEXT' })
    await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(sha256(await readFile(sourcePath))).toBe(sha256(bytes))
  })

  it('rejects invalid appliedAt ISO datetime at file apply boundary', async () => {
    const bytes = await simpleTwoPara()
    const dir = await mkdtemp(join(tmpdir(), 'ap-date-'))
    const sourcePath = join(dir, 'source.docx')
    const destPath = join(dir, 'dest.docx')
    await writeFile(sourcePath, bytes)
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])
    await expect(
      applyDocxPatchToCopy({
        sourcePath,
        destinationPath: destPath,
        proposal,
        appliedAt: 'not-a-date',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' })
    await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unknown root fields on file apply args', async () => {
    const bytes = await simpleTwoPara()
    const dir = await mkdtemp(join(tmpdir(), 'ap-unk-'))
    const sourcePath = join(dir, 'source.docx')
    const destPath = join(dir, 'dest.docx')
    await writeFile(sourcePath, bytes)
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])
    await expect(
      applyDocxPatchToCopy({
        sourcePath,
        destinationPath: destPath,
        proposal,
        appliedAt: '2026-08-03T12:00:00.000Z',
        extraField: true,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' })
    await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('maps path inspection failures to a stable non-leaking error', async () => {
    const bytes = await simpleTwoPara()
    const inspection = await inspectDocx(bytes)
    const proposal = createDocxPatchProposal(inspection, {
      source: inspection.source,
      operations: [
        {
          op: 'replace_block_text',
          docxIndex: 0,
          expectedText: 'First',
          replacementText: 'X',
        },
      ],
    })
    const privatePath = '/private/path/that-must-not-leak.docx'
    const fs: ApplyDocxPatchToCopyFs = {
      open: fsOpen,
      link: fsLink,
      unlink,
      readFile,
      lstat: async () => {
        const error = new Error(`EACCES: ${privatePath}`) as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      },
      realpath,
    }
    try {
      await applyDocxPatchToCopy(
        {
          sourcePath: privatePath,
          destinationPath: '/private/path/output.docx',
          proposal,
          appliedAt: '2026-08-03T12:00:00.000Z',
        },
        fs,
      )
      throw new Error('expected applyDocxPatchToCopy to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'IO_ERROR' })
      expect(String((error as Error).message)).not.toContain(privatePath)
    }
  })

  it('rolls back newly-created destination when post-link verification fails', async () => {
    const bytes = await simpleTwoPara()
    const dir = await mkdtemp(join(tmpdir(), 'ap-rb-'))
    const sourcePath = join(dir, 'source.docx')
    const destPath = join(dir, 'dest.docx')
    await writeFile(sourcePath, bytes)
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])

    let linked = false
    const unlinked: string[] = []
    const fs: ApplyDocxPatchToCopyFs = {
      open: fsOpen,
      link: async (existing, neu) => {
        await fsLink(existing, neu)
        linked = true
      },
      unlink: async (p) => {
        unlinked.push(resolve(p))
        await unlink(p)
      },
      readFile: async (p) => {
        const data = await readFile(p)
        if (linked && resolve(p) === resolve(destPath)) {
          return Buffer.from('tampered-unverified-bytes')
        }
        return data
      },
      lstat,
      realpath,
    }

    await expect(
      applyDocxPatchToCopy(
        {
          sourcePath,
          destinationPath: destPath,
          proposal,
          appliedAt: '2026-08-03T12:00:00.000Z',
        },
        fs,
      ),
    ).rejects.toMatchObject({ code: 'PUBLICATION_FAILED' })

    expect(linked).toBe(true)
    expect(unlinked).toContain(resolve(destPath))
    await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(sha256(await readFile(sourcePath))).toBe(sha256(bytes))
  })
})

describe('in-memory apply', () => {
  it('applies two paragraph replacements and returns full provenance manifest', async () => {
    const bytes = await simpleTwoPara()
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: '1st' },
      { docxIndex: 1, expectedText: 'Second', replacementText: '2nd' },
    ])
    const result = await applyDocxPatch(bytes, proposal, {
      appliedAt: '2026-08-03T12:00:00.000Z',
    })
    expect(result.validation.ok).toBe(true)
    expect(result.manifest.output.sha256).toBe(sha256(result.bytes))
    expect(result.manifest.output.byteLength).toBe(result.bytes.byteLength)
    expect(result.manifest.appliedAt).toBe('2026-08-03T12:00:00.000Z')
    expect(result.manifest.version).toBe('docx-provenance/v1')
    const after = await inspectDocx(result.bytes)
    const texts = after.blocks.filter((b) => b.textReplaceSupported).map((b) => b.text)
    expect(texts).toEqual(['1st', '2nd'])
  })

  it('requires validated appliedAt for in-memory apply', async () => {
    const bytes = await simpleTwoPara()
    const proposal = await proposalFor(bytes, [
      { docxIndex: 0, expectedText: 'First', replacementText: 'X' },
    ])
    await expect(
      applyDocxPatch(bytes, proposal, { appliedAt: 'yesterday' } as never),
    ).rejects.toMatchObject({
      code: 'INVALID_PROPOSAL',
    })
  })
})

describe('explicit roundtrip validation', () => {
  it('reports structured failure for syntactically valid but semantically wrong output', async () => {
    const source = await simpleTwoPara()
    const wrongOutput = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t>NotWhatWasProposed</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Second</w:t></w:r></w:p>',
    })
    const proposal = await proposalFor(source, [
      { docxIndex: 0, expectedText: 'First', replacementText: '1st' },
    ])
    const validation = await validateDocxRoundtrip(source, wrongOutput, proposal)
    expect(validation.ok).toBe(false)
    expect(validation.failures.length).toBeGreaterThan(0)
    for (const f of validation.failures) {
      expect(f).toEqual(
        expect.objectContaining({
          docxIndex: expect.any(Number),
          reason: expect.any(String),
        }),
      )
      expect(JSON.stringify(f)).not.toMatch(/First|1st|NotWhat|Second/)
    }
  })
})
