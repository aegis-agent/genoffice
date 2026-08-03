/**
 * Shared runtime schemas for high-risk file/attachment IPC argument tuples.
 * Path authorization remains the C1 grant/permit layer after shape validation.
 */
import { z } from 'zod'
import type { RuntimeSchema } from './safe-handle'

/** Absolute path strings from the renderer (still subject to grant checks). */
export const IPC_PATH_MAX = 1024
export const IPC_PATH_LIST_MAX = 50
/** Read window for attachment text extraction. */
export const IPC_READ_OFFSET_MAX = 50_000_000
export const IPC_READ_MAX_CHARS_MAX = 48_000
/** Pasted image bytes (matches ATTACHMENT_IMAGE_MAX_BYTES = 5 MiB). */
export const IPC_PASTED_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const IPC_PASTED_IMAGE_EXT_MAX = 16

const pathString = z.string().min(1).max(IPC_PATH_MAX)

export const filesPickArgsSchema: RuntimeSchema<[]> = z.tuple([])

export const filesAddArgsSchema: RuntimeSchema<[string[]]> = z.tuple([
  z.array(pathString).max(IPC_PATH_LIST_MAX),
])

export const filesReadArgsSchema: RuntimeSchema<[string, number, number]> = z.tuple([
  pathString,
  z.number().int().min(0).max(IPC_READ_OFFSET_MAX),
  z.number().int().min(1).max(IPC_READ_MAX_CHARS_MAX),
])

export const filesReadImageArgsSchema: RuntimeSchema<[string]> = z.tuple([pathString])

const pastedImageBytes = z.custom<ArrayBuffer | ArrayBufferView>((val) => {
  if (val instanceof ArrayBuffer) {
    return val.byteLength > 0 && val.byteLength <= IPC_PASTED_IMAGE_MAX_BYTES
  }
  if (ArrayBuffer.isView(val)) {
    return val.byteLength > 0 && val.byteLength <= IPC_PASTED_IMAGE_MAX_BYTES
  }
  return false
}, 'invalid pasted image bytes')

const pastedImageExt = z
  .string()
  .min(1)
  .max(IPC_PASTED_IMAGE_EXT_MAX)
  .regex(/^[a-z0-9]+$/i)

export const filesAddPastedImageArgsSchema: RuntimeSchema<[ArrayBuffer | ArrayBufferView, string]> =
  z.tuple([pastedImageBytes, pastedImageExt])

export type FilesAddArgs = [string[]]
export type FilesReadArgs = [string, number, number]
export type FilesReadImageArgs = [string]
export type FilesAddPastedImageArgs = [ArrayBuffer | ArrayBufferView, string]
