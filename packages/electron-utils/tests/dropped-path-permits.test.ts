import { describe, expect, it } from 'vitest'

import { DroppedPathPermitGate } from '../src/dropped-path-permits'

describe('DroppedPathPermitGate', () => {
  it('rejects unissued paths', () => {
    const gate = new DroppedPathPermitGate()
    expect(gate.consumeAll(['/tmp/nope.txt'])).toEqual({ ok: false })
  })

  it('accepts an issued path once', () => {
    const gate = new DroppedPathPermitGate()
    gate.issue('/tmp/a.txt')
    expect(gate.consumeAll(['/tmp/a.txt'])).toEqual({ ok: true, paths: ['/tmp/a.txt'] })
  })

  it('rejects replay of a consumed permit', () => {
    const gate = new DroppedPathPermitGate()
    gate.issue('/tmp/a.txt')
    expect(gate.consumeAll(['/tmp/a.txt']).ok).toBe(true)
    expect(gate.consumeAll(['/tmp/a.txt'])).toEqual({ ok: false })
  })

  it('fails closed on mixed lists (does not partially authorize)', () => {
    const gate = new DroppedPathPermitGate()
    gate.issue('/tmp/good.txt')
    // Attacker sneaks an unpermitted path alongside a legitimate one
    expect(gate.consumeAll(['/tmp/good.txt', '/etc/passwd'])).toEqual({ ok: false })
    // Legitimate permit must remain unconsumed after the failed mixed attempt
    expect(gate.consumeAll(['/tmp/good.txt'])).toEqual({ ok: true, paths: ['/tmp/good.txt'] })
  })

  it('requires one permit per duplicate path entry', () => {
    const gate = new DroppedPathPermitGate()
    gate.issue('/tmp/a.txt')
    expect(gate.consumeAll(['/tmp/a.txt', '/tmp/a.txt'])).toEqual({ ok: false })
    gate.issue('/tmp/a.txt')
    expect(gate.consumeAll(['/tmp/a.txt', '/tmp/a.txt'])).toEqual({
      ok: true,
      paths: ['/tmp/a.txt', '/tmp/a.txt'],
    })
  })

  it('ignores empty-string issue and rejects empty path entries', () => {
    const gate = new DroppedPathPermitGate()
    gate.issue('')
    expect(gate.consumeAll([''])).toEqual({ ok: false })
    expect(gate.consumeAll([])).toEqual({ ok: true, paths: [] })
  })
})
