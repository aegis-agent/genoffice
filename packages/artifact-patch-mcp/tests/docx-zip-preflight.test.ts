import { deflateRawSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import {
  MAX_DOCX_ZIP_ENTRIES,
  MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  assertDocxZipPreflight,
} from '../src/docx-zip-preflight'
import { ArtifactPatchMcpError } from '../src/errors'
import { createArtifactPatchMcpServer } from '../src/server'
import { connectServer, installPairCleanup, withTempRoot } from './helpers/mcp-harness'

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

interface SyntheticEntry {
  name: string
  method: 0 | 8
  data: Buffer
  /** Advertised uncompressed size (may lie). Defaults to data length for STORE or real inflated. */
  advertisedUncompressed?: number
  /** Advertised compressed size override. */
  advertisedCompressed?: number
}

/**
 * Build a minimal single-disk ZIP from synthetic entries without retaining huge inflated payloads.
 * For DEFLATE entries, `data` is the already-compressed payload and `advertisedUncompressed` must be set
 * when the real expansion differs or is large.
 */
function buildSyntheticZip(entries: SyntheticEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const compressed = entry.data
    const uncompressedSize =
      entry.advertisedUncompressed ?? (entry.method === 0 ? compressed.byteLength : 0)
    const compressedSize = entry.advertisedCompressed ?? compressed.byteLength

    const localHeader = Buffer.concat([
      u32(SIG_LOCAL),
      u16(20), // version needed
      u16(0), // flags
      u16(entry.method),
      u16(0), // time
      u16(0), // date
      u32(0), // crc
      u32(compressedSize),
      u32(uncompressedSize),
      u16(nameBuf.byteLength),
      u16(0), // extra
      nameBuf,
    ])
    const localOffset = offset
    localParts.push(localHeader, compressed)
    offset += localHeader.byteLength + compressed.byteLength

    const central = Buffer.concat([
      u32(SIG_CENTRAL),
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(entry.method),
      u16(0),
      u16(0),
      u32(0), // crc
      u32(compressedSize),
      u32(uncompressedSize),
      u16(nameBuf.byteLength),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk start
      u16(0), // int attrs
      u32(0), // ext attrs
      u32(localOffset),
      nameBuf,
    ])
    centralParts.push(central)
  }

  const centralDir = Buffer.concat(centralParts)
  const locals = Buffer.concat(localParts)
  const eocd = Buffer.concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.byteLength),
    u32(locals.byteLength),
    u16(0),
  ])
  return Buffer.concat([locals, centralDir, eocd])
}

/** Highly compressible DEFLATE payload that expands to `expandedSize` zeros when inflated. */
function deflateZeros(expandedSize: number): Buffer {
  // Keep test allocation bounded: only slightly over the MCP per-entry cap is allowed.
  if (expandedSize > 64 * 1024 * 1024) {
    throw new Error('test helper refuses to allocate over 64MiB inflated input')
  }
  const plain = Buffer.alloc(expandedSize, 0)
  const compressed = deflateRawSync(plain, { level: 9 })
  return compressed
}

function minimalValidDocxParts(extra: SyntheticEntry[] = []): SyntheticEntry[] {
  const xml = Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
  )
  const contentTypes = Buffer.from(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  )
  return [
    { name: '[Content_Types].xml', method: 0, data: contentTypes },
    { name: 'word/document.xml', method: 0, data: xml },
    ...extra,
  ]
}

