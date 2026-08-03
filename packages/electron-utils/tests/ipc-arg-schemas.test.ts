import { describe, expect, it } from 'vitest'
import {
  IPC_PATH_LIST_MAX,
  IPC_PASTED_IMAGE_MAX_BYTES,
  filesAddArgsSchema,
  filesAddPastedImageArgsSchema,
  filesPickArgsSchema,
  filesReadArgsSchema,
  filesReadImageArgsSchema,
} from '../src/ipc-arg-schemas'

describe('file/attachment IPC arg schemas', () => {
  it('accepts empty pick args', () => {
    expect(filesPickArgsSchema.parse([])).toEqual([])
  })

  it('accepts bounded path lists and rejects empty/overlong paths', () => {
    expect(filesAddArgsSchema.parse([['/tmp/a.docx', '/tmp/b.png']])).toEqual([
      ['/tmp/a.docx', '/tmp/b.png'],
    ])
    expect(() => filesAddArgsSchema.parse([['']])).toThrow()
    expect(() => filesAddArgsSchema.parse([['x'.repeat(2000)]])).toThrow()
    expect(() =>
      filesAddArgsSchema.parse([Array.from({ length: IPC_PATH_LIST_MAX + 1 }, (_, i) => `/${i}`)]),
    ).toThrow()
    expect(() => filesAddArgsSchema.parse(['/not-array'])).toThrow()
  })

  it('accepts read tuples and rejects bad offsets/sizes', () => {
    expect(filesReadArgsSchema.parse(['/tmp/a.txt', 0, 1000])).toEqual(['/tmp/a.txt', 0, 1000])
    expect(() => filesReadArgsSchema.parse(['/tmp/a.txt', -1, 10])).toThrow()
    expect(() => filesReadArgsSchema.parse(['/tmp/a.txt', 0, 0])).toThrow()
    expect(() => filesReadArgsSchema.parse(['/tmp/a.txt', 0, 100_000])).toThrow()
  })

  it('accepts single-path image reads', () => {
    expect(filesReadImageArgsSchema.parse(['/tmp/a.png'])).toEqual(['/tmp/a.png'])
    expect(() => filesReadImageArgsSchema.parse([])).toThrow()
    expect(() => filesReadImageArgsSchema.parse(['/tmp/a.png', 'extra'])).toThrow()
  })

  it('accepts pasted image bytes + ext within bounds', () => {
    const buf = new ArrayBuffer(16)
    expect(filesAddPastedImageArgsSchema.parse([buf, 'png'])[1]).toBe('png')
    const view = new Uint8Array([1, 2, 3])
    expect(filesAddPastedImageArgsSchema.parse([view, 'jpeg'])[1]).toBe('jpeg')
  })

  it('rejects oversize pasted images and bad extensions', () => {
    const big = new ArrayBuffer(IPC_PASTED_IMAGE_MAX_BYTES + 1)
    expect(() => filesAddPastedImageArgsSchema.parse([big, 'png'])).toThrow()
    expect(() => filesAddPastedImageArgsSchema.parse([new ArrayBuffer(0), 'png'])).toThrow()
    expect(() => filesAddPastedImageArgsSchema.parse([new ArrayBuffer(8), '../x'])).toThrow()
    expect(() => filesAddPastedImageArgsSchema.parse([new ArrayBuffer(8), 'PNG.exe'])).toThrow()
    expect(() => filesAddPastedImageArgsSchema.parse(['not-bytes', 'png'])).toThrow()
  })
})
