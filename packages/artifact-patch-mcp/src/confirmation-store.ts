import { randomBytes as nodeRandomBytes } from 'node:crypto'
import type { DocxPatchProposal } from '@genoffice/artifact-patch'
import { ArtifactPatchMcpError } from './errors'
import {
  MAX_PENDING_CONFIRMATION_TEXT_CHARS,
  MAX_PROPOSAL_TEXT_CHARS,
  proposalRetainedTextChars,
} from './limits'
import { DEFAULT_CONFIRMATION_TTL_MS, MAX_PENDING_CONFIRMATIONS } from './path-policy'

export interface ConfirmationRecord {
  confirmationRef: string
  sourceRelativePath: string
  destinationRelativePath: string
  proposal: DocxPatchProposal
  proposalId: string
  maxCompressedBytes?: number
  expiresAtMs: number
  createdAtMs: number
  /** Characters of proposal text retained for this record (expected+replacement). */
  retainedTextChars: number
}

export interface ConfirmationStoreOptions {
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  ttlMs?: number
  maxPending?: number
  maxPendingTextChars?: number
  maxProposalTextChars?: number
}

/**
 * In-memory one-use confirmation store.
 * Cryptographically random opaque refs (>=128 bits). Bound by count and retained text budget.
 */
export class ConfirmationStore {
  private readonly now: () => number
  private readonly randomBytes: (size: number) => Uint8Array
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly maxPendingTextChars: number
  private readonly maxProposalTextChars: number
  private readonly records = new Map<string, ConfirmationRecord>()
  private pendingTextChars = 0

