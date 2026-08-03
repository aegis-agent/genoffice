import { createHash, randomBytes } from 'node:crypto'
import {
  open as fsOpen,
  link as fsLink,
  lstat as fsLstat,
  readFile as fsReadFile,
  realpath as fsRealpath,
  unlink as fsUnlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  parseDocx,
  patchBodyParagraphText,
  saveDocx,
  type Block,
  type SaveBlock,
} from '@genoffice/docx-engine'
import { z } from 'zod'

/** Default compressed DOCX input size cap (64 MiB). */
export const DEFAULT_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024

/** Absolute upper bound accepted for maxCompressedBytes option. */
export const MAX_MAX_COMPRESSED_BYTES = 512 * 1024 * 1024

/** Bound for path strings at the file-apply boundary. */
export const MAX_PATH_CHARS = 4096

/** Bound for expectedText and replacementText on the one-block tracer op. */
export const MAX_REPLACEMENT_TEXT_CHARS = 32_768
export const MAX_EXPECTED_TEXT_CHARS = 32_768

export const INSPECTION_VERSION = 'docx-inspection/v1' as const
export const PROPOSAL_VERSION = 'docx-proposal/v1' as const
export const PROVENANCE_VERSION = 'docx-provenance/v1' as const

export type ArtifactPatchErrorCode =
  | 'INPUT_TOO_LARGE'
  | 'INVALID_DOCX'
  | 'INVALID_PROPOSAL'
  | 'DUPLICATE_ANCHOR'
  | 'CR_LF_REJECTED'
  | 'STALE_EXPECTED_TEXT'
  | 'ANCHOR_NOT_EDITABLE'
  | 'SOURCE_HASH_MISMATCH'
  | 'PROPOSAL_ID_MISMATCH'
  | 'SAME_PATH'
  | 'DESTINATION_EXISTS'
  | 'APPLY_FAILED'
  | 'ROUNDTRIP_FAILED'
  | 'PUBLICATION_FAILED'
  | 'IO_ERROR'

export class ArtifactPatchError extends Error {
  readonly code: ArtifactPatchErrorCode

  constructor(code: ArtifactPatchErrorCode, message: string) {
    super(message)
    this.name = 'ArtifactPatchError'
    this.code = code
  }
}

export interface SourceBinding {
  sha256: string
  byteLength: number
}

export interface InspectedBlock {
  docxIndex: number
  type: Block['type']
  /** Exact plain text of editable runs; empty string when none. */
  text: string
  textReplaceSupported: boolean
}

export interface DocxInspection {
  version: typeof INSPECTION_VERSION
  source: SourceBinding
  blocks: InspectedBlock[]
}

const sourceBindingSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
  })
  .strict()

const replaceBlockTextOpSchema = z
  .object({
    op: z.literal('replace_block_text'),
    docxIndex: z.number().int().nonnegative(),
    expectedText: z.string().max(MAX_EXPECTED_TEXT_CHARS),
    replacementText: z.string().max(MAX_REPLACEMENT_TEXT_CHARS),
  })
  .strict()

export const docxPatchProposalRequestSchema = z
  .object({
    source: sourceBindingSchema,
    operations: z.array(replaceBlockTextOpSchema).min(1),
  })
  .strict()

export type ReplaceBlockTextOp = z.infer<typeof replaceBlockTextOpSchema>
export type DocxPatchProposalRequest = z.infer<typeof docxPatchProposalRequestSchema>

export interface DocxPatchProposal {
  version: typeof PROPOSAL_VERSION
  id: string
  source: SourceBinding
  operations: ReplaceBlockTextOp[]
}

export interface PreviewEntry {
  docxIndex: number
  beforeText: string
  afterText: string
}

export interface DocxPatchPreview {
  proposalId: string
  entries: PreviewEntry[]
}

export interface RoundtripValidation {
  ok: boolean
  checkedAnchors: number
  changedAnchors: number
  failures: Array<{ docxIndex: number; reason: string }>
}

export interface ProvenanceOperation {
  op: 'replace_block_text'
  docxIndex: number
  beforeTextSha256: string
  afterTextSha256: string
}

