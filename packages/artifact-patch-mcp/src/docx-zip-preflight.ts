import { inflateRawSync } from 'node:zlib'
import { ArtifactPatchMcpError } from './errors'

/** Maximum number of ZIP entries accepted in an MCP DOCX. */
export const MAX_DOCX_ZIP_ENTRIES = 512

/** Per-entry uncompressed expansion cap (bytes). */
export const MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

/** Aggregate uncompressed expansion cap across all entries (bytes). */
export const MAX_DOCX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024

const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50
const CENTRAL_DIR_SIG = 0x02014b50
const LOCAL_FILE_SIG = 0x04034b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const GP_ENCRYPTED = 0x0001
const MAX_EOCD_SCAN = 22 + 0xffff

const REQUIRED_ENTRY = 'word/document.xml'

interface CentralEntry {
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  fileName: string
}

function u16(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8)
}

function u32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  )
}

function assertInBounds(buf: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buf.byteLength
  ) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP structure is out of bounds')
  }
}

function findEocdOffset(buf: Uint8Array): number {
  const end = buf.byteLength
  if (end < 22) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'input is not a valid supported DOCX')
  }
  const minScan = Math.max(0, end - MAX_EOCD_SCAN)
  for (let i = end - 22; i >= minScan; i--) {
    if (u32(buf, i) === EOCD_SIG) {
      const commentLen = u16(buf, i + 20)
      if (i + 22 + commentLen === end) {
        return i
      }
    }
  }
  throw new ArtifactPatchMcpError('INVALID_DOCX', 'input is not a valid supported DOCX')
}

function rejectZip64Markers(buf: Uint8Array, eocdOffset: number): void {
  // ZIP64 end-of-central-directory locator sits immediately before EOCD when present.
  if (eocdOffset >= 20 && u32(buf, eocdOffset - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP64 archives are not supported')
  }
}

function isUnsafeZipName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return true
  if (name.includes('\0')) return true
  if (name.includes('\\')) return true
  if (name.startsWith('/') || name.startsWith('./')) return true
  // Allow a single trailing slash for directory entries only.
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name
  if (trimmed.length === 0) return true
  const segments = trimmed.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return true
  }
  return false
}

function parseCentralDirectory(buf: Uint8Array): CentralEntry[] {
  const eocdOffset = findEocdOffset(buf)
  rejectZip64Markers(buf, eocdOffset)

  assertInBounds(buf, eocdOffset, 22)
  const diskNumber = u16(buf, eocdOffset + 4)
  const cdStartDisk = u16(buf, eocdOffset + 6)
  const entriesOnDisk = u16(buf, eocdOffset + 8)
  const totalEntries = u16(buf, eocdOffset + 10)
  const cdSize = u32(buf, eocdOffset + 12)
  const cdOffset = u32(buf, eocdOffset + 16)

  if (diskNumber !== 0 || cdStartDisk !== 0) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'multi-disk ZIP archives are not supported')
  }
  if (entriesOnDisk !== totalEntries) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'multi-disk ZIP archives are not supported')
  }
  if (entriesOnDisk === 0xffff || totalEntries === 0xffff) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP64 archives are not supported')
  }
  if (totalEntries > MAX_DOCX_ZIP_ENTRIES) {
    throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP entry count exceeds MCP cap')
  }
  // ZIP64 uses 0xffffffff size/offset markers.
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP64 archives are not supported')
  }

  assertInBounds(buf, cdOffset, cdSize)
  if (cdOffset + cdSize > eocdOffset) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP central directory overlaps EOCD')
  }

  const entries: CentralEntry[] = []
  let cursor = cdOffset
  const cdEnd = cdOffset + cdSize
  const seenNames = new Set<string>()
  let parsedEntryCount = 0

  while (cursor < cdEnd) {
    assertInBounds(buf, cursor, 46)
    if (u32(buf, cursor) !== CENTRAL_DIR_SIG) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'malformed ZIP central directory')
    }
    parsedEntryCount += 1
    if (parsedEntryCount > MAX_DOCX_ZIP_ENTRIES) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP entry count exceeds MCP cap')
    }

    const flags = u16(buf, cursor + 8)
    const method = u16(buf, cursor + 10)
    const compressedSize = u32(buf, cursor + 20)
    const uncompressedSize = u32(buf, cursor + 24)
    const fileNameLength = u16(buf, cursor + 28)
    const extraLength = u16(buf, cursor + 30)
    const commentLength = u16(buf, cursor + 32)
    const diskStart = u16(buf, cursor + 34)
    const localHeaderOffset = u32(buf, cursor + 42)

    const headerSize = 46 + fileNameLength + extraLength + commentLength
    assertInBounds(buf, cursor, headerSize)

    if (diskStart !== 0) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'multi-disk ZIP archives are not supported')
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP64 archives are not supported')
    }
    if ((flags & GP_ENCRYPTED) !== 0) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'encrypted ZIP entries are not supported')
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'unsupported ZIP compression method')
    }

    const nameBytes = buf.subarray(cursor + 46, cursor + 46 + fileNameLength)
    const fileName = Buffer.from(nameBytes).toString('utf8')
    if (isUnsafeZipName(fileName)) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP entry name is unsafe')
    }
    if (seenNames.has(fileName)) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'duplicate ZIP entry names are not allowed')
    }
    seenNames.add(fileName)

    // Directory entries (trailing slash) still count toward the budget but need no payload.
    const isDirectory = fileName.endsWith('/')
    if (!isDirectory) {
      entries.push({
        method,
        flags,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        fileName,
      })
    }

    cursor += headerSize
  }

  if (cursor !== cdEnd) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'malformed ZIP central directory size')
  }
  if (parsedEntryCount !== totalEntries) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP entry count does not match EOCD')
  }
  if (!seenNames.has(REQUIRED_ENTRY)) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'input is not a valid supported DOCX')
  }

  return entries
}

