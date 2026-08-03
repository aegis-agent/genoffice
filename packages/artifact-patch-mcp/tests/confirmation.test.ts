import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import { createArtifactPatchMcpServer } from '../src/server'
import { ConfirmationStore } from '../src/confirmation-store'
import { ArtifactPatchMcpError } from '../src/errors'
import { connectServer, installPairCleanup, withTempRoot } from './helpers/mcp-harness'

async function simpleDocx(text = 'Hello'): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`,
  })
}

function errorCode(result: { isError?: boolean; structuredContent?: unknown }): string {
  expect(result.isError).toBe(true)
  return (result.structuredContent as { code: string }).code
}

let destSeq = 0

async function previewOnce(
  client: {
    callTool: (args: {
      name: string
      arguments: Record<string, unknown>
    }) => Promise<{ isError?: boolean; structuredContent?: unknown }>
  },
  ops?: { replacementText?: string; destinationPath?: string },
) {
  const inspect = await client.callTool({
    name: 'docx_inspect',
    arguments: { sourcePath: 'source.docx' },
  })
  const blocks = (
    inspect.structuredContent as {
      blocks: Array<{ docxIndex: number; text: string; textReplaceSupported: boolean }>
    }
  ).blocks
  const a = blocks.find((b) => b.textReplaceSupported)!
  destSeq += 1
  const destinationPath = ops?.destinationPath ?? `out-${destSeq}.docx`
  const preview = await client.callTool({
    name: 'docx_preview_patch',
    arguments: {
      sourcePath: 'source.docx',
      destinationPath,
      operations: [
        {
          op: 'replace_block_text',
          docxIndex: a.docxIndex,
          expectedText: a.text,
          replacementText: ops?.replacementText ?? 'World',
        },
      ],
    },
  })
  expect(preview.isError).not.toBe(true)
  return preview.structuredContent as {
    confirmationRef: string
    proposal: { id: string }
    destinationPath: string
  }
}

describe('confirmation lifecycle', () => {
  const cleanup = installPairCleanup()

  it('requires fresh preview for missing, wrong proposalId, expired, replayed, and failed apply', async () => {
    await withTempRoot(async (root) => {
      let now = 1_000_000
      await writeFile(join(root, 'source.docx'), await simpleDocx())

      const handle = await createArtifactPatchMcpServer({
        artifactRoot: root,
        now: () => now,
        ttlMs: 60_000,
      })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      // Missing ref
      const missing = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: 'no-such-ref-0123456789abcdef',
          proposalId: 'a'.repeat(64),
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(missing)).toBe('CONFIRMATION_REQUIRED')

      const preview = await previewOnce(pair.client)

      // Wrong proposal id — consumes ref
      const wrong = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview.confirmationRef,
          proposalId: 'b'.repeat(64),
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(wrong)).toBe('CONFIRMATION_MISMATCH')

      // Replay of consumed ref
      const replayAfterMismatch = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview.confirmationRef,
          proposalId: preview.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(replayAfterMismatch)).toBe('CONFIRMATION_REQUIRED')

      // Expired
      const preview2 = await previewOnce(pair.client)
      now += 120_000
      const expired = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview2.confirmationRef,
          proposalId: preview2.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(expired)).toBe('CONFIRMATION_EXPIRED')

      // Successful apply then replay
      now = 1_000_000
      const preview3 = await previewOnce(pair.client)
      const ok = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview3.confirmationRef,
          proposalId: preview3.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(ok.isError).not.toBe(true)
      const replay = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview3.confirmationRef,
          proposalId: preview3.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(replay)).toBe('CONFIRMATION_REQUIRED')

      // Apply failure (destination created between preview and apply) consumes ref
      const preview4 = await previewOnce(pair.client, {
        replacementText: 'Again',
        destinationPath: 'race.docx',
      })
      await writeFile(join(root, 'race.docx'), await simpleDocx('blocker'))
      const failApply = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview4.confirmationRef,
          proposalId: preview4.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(failApply)).toBe('DESTINATION_EXISTS')
      const replayFail = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview4.confirmationRef,
          proposalId: preview4.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(replayFail)).toBe('CONFIRMATION_REQUIRED')
    })
  })

  it('fails closed when source changes after preview', async () => {
    await withTempRoot(async (root) => {
      await writeFile(join(root, 'source.docx'), await simpleDocx('Hello'))
      const handle = await createArtifactPatchMcpServer({ artifactRoot: root })
      const pair = await connectServer(handle.server)
      cleanup.track(pair)

      const preview = await previewOnce(pair.client)
      await writeFile(join(root, 'source.docx'), await simpleDocx('Changed'))

      const apply = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview.confirmationRef,
          proposalId: preview.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(['SOURCE_HASH_MISMATCH', 'STALE_EXPECTED_TEXT']).toContain(errorCode(apply))
      // ref already consumed
      const again = await pair.client.callTool({
        name: 'docx_apply_patch_to_copy',
        arguments: {
          confirmationRef: preview.confirmationRef,
          proposalId: preview.proposal.id,
          appliedAt: '2026-08-03T18:00:00.000Z',
        },
      })
      expect(errorCode(again)).toBe('CONFIRMATION_REQUIRED')
    })
  })

  it('evicts oldest when pending cap is exceeded', () => {
    let now = 0
    const store = new ConfirmationStore({
      now: () => now,
      ttlMs: 60_000,
      maxPending: 3,
      randomBytes: (size) => {
        now += 1
        const buf = Buffer.alloc(size)
        buf.writeUInt32BE(now, 0)
        return buf
      },
    })

    const proposal = {
      version: 'docx-proposal/v1' as const,
      id: 'c'.repeat(64),
      source: { sha256: 'd'.repeat(64), byteLength: 1 },
      operations: [
        {
          op: 'replace_block_text' as const,
          docxIndex: 0,
          expectedText: 'a',
          replacementText: 'b',
        },
      ],
    }

    const r1 = store.put({
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'o1.docx',
      proposal,
    })
    now += 10
    const r2 = store.put({
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'o2.docx',
      proposal,
    })
    now += 10
    store.put({
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'o3.docx',
      proposal,
    })
    expect(store.size).toBe(3)
    now += 10
    store.put({
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'o4.docx',
      proposal,
    })
    expect(store.size).toBe(3)
    expect(store.peek(r1.confirmationRef)).toBeUndefined()
    expect(store.peek(r2.confirmationRef)).toBeDefined()
  })

  it('rejects invalid limits, weak random output, and duplicate confirmation refs', () => {
    expect(() => new ConfirmationStore({ maxPending: 0 })).toThrow(ArtifactPatchMcpError)
    expect(() => new ConfirmationStore({ maxPending: 65 })).toThrow(ArtifactPatchMcpError)
    expect(() => new ConfirmationStore({ ttlMs: 0 })).toThrow(ArtifactPatchMcpError)

    const proposal = {
      version: 'docx-proposal/v1' as const,
      id: 'e'.repeat(64),
      source: { sha256: 'f'.repeat(64), byteLength: 1 },
      operations: [
        {
          op: 'replace_block_text' as const,
          docxIndex: 0,
          expectedText: 'a',
          replacementText: 'b',
        },
      ],
    }
    const record = {
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'b.docx',
      proposal,
    }

    const weak = new ConfirmationStore({ randomBytes: () => Buffer.alloc(8) })
    expect(() => weak.put(record)).toThrow(ArtifactPatchMcpError)

    const colliding = new ConfirmationStore({ randomBytes: () => Buffer.alloc(16) })
    const first = colliding.put(record)
    expect(() => colliding.put({ ...record, destinationRelativePath: 'c.docx' })).toThrow(
      ArtifactPatchMcpError,
    )
    expect(colliding.size).toBe(1)
    expect(colliding.peek(first.confirmationRef)?.destinationRelativePath).toBe('b.docx')

    const collidingAtCapacity = new ConfirmationStore({
      maxPending: 1,
      randomBytes: () => Buffer.alloc(16),
    })
    const capacityFirst = collidingAtCapacity.put(record)
    expect(() =>
      collidingAtCapacity.put({ ...record, destinationRelativePath: 'capacity-second.docx' }),
    ).toThrow(ArtifactPatchMcpError)
    expect(collidingAtCapacity.size).toBe(1)
    expect(collidingAtCapacity.peek(capacityFirst.confirmationRef)?.destinationRelativePath).toBe(
      'b.docx',
    )
  })

  it('tracks retained text, evicts for aggregate budget, and rejects oversized single proposals', () => {
    let now = 0
    const store = new ConfirmationStore({
      now: () => now,
      ttlMs: 60_000,
      maxPending: 10,
      maxPendingTextChars: 100,
      maxProposalTextChars: 80,
      randomBytes: (size) => {
        now += 1
        const buf = Buffer.alloc(size)
        buf.writeUInt32BE(now, 0)
        return buf
      },
    })

    const makeProposal = (expectedText: string, replacementText: string, idSeed: string) => ({
      version: 'docx-proposal/v1' as const,
      id: idSeed.padEnd(64, '0').slice(0, 64),
      source: { sha256: 'a'.repeat(64), byteLength: 1 },
      operations: [
        {
          op: 'replace_block_text' as const,
          docxIndex: 0,
          expectedText,
          replacementText,
        },
      ],
    })

    // Single record over per-proposal budget: reject without mutation.
    try {
      store.put({
        sourceRelativePath: 'a.docx',
        destinationRelativePath: 'o-big.docx',
        proposal: makeProposal('x'.repeat(50), 'y'.repeat(50), '1'),
      })
      throw new Error('expected INPUT_TOO_LARGE')
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactPatchMcpError)
      expect((err as ArtifactPatchMcpError).code).toBe('INPUT_TOO_LARGE')
    }
    expect(store.size).toBe(0)
    expect(store.retainedTextChars).toBe(0)

    const r1 = store.put({
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'o1.docx',
      proposal: makeProposal('e'.repeat(40), 'r'.repeat(10), '2'),
    })
    expect(store.retainedTextChars).toBe(50)
    now += 10
    const r2 = store.put({
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'o2.docx',
      proposal: makeProposal('e'.repeat(40), 'r'.repeat(10), '3'),
    })
    expect(store.size).toBe(2)
    expect(store.retainedTextChars).toBe(100)

    // Next 50-char proposal requires eviction of oldest.
    now += 10
    const r3 = store.put({
      sourceRelativePath: 'a.docx',
      destinationRelativePath: 'o3.docx',
      proposal: makeProposal('e'.repeat(40), 'r'.repeat(10), '4'),
    })
    expect(store.size).toBe(2)
    expect(store.peek(r1.confirmationRef)).toBeUndefined()
    expect(store.peek(r2.confirmationRef)).toBeDefined()
    expect(store.peek(r3.confirmationRef)).toBeDefined()
    expect(store.retainedTextChars).toBe(100)

    // Consume decrements exactly once.
    store.consume(r2.confirmationRef, '3'.padEnd(64, '0').slice(0, 64))
    expect(store.retainedTextChars).toBe(50)
    expect(store.size).toBe(1)

    // Expiry decrements exactly once.
    now += 120_000
    expect(store.size).toBe(0)
    expect(store.retainedTextChars).toBe(0)
  })
})