export interface DocxProvenanceManifest {
  version: typeof PROVENANCE_VERSION
  format: 'docx'
  proposalId: string
  source: SourceBinding
  output: SourceBinding
  operations: ProvenanceOperation[]
  appliedAt: string
  roundtrip: {
    ok: boolean
    checkedAnchors: number
    changedAnchors: number
    failureCount: number
  }
}

const provenanceOperationSchema = z
  .object({
    op: z.literal('replace_block_text'),
    docxIndex: z.number().int().nonnegative(),
    beforeTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    afterTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

/** Strict versioned provenance manifest schema (public). */
export const docxProvenanceManifestSchema = z
  .object({
    version: z.literal(PROVENANCE_VERSION),
    format: z.literal('docx'),
    proposalId: z.string().regex(/^[a-f0-9]{64}$/),
    source: sourceBindingSchema,
    output: sourceBindingSchema,
    operations: z.array(provenanceOperationSchema).min(1),
    appliedAt: z.iso.datetime(),
    roundtrip: z
      .object({
        ok: z.boolean(),
        checkedAnchors: z.number().int().nonnegative(),
        changedAnchors: z.number().int().nonnegative(),
        failureCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export type DocxProvenanceManifestParsed = z.infer<typeof docxProvenanceManifestSchema>

export interface ApplyDocxPatchResult {
  bytes: Uint8Array
  validation: RoundtripValidation
  manifest: DocxProvenanceManifest
}

export interface ApplyDocxPatchToCopyResult {
  manifest: DocxProvenanceManifest
}

/** Narrow injectable filesystem surface for deterministic publication tests. */
export interface ApplyDocxPatchToCopyFs {
  open: (path: string, flags: string | number, mode?: number) => Promise<FileHandle>
  link: (existingPath: string, newPath: string) => Promise<void>
  unlink: (path: string) => Promise<void>
  readFile: (path: string) => Promise<Buffer | Uint8Array>
  lstat: (path: string) => Promise<unknown>
  realpath: (path: string) => Promise<string>
}

const defaultFs: ApplyDocxPatchToCopyFs = {
  open: fsOpen,
  link: fsLink,
  unlink: fsUnlink,
  readFile: fsReadFile,
  lstat: fsLstat,
  realpath: fsRealpath,
}

const pathStringSchema = z.string().min(1).max(MAX_PATH_CHARS)

const maxCompressedBytesSchema = z.number().int().positive().max(MAX_MAX_COMPRESSED_BYTES)

/** Strict runtime boundary schema for applyDocxPatchToCopy arguments. */
export const applyDocxPatchToCopyArgsSchema = z
  .object({
    sourcePath: pathStringSchema,
    destinationPath: pathStringSchema,
    proposal: z.unknown(),
    appliedAt: z.iso.datetime(),
    maxCompressedBytes: maxCompressedBytesSchema.optional(),
  })
  .strict()

const applyDocxPatchOptsSchema = z
  .object({
    appliedAt: z.iso.datetime(),
    maxCompressedBytes: maxCompressedBytesSchema.optional(),
  })
  .strict()

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function assertCompressedSize(bytes: Uint8Array, maxCompressedBytes: number): void {
  if (bytes.byteLength > maxCompressedBytes) {
    throw new ArtifactPatchError(
      'INPUT_TOO_LARGE',
      `compressed input exceeds cap of ${maxCompressedBytes} bytes`,
    )
  }
}

function blockPlainText(block: Block): string {
  if (block.runs && block.runs.length > 0) {
    return block.runs.map((r) => r.text).join('')
  }
  return block.previewText ?? ''
}

function isTextReplaceSupported(block: Block): boolean {
  if (block.hidden) return false
  if (block.docxIndex === null) return false
  if (block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'listItem') {
    return false
  }
  if (!block.originalXml) return false
  if (!block.runs || block.runs.length === 0) return false
  // Complex field / formula body paragraphs stay protected in this slice.
  if (block.fieldDisplay || block.formulaDisplay) return false
  return true
}

export async function inspectDocx(
  bytes: Uint8Array,
  opts: { maxCompressedBytes?: number } = {},
): Promise<DocxInspection> {
  const maxCompressedBytes = opts.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES
  assertCompressedSize(bytes, maxCompressedBytes)
  const source: SourceBinding = {
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
  }
  let parsed: Awaited<ReturnType<typeof parseDocx>>
  try {
    parsed = await parseDocx(bytes)
  } catch {
    throw new ArtifactPatchError('INVALID_DOCX', 'input is not a valid supported DOCX')
  }
  const blocks: InspectedBlock[] = []
  for (const block of parsed.blocks) {
    if (block.hidden || block.docxIndex === null) continue
    blocks.push({
      docxIndex: block.docxIndex,
      type: block.type,
      text: blockPlainText(block),
      textReplaceSupported: isTextReplaceSupported(block),
    })
  }
  return {
    version: INSPECTION_VERSION,
    source,
    blocks,
  }
}

function containsCrLf(s: string): boolean {
  return s.includes('\r') || s.includes('\n')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

function computeProposalId(source: SourceBinding, operations: ReplaceBlockTextOp[]): string {
  return sha256Hex(
    canonicalJson({
      version: PROPOSAL_VERSION,
      source,
      operations,
    }),
  )
}

function parseProposalRequest(input: unknown): DocxPatchProposalRequest {
  const parsed = docxPatchProposalRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new ArtifactPatchError('INVALID_PROPOSAL', 'proposal request failed schema validation')
  }
  return parsed.data
}

function assertNoCrLfOps(operations: ReplaceBlockTextOp[]): void {
  for (const op of operations) {
    if (containsCrLf(op.expectedText) || containsCrLf(op.replacementText)) {
      throw new ArtifactPatchError(
        'CR_LF_REJECTED',
        'replace_block_text rejects CR/LF in expectedText and replacementText',
      )
    }
  }
}

function assertUniqueAnchors(operations: ReplaceBlockTextOp[]): void {
  const seen = new Set<number>()
  for (const op of operations) {
    if (seen.has(op.docxIndex)) {
      throw new ArtifactPatchError('DUPLICATE_ANCHOR', 'duplicate docxIndex in operations')
    }
    seen.add(op.docxIndex)
  }
}

function assertInspectionBinding(inspection: DocxInspection): void {
  if (
    !inspection ||
    inspection.version !== INSPECTION_VERSION ||
    !inspection.source ||
    !Array.isArray(inspection.blocks)
  ) {
    throw new ArtifactPatchError('INVALID_PROPOSAL', 'inspection is required and must be versioned')
  }
}

/**
 * Build a versioned proposal bound to an actual inspection.
 * Rejects source mismatch, stale expected text, non-editable anchors, and duplicates
 * at creation time (not deferred to preview).
 */
export function createDocxPatchProposal(
  inspection: DocxInspection,
  input: unknown,
): DocxPatchProposal {
  assertInspectionBinding(inspection)
  const req = parseProposalRequest(input)
  assertNoCrLfOps(req.operations)
  assertUniqueAnchors(req.operations)

  if (
    req.source.sha256 !== inspection.source.sha256 ||
    req.source.byteLength !== inspection.source.byteLength
  ) {
    throw new ArtifactPatchError('SOURCE_HASH_MISMATCH', 'proposal source binding does not match')
  }

  const byIndex = new Map(inspection.blocks.map((b) => [b.docxIndex, b]))
  for (const op of req.operations) {
    const block = byIndex.get(op.docxIndex)
    if (!block || !block.textReplaceSupported) {
      throw new ArtifactPatchError('ANCHOR_NOT_EDITABLE', 'operation targets a non-editable anchor')
    }
    if (block.text !== op.expectedText) {
      throw new ArtifactPatchError('STALE_EXPECTED_TEXT', 'expectedText does not match inspection')
    }
  }

  const operations = [...req.operations].sort((a, b) => a.docxIndex - b.docxIndex)
  const id = computeProposalId(req.source, operations)
  return {
    version: PROPOSAL_VERSION,
    id,
    source: req.source,
    operations,
  }
}

const docxPatchProposalSchema = z
  .object({
    version: z.literal(PROPOSAL_VERSION),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    source: sourceBindingSchema,
    operations: z.array(replaceBlockTextOpSchema).min(1),
  })
  .strict()

function parseProposal(input: unknown): DocxPatchProposal {
  const parsed = docxPatchProposalSchema.safeParse(input)
  if (!parsed.success) {
    throw new ArtifactPatchError('INVALID_PROPOSAL', 'proposal failed schema validation')
  }
  return parsed.data
}

function assertProposalShape(proposal: DocxPatchProposal): void {
  assertNoCrLfOps(proposal.operations)
  assertUniqueAnchors(proposal.operations)
  const sorted = [...proposal.operations].sort((a, b) => a.docxIndex - b.docxIndex)
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== proposal.operations[i]) {
      throw new ArtifactPatchError('INVALID_PROPOSAL', 'operations must be sorted by docxIndex')
    }
  }
  const expectedId = computeProposalId(proposal.source, proposal.operations)
  if (expectedId !== proposal.id) {
    throw new ArtifactPatchError(
      'PROPOSAL_ID_MISMATCH',
      'proposal id does not match canonical body',
    )
  }
}

function assertProposalAgainstInspection(
  proposal: DocxPatchProposal,
  inspection: DocxInspection,
): void {
  assertProposalShape(proposal)
  if (
    proposal.source.sha256 !== inspection.source.sha256 ||
    proposal.source.byteLength !== inspection.source.byteLength
  ) {
    throw new ArtifactPatchError('SOURCE_HASH_MISMATCH', 'proposal source binding does not match')
  }
  const byIndex = new Map(inspection.blocks.map((b) => [b.docxIndex, b]))
  for (const op of proposal.operations) {
    const block = byIndex.get(op.docxIndex)
    if (!block || !block.textReplaceSupported) {
      throw new ArtifactPatchError('ANCHOR_NOT_EDITABLE', 'operation targets a non-editable anchor')
    }
    if (block.text !== op.expectedText) {
      throw new ArtifactPatchError('STALE_EXPECTED_TEXT', 'expectedText does not match inspection')
    }
  }
}

export function previewDocxPatch(
  proposalInput: unknown,
  inspection: DocxInspection,
): DocxPatchPreview {
  const proposal = parseProposal(proposalInput)
  assertProposalAgainstInspection(proposal, inspection)
  const byIndex = new Map(inspection.blocks.map((b) => [b.docxIndex, b]))
  const entries: PreviewEntry[] = proposal.operations.map((op) => {
    const block = byIndex.get(op.docxIndex)!
    return {
      docxIndex: op.docxIndex,
      beforeText: block.text,
      afterText: op.replacementText,
    }
  })
  return { proposalId: proposal.id, entries }
}

function compareRoundtrip(
  before: DocxInspection,
  after: DocxInspection,
  proposal: DocxPatchProposal,
): RoundtripValidation {
  const beforeBy = new Map(before.blocks.map((b) => [b.docxIndex, b]))
  const afterBy = new Map(after.blocks.map((b) => [b.docxIndex, b]))
  const changed = new Map(proposal.operations.map((o) => [o.docxIndex, o]))
  const failures: RoundtripValidation['failures'] = []
  let checkedAnchors = 0
  let changedAnchors = 0

  for (const [idx, op] of changed) {
    changedAnchors++
    checkedAnchors++
    const blk = afterBy.get(idx)
    if (!blk) {
      failures.push({ docxIndex: idx, reason: 'missing_after' })
      continue
    }
    if (blk.text !== op.replacementText) {
      failures.push({ docxIndex: idx, reason: 'text_mismatch' })
    }
  }

  for (const b of before.blocks) {
    if (!b.textReplaceSupported) continue
    if (changed.has(b.docxIndex)) continue
    checkedAnchors++
    const a = afterBy.get(b.docxIndex)
    if (!a) {
      failures.push({ docxIndex: b.docxIndex, reason: 'missing_untouched' })
      continue
    }
    if (a.text !== b.text) {
      failures.push({ docxIndex: b.docxIndex, reason: 'untouched_changed' })
    }
  }

  for (const op of proposal.operations) {
    const b = beforeBy.get(op.docxIndex)
    if (!b || b.text !== op.expectedText) {
      failures.push({ docxIndex: op.docxIndex, reason: 'before_expected_mismatch' })
    }
  }

  return {
    ok: failures.length === 0,
    checkedAnchors,
    changedAnchors,
    failures,
  }
}

/**
 * Explicit roundtrip validation step: revalidates proposal/source binding, parses both
 * artifacts, returns structured semantic failures (no raw text/paths).
 */
export async function validateDocxRoundtrip(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
  proposalInput: unknown,
  limits: { maxCompressedBytes?: number } = {},
): Promise<RoundtripValidation> {
  const maxCompressedBytes = limits.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES
  assertCompressedSize(sourceBytes, maxCompressedBytes)
  assertCompressedSize(outputBytes, maxCompressedBytes)
  const proposal = parseProposal(proposalInput)
  assertProposalShape(proposal)

  const sourceBinding: SourceBinding = {
    sha256: sha256Hex(sourceBytes),
    byteLength: sourceBytes.byteLength,
  }
  if (
    proposal.source.sha256 !== sourceBinding.sha256 ||
    proposal.source.byteLength !== sourceBinding.byteLength
  ) {
    throw new ArtifactPatchError('SOURCE_HASH_MISMATCH', 'proposal source binding does not match')
  }

  const before = await inspectDocx(sourceBytes, { maxCompressedBytes })
  assertProposalAgainstInspection(proposal, before)
  const after = await inspectDocx(outputBytes, { maxCompressedBytes })
  return compareRoundtrip(before, after, proposal)
}

function buildManifest(args: {
  proposal: DocxPatchProposal
  outputBytes: Uint8Array
  appliedAt: string
  validation: RoundtripValidation
}): DocxProvenanceManifest {
  const candidate: DocxProvenanceManifest = {
    version: PROVENANCE_VERSION,
    format: 'docx',
    proposalId: args.proposal.id,
    source: { ...args.proposal.source },
    output: {
      sha256: sha256Hex(args.outputBytes),
      byteLength: args.outputBytes.byteLength,
    },
    operations: args.proposal.operations.map((op) => ({
      op: 'replace_block_text' as const,
      docxIndex: op.docxIndex,
      beforeTextSha256: sha256Hex(op.expectedText),
      afterTextSha256: sha256Hex(op.replacementText),
    })),
    appliedAt: args.appliedAt,
    roundtrip: {
      ok: args.validation.ok,
      checkedAnchors: args.validation.checkedAnchors,
      changedAnchors: args.validation.changedAnchors,
      failureCount: args.validation.failures.length,
    },
  }
  const parsed = docxProvenanceManifestSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new ArtifactPatchError('APPLY_FAILED', 'provenance manifest failed schema validation')
  }
  return parsed.data
}

async function applyDocxPatchBytes(
  sourceBytes: Uint8Array,
  proposal: DocxPatchProposal,
  opts: { maxCompressedBytes: number; appliedAt: string },
): Promise<ApplyDocxPatchResult> {
  const { maxCompressedBytes, appliedAt } = opts
  assertCompressedSize(sourceBytes, maxCompressedBytes)
  const inspection = await inspectDocx(sourceBytes, { maxCompressedBytes })
  assertProposalAgainstInspection(proposal, inspection)

  const parsed = await parseDocx(sourceBytes)
  const opByIndex = new Map(proposal.operations.map((o) => [o.docxIndex, o]))
  const finalBlocks: SaveBlock[] = []

  for (const block of parsed.blocks) {
    if (block.hidden || block.docxIndex === null) continue
    const op = opByIndex.get(block.docxIndex)
    if (!op) {
      finalBlocks.push({ kind: 'original', docxIndex: block.docxIndex })
      continue
    }
    if (!block.originalXml) {
      throw new ArtifactPatchError('APPLY_FAILED', 'editable block missing originalXml')
    }
    const patched = patchBodyParagraphText(block.originalXml, op.replacementText)
    if (patched === null) {
      throw new ArtifactPatchError('APPLY_FAILED', 'surgical paragraph patch failed')
    }
    finalBlocks.push({ kind: 'xml', xml: patched, docxIndex: block.docxIndex })
  }

  // All-or-nothing: only produce bytes after every op resolved.
  if (finalBlocks.filter((b) => b.kind === 'xml').length !== proposal.operations.length) {
    throw new ArtifactPatchError('APPLY_FAILED', 'not all operations resolved to body blocks')
  }

  let outBytes: Uint8Array
  try {
    outBytes = await saveDocx(parsed, finalBlocks, {
      savedAt: appliedAt,
    })
  } catch {
    throw new ArtifactPatchError('APPLY_FAILED', 'docx save failed')
  }

  const validation = await validateDocxRoundtrip(sourceBytes, outBytes, proposal, {
    maxCompressedBytes,
  })
  if (!validation.ok) {
    throw new ArtifactPatchError('ROUNDTRIP_FAILED', 'roundtrip validation failed')
  }

  const manifest = buildManifest({
    proposal,
    outputBytes: outBytes,
    appliedAt,
    validation,
  })

  return { bytes: outBytes, validation, manifest }
}

/** Byte-level apply: revalidates proposal, applies all ops in memory, validates roundtrip. */
export async function applyDocxPatch(
  sourceBytes: Uint8Array,
  proposalInput: unknown,
  opts: { maxCompressedBytes?: number; appliedAt: string },
): Promise<ApplyDocxPatchResult> {
  const parsedOpts = applyDocxPatchOptsSchema.safeParse(opts)
  if (!parsedOpts.success) {
    throw new ArtifactPatchError('INVALID_PROPOSAL', 'apply options failed schema validation')
  }
  const proposal = parseProposal(proposalInput)
  return applyDocxPatchBytes(sourceBytes, proposal, {
    maxCompressedBytes: parsedOpts.data.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES,
    appliedAt: parsedOpts.data.appliedAt,
  })
}

async function pathExists(path: string, fs: ApplyDocxPatchToCopyFs): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return false
    throw new ArtifactPatchError('IO_ERROR', 'failed to inspect filesystem path')
  }
}

/**
 * Best-effort unlink of a destination created by this invocation after failed verification.
 * Cleanup errors do not hide the primary error.
 */
async function rollbackPublishedDestination(
  destinationPath: string,
  fs: Pick<ApplyDocxPatchToCopyFs, 'unlink'> = defaultFs,
): Promise<{ rolledBack: boolean; cleanupError: boolean }> {
  try {
    await fs.unlink(destinationPath)
    return { rolledBack: true, cleanupError: false }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      return { rolledBack: false, cleanupError: false }
    }
    return { rolledBack: false, cleanupError: true }
  }
}