  constructor(opts: ConfirmationStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.randomBytes = opts.randomBytes ?? ((size) => nodeRandomBytes(size))
    this.ttlMs = opts.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS
    this.maxPending = opts.maxPending ?? MAX_PENDING_CONFIRMATIONS
    this.maxPendingTextChars = opts.maxPendingTextChars ?? MAX_PENDING_CONFIRMATION_TEXT_CHARS
    this.maxProposalTextChars = opts.maxProposalTextChars ?? MAX_PROPOSAL_TEXT_CHARS
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'confirmation TTL is invalid')
    }
    if (
      !Number.isSafeInteger(this.maxPending) ||
      this.maxPending <= 0 ||
      this.maxPending > MAX_PENDING_CONFIRMATIONS
    ) {
      throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'confirmation capacity is invalid')
    }
    if (
      !Number.isSafeInteger(this.maxPendingTextChars) ||
      this.maxPendingTextChars <= 0 ||
      this.maxPendingTextChars > MAX_PENDING_CONFIRMATION_TEXT_CHARS
    ) {
      throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'confirmation text capacity is invalid')
    }
    if (
      !Number.isSafeInteger(this.maxProposalTextChars) ||
      this.maxProposalTextChars <= 0 ||
      this.maxProposalTextChars > MAX_PROPOSAL_TEXT_CHARS
    ) {
      throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'proposal text capacity is invalid')
    }
  }

  get size(): number {
    this.evictExpired()
    return this.records.size
  }

  /** Aggregate retained proposal text characters across pending confirmations. */
  get retainedTextChars(): number {
    this.evictExpired()
    return this.pendingTextChars
  }

  put(input: {
    sourceRelativePath: string
    destinationRelativePath: string
    proposal: DocxPatchProposal
    maxCompressedBytes?: number
  }): { confirmationRef: string; expiresAt: string } {
    this.evictExpired()

    const retainedTextChars = proposalRetainedTextChars(input.proposal)
    // Reject without mutating store state when a single record cannot fit the budgets.
    if (
      retainedTextChars > this.maxProposalTextChars ||
      retainedTextChars > this.maxPendingTextChars
    ) {
      throw new ArtifactPatchMcpError(
        'INPUT_TOO_LARGE',
        'proposal text exceeds confirmation budget',
      )
    }

    // Validate all failure-prone record material before capacity eviction so an RNG/clock
    // failure or token collision cannot discard an otherwise valid pending confirmation.
    const random = this.randomBytes(16)
    if (!(random instanceof Uint8Array) || random.byteLength < 16) {
      throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'confirmation randomness is invalid')
    }
    const confirmationRef = Buffer.from(random).toString('base64url')
    if (this.records.has(confirmationRef)) {
      throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'confirmation reference collision')
    }
    const createdAtMs = this.now()
    const expiresAtMs = createdAtMs + this.ttlMs
    if (
      !Number.isSafeInteger(createdAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      Number.isNaN(new Date(expiresAtMs).valueOf())
    ) {
      throw new ArtifactPatchMcpError('INTERNAL_ERROR', 'confirmation clock is invalid')
    }

    while (
      this.records.size >= this.maxPending ||
      this.pendingTextChars + retainedTextChars > this.maxPendingTextChars
    ) {
      if (this.records.size === 0) {
        // Should be unreachable given the single-record checks above.
        throw new ArtifactPatchMcpError(
          'INPUT_TOO_LARGE',
          'proposal text exceeds confirmation budget',
        )
      }
      this.evictOldest()
    }
    const record: ConfirmationRecord = {
      confirmationRef,
      sourceRelativePath: input.sourceRelativePath,
      destinationRelativePath: input.destinationRelativePath,
      proposal: input.proposal,
      proposalId: input.proposal.id,
      maxCompressedBytes: input.maxCompressedBytes,
      expiresAtMs,
      createdAtMs,
      retainedTextChars,
    }
    this.records.set(confirmationRef, record)
    this.pendingTextChars += retainedTextChars
    return {
      confirmationRef,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  /**
   * Atomically consume a confirmation if ref+proposalId match and not expired.
   * On any mismatch/expiry the ref is not reusable (consumed or already gone).
   */
  consume(confirmationRef: string, proposalId: string): ConfirmationRecord {
    // Look up before bulk expiry eviction so a still-present expired ref
    // surfaces CONFIRMATION_EXPIRED rather than CONFIRMATION_REQUIRED.
    const record = this.records.get(confirmationRef)
    if (!record) {
      this.evictExpired()
      throw new ArtifactPatchMcpError(
        'CONFIRMATION_REQUIRED',
        'confirmation is missing, expired, or already used',
      )
    }
    // Always delete first — one-use even on mismatch/failure of caller.
    this.deleteRecord(confirmationRef)

    if (record.expiresAtMs <= this.now()) {
      throw new ArtifactPatchMcpError('CONFIRMATION_EXPIRED', 'confirmation expired')
    }
    if (record.proposalId !== proposalId) {
      throw new ArtifactPatchMcpError(
        'CONFIRMATION_MISMATCH',
        'proposalId does not match confirmation',
      )
    }
    return record
  }

  /** Test helper: peek without consuming. */
  peek(confirmationRef: string): ConfirmationRecord | undefined {
    this.evictExpired()
    return this.records.get(confirmationRef)
  }

  private deleteRecord(confirmationRef: string): void {
    const record = this.records.get(confirmationRef)
    if (!record) return
    this.records.delete(confirmationRef)
    this.pendingTextChars -= record.retainedTextChars
    if (this.pendingTextChars < 0) {
      this.pendingTextChars = 0
    }
  }

  private evictExpired(): void {
    const now = this.now()
    for (const [ref, record] of this.records) {
      if (record.expiresAtMs <= now) {
        this.deleteRecord(ref)
      }
    }
  }

  private evictOldest(): void {
    let oldestRef: string | undefined
    let oldestCreated = Number.POSITIVE_INFINITY
    for (const [ref, record] of this.records) {
      if (record.createdAtMs < oldestCreated) {
        oldestCreated = record.createdAtMs
        oldestRef = ref
      }
    }
    if (oldestRef !== undefined) {
      this.deleteRecord(oldestRef)
    }
  }
}