function readLocalCompressedPayload(buf: Uint8Array, entry: CentralEntry): Uint8Array {
  const offset = entry.localHeaderOffset
  assertInBounds(buf, offset, 30)
  if (u32(buf, offset) !== LOCAL_FILE_SIG) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'malformed ZIP local file header')
  }

  const localFlags = u16(buf, offset + 6)
  const localMethod = u16(buf, offset + 8)
  const localNameLen = u16(buf, offset + 26)
  const localExtraLen = u16(buf, offset + 28)

  if ((localFlags & GP_ENCRYPTED) !== 0) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'encrypted ZIP entries are not supported')
  }
  if (localMethod !== entry.method) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP local/central compression mismatch')
  }

  const nameStart = offset + 30
  assertInBounds(buf, nameStart, localNameLen + localExtraLen)
  const localName = Buffer.from(buf.subarray(nameStart, nameStart + localNameLen)).toString('utf8')
  if (localName !== entry.fileName) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP local/central name mismatch')
  }

  const dataStart = nameStart + localNameLen + localExtraLen
  assertInBounds(buf, dataStart, entry.compressedSize)
  return buf.subarray(dataStart, dataStart + entry.compressedSize)
}

function expandEntryBounded(
  compressed: Uint8Array,
  entry: CentralEntry,
  maxOutputLength: number,
): number {
  if (maxOutputLength < 0 || !Number.isSafeInteger(maxOutputLength)) {
    throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'ZIP expansion budget is invalid')
  }

  // Fast-reject using central-directory advertisement when present and trustworthy-looking.
  if (entry.uncompressedSize > maxOutputLength) {
    throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP expansion exceeds MCP cap')
  }

  if (entry.method === METHOD_STORE) {
    if (compressed.byteLength > maxOutputLength) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP expansion exceeds MCP cap')
    }
    // STORE payload is already expanded; do not retain a copy.
    if (
      entry.uncompressedSize !== 0 &&
      entry.uncompressedSize !== compressed.byteLength &&
      // When the data-descriptor bit is set, local sizes may be zeroed; CD should still match.
      (entry.flags & 0x0008) === 0
    ) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'STORE entry size mismatch')
    }
    return compressed.byteLength
  }

  // DEFLATE
  let expanded: Buffer
  try {
    expanded = inflateRawSync(
      Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength),
      {
        maxOutputLength,
      },
    )
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP expansion exceeds MCP cap')
    }
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'malformed DEFLATE payload')
  }

  const actual = expanded.byteLength
  if (actual > maxOutputLength) {
    throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP expansion exceeds MCP cap')
  }
  if (
    entry.uncompressedSize !== 0 &&
    entry.uncompressedSize !== actual &&
    (entry.flags & 0x0008) === 0
  ) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'DEFLATE entry size mismatch')
  }
  return actual
}

/**
 * MCP-layer DOCX ZIP preflight over already-bounded source bytes.
 * Fail-closed before inspectDocx/parseDocx or the apply runtime path.
 * Processes one entry at a time and does not retain expanded payloads.
 */
export function assertDocxZipPreflight(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new ArtifactPatchMcpError('INVALID_DOCX', 'input is not a valid supported DOCX')
  }

  const entries = parseCentralDirectory(bytes)
  if (entries.length > MAX_DOCX_ZIP_ENTRIES) {
    throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP entry count exceeds MCP cap')
  }

  let totalExpanded = 0
  for (const entry of entries) {
    const remaining = MAX_DOCX_ZIP_TOTAL_UNCOMPRESSED_BYTES - totalExpanded
    if (remaining <= 0) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP expansion exceeds MCP cap')
    }
    const entryBudget = Math.min(MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES, remaining)
    if (entry.uncompressedSize > entryBudget) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP expansion exceeds MCP cap')
    }
    if (entry.compressedSize > bytes.byteLength) {
      throw new ArtifactPatchMcpError('INVALID_DOCX', 'ZIP compressed size is invalid')
    }

    const compressed = readLocalCompressedPayload(bytes, entry)
    const expanded = expandEntryBounded(compressed, entry, entryBudget)
    totalExpanded += expanded
    if (totalExpanded > MAX_DOCX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ArtifactPatchMcpError('INPUT_TOO_LARGE', 'DOCX ZIP expansion exceeds MCP cap')
    }
  }
}
