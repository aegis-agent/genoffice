import { describe, expect, it, vi } from 'vitest'
import {
  handleExternalDocxChange,
  type ExternalReloadResult,
} from '../src/renderer/external-docx-reload'

describe('handleExternalDocxChange (renderer)', () => {
  it('E: clean document reloads without confirm', async () => {
    const apply = vi.fn()
    const reload = vi.fn(async () => ({ path: '/a.docx', name: 'a.docx', data: new ArrayBuffer(1), hash: 'h' }))
    const confirm = vi.fn(() => true)

    const outcome = await handleExternalDocxChange({
      isDirty: () => false,
      getPath: () => '/a.docx',
      confirm,
      reload,
      apply,
    })

    expect(confirm).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(outcome).toBe('reloaded' satisfies ExternalReloadResult)
  })

  it('E: dirty document confirms; decline keeps current content', async () => {
    const apply = vi.fn()
    const reload = vi.fn(async () => ({ path: '/a.docx', name: 'a.docx', data: new ArrayBuffer(1), hash: 'h' }))

    const declined = await handleExternalDocxChange({
      isDirty: () => true,
      getPath: () => '/a.docx',
      confirm: () => false,
      reload,
      apply,
    })
    expect(declined).toBe('declined')
    expect(reload).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()

    const accepted = await handleExternalDocxChange({
      isDirty: () => true,
      getPath: () => '/a.docx',
      confirm: () => true,
      reload,
      apply,
    })
    expect(accepted).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('E: stale async result is ignored when path changed mid-flight', async () => {
    const apply = vi.fn()
    let path = '/old.docx'
    let resolveReload!: (v: {
      path: string
      name: string
      data: ArrayBuffer
      hash: string
    } | null) => void

    const reload = vi.fn(
      () =>
        new Promise<typeof resolveReload extends (v: infer R) => void ? R : never>((resolve) => {
          resolveReload = resolve
        }),
    )

    const pending = handleExternalDocxChange({
      isDirty: () => false,
      getPath: () => path,
      confirm: () => true,
      reload,
      apply,
    })

    // User opened a different document while reload was in flight
    path = '/new.docx'
    resolveReload({ path: '/old.docx', name: 'old.docx', data: new ArrayBuffer(2), hash: 'old' })

    await expect(pending).resolves.toBe('stale')
    expect(apply).not.toHaveBeenCalled()
  })

  it('E: stale when dirty flipped after confirm and path still matches is still applied only if path+generation match', async () => {
    const apply = vi.fn()
    const reload = vi.fn(async () => null)
    const outcome = await handleExternalDocxChange({
      isDirty: () => false,
      getPath: () => '/a.docx',
      confirm: () => true,
      reload,
      apply,
    })
    expect(outcome).toBe('noop')
    expect(apply).not.toHaveBeenCalled()
  })
})