/**
 * Apply a validated proposal to a destination copy.
 *
 * Publication policy (Node 20 fs):
 * - Refuse same path and any pre-existing destination (including dangling symlinks via lstat).
 * - Stage with exclusive create (`wx`), fully write, then `FileHandle.sync()`.
 * - Publish with no-overwrite `fsPromises.link(temp, destination)`; remove only the agent temp.
 * - Re-read destination and verify SHA-256/length against in-memory manifest output.
 * - If post-link verification fails, attempt to unlink the newly created destination.
 *
 * @see https://nodejs.org/docs/latest-v20.x/api/fs.html#fspromisesopenpath-flags-mode
 * @see https://nodejs.org/docs/latest-v20.x/api/fs.html#filehandlesync
 * @see https://nodejs.org/docs/latest-v20.x/api/fs.html#fspromiseslinkexistingpath-newpath
 */
export async function applyDocxPatchToCopy(
  args: unknown,
  /** Trusted host capability for deterministic tests/embedding; never part of the wire object. */
  fs: ApplyDocxPatchToCopyFs = defaultFs,
): Promise<ApplyDocxPatchToCopyResult> {
  const parsedArgs = applyDocxPatchToCopyArgsSchema.safeParse(args)
  if (!parsedArgs.success) {
    throw new ArtifactPatchError('INVALID_PROPOSAL', 'apply-to-copy args failed schema validation')
  }

  const proposal = parseProposal(parsedArgs.data.proposal)
  const appliedAt = parsedArgs.data.appliedAt
  const maxCompressedBytes = parsedArgs.data.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES

  const sourcePath = resolve(parsedArgs.data.sourcePath)
  const destinationPath = resolve(parsedArgs.data.destinationPath)
  if (sourcePath === destinationPath) {
    throw new ArtifactPatchError('SAME_PATH', 'source and destination paths must differ')
  }
  try {
    const resolvedSource = await fs.realpath(sourcePath).catch(() => sourcePath)
    if (await pathExists(destinationPath, fs)) {
      const resolvedDest = await fs.realpath(destinationPath).catch(() => destinationPath)
      if (resolvedSource === resolvedDest) {
        throw new ArtifactPatchError('SAME_PATH', 'source and destination paths must differ')
      }
    }
  } catch (err) {
    if (err instanceof ArtifactPatchError) throw err
  }

  if (await pathExists(destinationPath, fs)) {
    throw new ArtifactPatchError('DESTINATION_EXISTS', 'destination already exists')
  }

  let sourceBytes: Uint8Array
  try {
    const buf = await fs.readFile(sourcePath)
    sourceBytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  } catch {
    throw new ArtifactPatchError('IO_ERROR', 'failed to read source')
  }

  const applied = await applyDocxPatchBytes(sourceBytes, proposal, {
    maxCompressedBytes,
    appliedAt,
  })

  // Manifest output is authoritative for published bytes.
  if (
    applied.manifest.output.sha256 !== sha256Hex(applied.bytes) ||
    applied.manifest.output.byteLength !== applied.bytes.byteLength
  ) {
    throw new ArtifactPatchError('APPLY_FAILED', 'manifest output binding mismatch')
  }

  const destDir = dirname(destinationPath)
  const tempPath = join(destDir, `.genoffice-artifact-patch-${randomBytes(16).toString('hex')}.tmp`)

  let handle: FileHandle | undefined
  let published = false
  let primaryError: unknown
  let tempCleanupError = false

  try {
    // Exclusive create — fails if the temp name collides; never opens existing files for write.
    handle = await fs.open(tempPath, 'wx', 0o600)
    await handle.writeFile(applied.bytes)
    await handle.sync()
    await handle.close()
    handle = undefined

    // No-overwrite atomic publish.
    await fs.link(tempPath, destinationPath)
    published = true
  } catch (err) {
    primaryError = err
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* prefer primary */
      }
    }
    try {
      await fs.unlink(tempPath)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        tempCleanupError = true
        if (!primaryError) primaryError = err
      }
    }
  }

  if (primaryError && !published) {
    const e = primaryError as NodeJS.ErrnoException
    if (e && e.code === 'EEXIST') {
      throw new ArtifactPatchError('DESTINATION_EXISTS', 'destination already exists')
    }
    throw new ArtifactPatchError('PUBLICATION_FAILED', 'failed to publish destination copy')
  }

  if (primaryError && published && tempCleanupError) {
    // Destination linked but temp cleanup failed — do not silently succeed.
    // Leave destination in place only if verification below still passes; still surface error after verify.
  }

  let destBytes: Uint8Array
  try {
    const buf = await fs.readFile(destinationPath)
    destBytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  } catch {
    if (published) {
      await rollbackPublishedDestination(destinationPath, fs)
    }
    throw new ArtifactPatchError('PUBLICATION_FAILED', 'failed to re-read destination')
  }

  const destHash = sha256Hex(destBytes)
  if (
    destHash !== applied.manifest.output.sha256 ||
    destBytes.byteLength !== applied.manifest.output.byteLength
  ) {
    if (published) {
      await rollbackPublishedDestination(destinationPath, fs)
    }
    throw new ArtifactPatchError('PUBLICATION_FAILED', 'destination hash verification failed')
  }

  if (tempCleanupError) {
    throw new ArtifactPatchError('PUBLICATION_FAILED', 'temp cleanup failed after publication')
  }

  // Re-parse manifest at the publication boundary to prove versioned output shape.
  const manifestParsed = docxProvenanceManifestSchema.safeParse(applied.manifest)
  if (!manifestParsed.success) {
    throw new ArtifactPatchError(
      'PUBLICATION_FAILED',
      'provenance manifest failed schema validation',
    )
  }

  return { manifest: manifestParsed.data }
}