describe('DOCX ZIP preflight', () => {
  const cleanup = installPairCleanup()

  it('accepts a normal DOCX built by the engine helper', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>',
    })
    expect(() => assertDocxZipPreflight(bytes)).not.toThrow()
  })

  it('rejects archives missing word/document.xml', () => {
    const zip = buildSyntheticZip([
      { name: '[Content_Types].xml', method: 0, data: Buffer.from('<Types/>') },
    ])
    expect(() => assertDocxZipPreflight(zip)).toThrow(ArtifactPatchMcpError)
    try {
      assertDocxZipPreflight(zip)
    } catch (err) {
      expect((err as ArtifactPatchMcpError).code).toBe('INVALID_DOCX')
    }
  })

  it('rejects forged oversized uncompressed advertisements without allocating them', () => {
    const zip = buildSyntheticZip(
      minimalValidDocxParts([
        {
          name: 'word/huge.bin',
          method: 0,
          data: Buffer.from('x'),
          advertisedUncompressed: MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1,
          advertisedCompressed: 1,
        },
      ]),
    )
    expect(() => assertDocxZipPreflight(zip)).toThrow(ArtifactPatchMcpError)
    try {
      assertDocxZipPreflight(zip)
    } catch (err) {
      expect((err as ArtifactPatchMcpError).code).toBe('INPUT_TOO_LARGE')
    }
  })

  it('rejects actual DEFLATE expansion beyond the per-entry cap', () => {
    const expanded = MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 64 * 1024
    // Keep test allocation bounded: only slightly over the 32MiB cap.
    const compressed = deflateZeros(expanded)
    expect(compressed.byteLength).toBeLessThan(256 * 1024)

    const zip = buildSyntheticZip(
      minimalValidDocxParts([
        {
          name: 'word/bomb.bin',
          method: 8,
          data: compressed,
          // Advertise within cap so we exercise actual inflate maxOutputLength, not the ad gate.
          advertisedUncompressed: MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
        },
      ]),
    )

    expect(() => assertDocxZipPreflight(zip)).toThrow(ArtifactPatchMcpError)
    try {
      assertDocxZipPreflight(zip)
    } catch (err) {
      expect((err as ArtifactPatchMcpError).code).toBe('INPUT_TOO_LARGE')
    }
  })

  it('rejects entry-count overflow using tiny STORED entries', () => {
    const extras: SyntheticEntry[] = []
    for (let i = 0; i < MAX_DOCX_ZIP_ENTRIES; i++) {
      extras.push({ name: `word/pad-${i}.txt`, method: 0, data: Buffer.from('a') })
    }
    // minimalValidDocxParts adds 2 entries + extras => over the cap when totalEntries counted.
    const zip = buildSyntheticZip(minimalValidDocxParts(extras))
    expect(() => assertDocxZipPreflight(zip)).toThrow(ArtifactPatchMcpError)
    try {
      assertDocxZipPreflight(zip)
    } catch (err) {
      expect((err as ArtifactPatchMcpError).code).toBe('INPUT_TOO_LARGE')
    }
  })

  it('rejects duplicate and unsafe entry names', () => {
    const dup = buildSyntheticZip([
      { name: 'word/document.xml', method: 0, data: Buffer.from('<a/>') },
      { name: 'word/document.xml', method: 0, data: Buffer.from('<b/>') },
    ])
    try {
      assertDocxZipPreflight(dup)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as ArtifactPatchMcpError).code).toBe('INVALID_DOCX')
    }

    const unsafe = buildSyntheticZip([
      { name: 'word/document.xml', method: 0, data: Buffer.from('<a/>') },
      { name: '../evil.xml', method: 0, data: Buffer.from('x') },
    ])
    try {
      assertDocxZipPreflight(unsafe)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as ArtifactPatchMcpError).code).toBe('INVALID_DOCX')
    }
  })

  it('enforces ZIP preflight through the MCP inspect handler before parseDocx', async () => {
    await withTempRoot(async (root) => {
      const zip = buildSyntheticZip(
        minimalValidDocxParts([
          {
            name: 'word/huge.bin',
            method: 0,
            data: Buffer.from('x'),
            advertisedUncompressed: MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1,
            advertisedCompressed: 1,
          },
        ]),
      )
      await writeFile(join(root, 'forged.docx'), zip)
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const result = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'forged.docx' },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'INPUT_TOO_LARGE' })
      expect(JSON.stringify(result)).not.toContain(root)
    })
  })

  it('accepts a normal DOCX through the MCP inspect handler after preflight', async () => {
    await withTempRoot(async (root) => {
      const bytes = await buildDocx({
        bodyXml: '<w:p><w:r><w:t>PreflightOK</w:t></w:r></w:p>',
      })
      await writeFile(join(root, 'ok.docx'), bytes)
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const result = await pair.client.callTool({
        name: 'docx_inspect',
        arguments: { sourcePath: 'ok.docx' },
      })
      expect(result.isError).not.toBe(true)
      const sc = result.structuredContent as {
        blocks: Array<{ text: string }>
      }
      expect(sc.blocks.some((b) => b.text.includes('PreflightOK'))).toBe(true)
    })
  })
})
