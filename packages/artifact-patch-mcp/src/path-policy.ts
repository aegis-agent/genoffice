import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { ArtifactPatchMcpError } from './errors'

export const MAX_RELATIVE_PATH_CHARS = 4096
export const MAX_PENDING_CONFIRMATIONS = 64
export const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60 * 1000

export interface ResolvedArtifactRoot {
  /** Canonical absolute root directory (realpath). */
  canonicalRoot: string
}

/**
 * Require an explicit absolute artifact root that exists as a real directory.
 * No cwd/home fallback. Rejects non-directories and symlink roots after realpath.
 */
export async function resolveArtifactRoot(artifactRoot: string): Promise<ResolvedArtifactRoot> {
  if (typeof artifactRoot !== 'string' || artifactRoot.length === 0) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root is required')
  }
  if (!isAbsolute(artifactRoot)) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root must be absolute')
  }
  if (artifactRoot.includes('\0')) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root is invalid')
  }

  let st
  try {
    st = await lstat(artifactRoot)
  } catch {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root does not exist')
  }
  if (st.isSymbolicLink()) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root must not be a symlink')
  }
  if (!st.isDirectory()) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root must be a directory')
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(artifactRoot)
  } catch {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root is not resolvable')
  }

  const rootStat = await stat(canonicalRoot)
  if (!rootStat.isDirectory()) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'artifact root must be a directory')
  }

  return { canonicalRoot }
}

function assertRelativeDocxPathShape(relPath: string): void {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new ArtifactPatchMcpError(
      'ROOT_POLICY_VIOLATION',
      'path must be a non-empty relative path',
    )
  }
  if (relPath.length > MAX_RELATIVE_PATH_CHARS) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path exceeds maximum length')
  }
  if (relPath.includes('\0')) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path contains NUL')
  }
  if (isAbsolute(relPath)) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'absolute paths are not allowed')
  }
  // Windows drive / UNC / backslash forms
  if (relPath.includes('\\') || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('//')) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'windows path forms are not allowed')
  }
  if (relPath.startsWith('/')) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'absolute paths are not allowed')
  }

  const segments = relPath.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ArtifactPatchMcpError(
        'ROOT_POLICY_VIOLATION',
        'path segments . and .. are not allowed',
      )
    }
  }

  const lower = relPath.toLowerCase()
  if (!lower.endsWith('.docx')) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path must end with .docx')
  }
  // Reject double extensions tricks like "foo.docx.exe" — already handled by endsWith.
  // Reject trailing slash already via segment rules.
}

/**
 * Walk each existing path component with lstat and reject symlinks.
 * Returns the joined absolute candidate path under root (not yet realpath'd as a whole).
 */
async function joinUnderRootNoSymlinks(
  canonicalRoot: string,
  relPath: string,
): Promise<{ absolutePath: string; existingPrefix: string }> {
  assertRelativeDocxPathShape(relPath)

  // Defense in depth after normalize — still reject if normalize introduces traversal.
  const normalized = normalize(relPath)
  if (normalized.startsWith('..') || isAbsolute(normalized) || normalized.includes(`..${sep}`)) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path failed normalization policy')
  }
  assertRelativeDocxPathShape(normalized.replaceAll(sep, '/'))

  const segments = normalized.split(sep)
  let current = canonicalRoot
  for (let i = 0; i < segments.length; i++) {
    const next = join(current, segments[i]!)
    // Ensure we never escape root even before existence checks.
    if (next !== canonicalRoot && !next.startsWith(canonicalRoot + sep)) {
      throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path escapes artifact root')
    }
    try {
      const st = await lstat(next)
      if (st.isSymbolicLink()) {
        throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'symlinks are not allowed')
      }
      current = next
    } catch (err) {
      if (err instanceof ArtifactPatchMcpError) throw err
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        // Remaining segments must not exist; return parent as existing prefix.
        return {
          absolutePath: join(canonicalRoot, ...segments),
          existingPrefix: current,
        }
      }
      throw new ArtifactPatchMcpError('IO_ERROR', 'failed to inspect path')
    }
  }

  const absolutePath = current
  if (absolutePath !== canonicalRoot && !absolutePath.startsWith(canonicalRoot + sep)) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path escapes artifact root')
  }
  return { absolutePath, existingPrefix: absolutePath }
}

export interface ResolvedSourcePath {
  relativePath: string
  absolutePath: string
}

export interface ResolvedDestinationPath {
  relativePath: string
  absolutePath: string
  parentAbsolutePath: string
}

/**
 * Resolve a root-relative source .docx: must exist as a regular non-symlink file under root.
 */
export async function resolveSourceDocxPath(
  canonicalRoot: string,
  relPath: string,
): Promise<ResolvedSourcePath> {
  const { absolutePath } = await joinUnderRootNoSymlinks(canonicalRoot, relPath)
  let st
  try {
    st = await lstat(absolutePath)
  } catch {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'source path does not exist')
  }
  if (st.isSymbolicLink()) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'symlinks are not allowed')
  }
  if (!st.isFile()) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'source must be a regular file')
  }
  // Confirm still under root after full resolution (no symlink follow needed — we rejected them).
  if (!absolutePath.startsWith(canonicalRoot + sep) && absolutePath !== canonicalRoot) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path escapes artifact root')
  }
  return { relativePath: relPath, absolutePath }
}

/**
 * Resolve a root-relative destination .docx: parent dirs must exist (non-symlink), final path absent
 * (including dangling symlink — lstat would succeed for dangling... actually dangling symlink:
 * lstat succeeds and isSymbolicLink is true).
 */
export async function resolveDestinationDocxPath(
  canonicalRoot: string,
  relPath: string,
): Promise<ResolvedDestinationPath> {
  assertRelativeDocxPathShape(relPath)
  const segments = relPath.split('/')
  const fileName = segments[segments.length - 1]!
  const parentRelSegments = segments.slice(0, -1)

  let parentAbsolute = canonicalRoot
  for (const seg of parentRelSegments) {
    const next = join(parentAbsolute, seg)
    if (!next.startsWith(canonicalRoot + sep) && next !== canonicalRoot) {
      throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path escapes artifact root')
    }
    let st
    try {
      st = await lstat(next)
    } catch {
      throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'destination parent does not exist')
    }
    if (st.isSymbolicLink()) {
      throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'symlinks are not allowed')
    }
    if (!st.isDirectory()) {
      throw new ArtifactPatchMcpError(
        'ROOT_POLICY_VIOLATION',
        'destination parent must be a directory',
      )
    }
    parentAbsolute = next
  }

  const absolutePath = join(parentAbsolute, fileName)
  if (!absolutePath.startsWith(canonicalRoot + sep)) {
    throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'path escapes artifact root')
  }

  try {
    const st = await lstat(absolutePath)
    // Exists as anything (file, dir, dangling symlink) — reject.
    if (st.isSymbolicLink()) {
      throw new ArtifactPatchMcpError('ROOT_POLICY_VIOLATION', 'destination symlink is not allowed')
    }
    throw new ArtifactPatchMcpError('DESTINATION_EXISTS', 'destination already exists')
  } catch (err) {
    if (err instanceof ArtifactPatchMcpError) throw err
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      throw new ArtifactPatchMcpError('IO_ERROR', 'failed to inspect destination path')
    }
  }

  return {
    relativePath: relPath,
    absolutePath,
    parentAbsolutePath: parentAbsolute,
  }
}
