/**
 * Main-process-only helpers for private JSON I/O and migrating legacy plaintext
 * AI provider secrets into an Electron safeStorage-backed vault.
 *
 * Electron is NOT imported here — callers inject a SafeStorageAdapter
 * (typically Electron's safeStorage).
 *
 * The vault preserves legacy BYOK material for future recovery only. Runtime
 * AI auth remains Genspark via gskApiKey() (see @genoffice/ai-provider C2).
 */
import {
  chmodSync as defaultChmodSync,
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  renameSync as defaultRenameSync,
  unlinkSync as defaultUnlinkSync,
  writeFileSync as defaultWriteFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** On-disk vault envelope version. */
export const AI_PROVIDER_SECRETS_VAULT_VERSION = 1 as const

/** Default vault filename under app userData. */
export const AI_PROVIDER_SECRETS_VAULT_FILENAME = 'ai-provider-secrets.vault.json'

/** Linux backends accepted as OS-keyring-backed (Electron safeStorage). */
export const LINUX_SECURE_STORAGE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
])

/**
 * Minimal safeStorage surface. Matches Electron's safeStorage enough for
 * encrypt/decrypt + backend policy without depending on the electron package.
 */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Electron Linux: selected backend id. Optional on macOS/Windows. */
  getSelectedStorageBackend?: () => string
}

/**
 * Optional filesystem hooks for deterministic rollback tests.
 * Production defaults remain node:fs.
 */
export interface PrivateJsonFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding?: BufferEncoding): string | Buffer
  writeFileSync(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  mkdirSync(path: string, options?: { recursive?: boolean }): void
  chmodSync(path: string, mode: number): void
}

const defaultFs: PrivateJsonFs = {
  existsSync: defaultExistsSync,
  readFileSync: defaultReadFileSync as PrivateJsonFs['readFileSync'],
  writeFileSync: defaultWriteFileSync as PrivateJsonFs['writeFileSync'],
  renameSync: defaultRenameSync,
  unlinkSync: defaultUnlinkSync,
  mkdirSync: defaultMkdirSync as PrivateJsonFs['mkdirSync'],
  chmodSync: defaultChmodSync,
}

export type SecureEncryptionAssessment =
  | { allowed: true; backend: string }
  | {
      allowed: false
      reason: 'encryption_unavailable' | 'insecure_backend'
      backend?: string
    }

export type AiSecretsMigrationStatus =
  | 'no_settings_file'
  | 'no_secrets'
  | 'already_migrated'
  | 'migrated'
  | 'skipped_insecure_storage'
  | 'failed'

export interface AiSecretsMigrationResult {
  status: AiSecretsMigrationStatus
  /** Non-secret diagnostic for logs. */
  detail?: string
}

/** Statuses safe to follow with a preference-only settings rewrite. */
export const AI_SETTINGS_PREFERENCE_WRITE_SAFE_STATUSES: ReadonlySet<AiSecretsMigrationStatus> =
  new Set(['migrated', 'already_migrated', 'no_secrets', 'no_settings_file'])

export type ApplyAiSettingsPreferencesStatus =
  'ok' | 'blocked_insecure_storage' | 'blocked_migration_failed' | 'blocked_write_failed'

export interface ApplyAiSettingsPreferencesResult {
  ok: boolean
  status: ApplyAiSettingsPreferencesStatus
  /** Non-secret diagnostic. */
  detail?: string
  migration: AiSecretsMigrationResult
}

export interface MigratedProviderSecret {
  apiKey: string
  baseUrl?: string
}

export interface AiProviderSecretsPayload {
  version: typeof AI_PROVIDER_SECRETS_VAULT_VERSION
  migratedAt: string
  legacy?: {
    apiKey?: string
    baseUrl?: string
    model?: string
  }
  providers: Record<string, MigratedProviderSecret>
}

export interface AiProviderSecretsVaultFile {
  version: typeof AI_PROVIDER_SECRETS_VAULT_VERSION
  backend: string
  /** Base64 of safeStorage.encryptString(JSON.stringify(payload)). */
  ciphertext: string
}

export interface MigrateLegacyAiProviderSecretsOptions {
  settingsPath: string
  vaultPath: string
  safeStorage: SafeStorageAdapter
  /** C2 preference-only sanitizer (e.g. sanitizeRendererAiSettingsUpdate). */
  toPreferenceOnly: (raw: unknown) => unknown
  platform?: NodeJS.Platform
  log?: (message: string) => void
  /** Test/prod FS surface; defaults to node:fs. */
  fs?: PrivateJsonFs
}

export interface ApplyAiSettingsPreferencesOptions extends MigrateLegacyAiProviderSecretsOptions {
  /** Preference-only payload to write after a safe migration outcome. */
  preferences: unknown
}

/**
 * Decide whether safeStorage is acceptable for protecting secrets.
 * Linux: refuse basic_text and unknown/missing backends; require a known keyring.
 * Other platforms: require isEncryptionAvailable() only.
 */
export function assessSecureEncryption(
  adapter: SafeStorageAdapter,
  platform: NodeJS.Platform = process.platform,
): SecureEncryptionAssessment {
  if (!adapter.isEncryptionAvailable()) {
    return { allowed: false, reason: 'encryption_unavailable' }
  }
  const backend =
    typeof adapter.getSelectedStorageBackend === 'function'
      ? adapter.getSelectedStorageBackend()
      : platform === 'linux'
        ? 'unknown'
        : 'platform_default'

  if (platform === 'linux') {
    if (!LINUX_SECURE_STORAGE_BACKENDS.has(backend)) {
      return { allowed: false, reason: 'insecure_backend', backend }
    }
  }

  return { allowed: true, backend }
}

function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = value.trim()
  return t.length > 0 ? value : undefined
}

/**
 * Pull every nonempty provider apiKey (and baseUrl when present) plus legacy
 * top-level apiKey/baseUrl/model. Returns null when there is nothing to vault.
 */
export function extractLegacyAiSecrets(raw: unknown): AiProviderSecretsPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const providers: Record<string, MigratedProviderSecret> = {}

  const providersObj = obj.providers
  if (providersObj && typeof providersObj === 'object') {
    for (const [id, cfg] of Object.entries(providersObj as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object') continue
      const c = cfg as Record<string, unknown>
      const apiKey = nonemptyString(c.apiKey)
      if (!apiKey) continue
      const entry: MigratedProviderSecret = { apiKey }
      const baseUrl = nonemptyString(c.baseUrl)
      if (baseUrl) entry.baseUrl = baseUrl
      providers[id] = entry
    }
  }

  const legacyKey = nonemptyString(obj.apiKey)
  const legacyBase = nonemptyString(obj.baseUrl)
  const legacyModel = typeof obj.model === 'string' && obj.model.length > 0 ? obj.model : undefined
  let legacy: AiProviderSecretsPayload['legacy'] | undefined
  if (legacyKey || legacyBase) {
    legacy = {}
    if (legacyKey) legacy.apiKey = legacyKey
    if (legacyBase) legacy.baseUrl = legacyBase
    if (legacyModel) legacy.model = legacyModel
  }

  if (!legacy && Object.keys(providers).length === 0) return null

  return {
    version: AI_PROVIDER_SECRETS_VAULT_VERSION,
    migratedAt: new Date().toISOString(),
    ...(legacy ? { legacy } : {}),
    providers,
  }
}

/** Atomically write JSON with file mode 0600 (owner read/write only). */
export function writePrivateJsonAtomic(
  filePath: string,
  value: unknown,
  fs: PrivateJsonFs = defaultFs,
): void {
  const dir = dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const body = `${JSON.stringify(value, null, 2)}\n`
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      /* best-effort on platforms that ignore mode */
    }
    fs.renameSync(tmp, filePath)
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {
      /* best-effort */
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

function readJsonUnknown(filePath: string, fs: PrivateJsonFs): unknown {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as unknown
}

function readFileBytes(filePath: string, fs: PrivateJsonFs): Buffer {
  const raw = fs.readFileSync(filePath)
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')
}

function safeUnlink(path: string, fs: PrivateJsonFs): void {
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path)
  } catch {
    /* ignore */
  }
}

function isValidPayloadShape(value: unknown): value is AiProviderSecretsPayload {
  if (!value || typeof value !== 'object') return false
  const got = value as AiProviderSecretsPayload
  if (got.version !== AI_PROVIDER_SECRETS_VAULT_VERSION) return false
  if (!got.providers || typeof got.providers !== 'object') return false
  for (const entry of Object.values(got.providers)) {
    if (!entry || typeof entry !== 'object') return false
    if (typeof entry.apiKey !== 'string' || entry.apiKey.trim().length === 0) return false
    if (entry.baseUrl !== undefined && typeof entry.baseUrl !== 'string') return false
  }
  if (got.legacy !== undefined) {
    if (!got.legacy || typeof got.legacy !== 'object') return false
    for (const key of ['apiKey', 'baseUrl', 'model'] as const) {
      const v = got.legacy[key]
      if (v !== undefined && typeof v !== 'string') return false
    }
  }
  return true
}

/**
 * Prove every expected legacy field (including model) and every expected
 * provider field is preserved exactly in the decrypted payload.
 */
function payloadPreservesSecrets(expected: AiProviderSecretsPayload, actual: unknown): boolean {
  if (!isValidPayloadShape(actual)) return false
  if (actual.version !== expected.version) return false

  if (expected.legacy) {
    if (!actual.legacy) return false
    for (const key of ['apiKey', 'baseUrl', 'model'] as const) {
      const exp = expected.legacy[key]
      if (exp !== undefined && actual.legacy[key] !== exp) return false
    }
  }

  for (const [id, secret] of Object.entries(expected.providers)) {
    const g = actual.providers[id]
    if (!g || g.apiKey !== secret.apiKey) return false
    if (secret.baseUrl !== undefined && g.baseUrl !== secret.baseUrl) return false
  }
  return true
}

/** Merge prior vaulted secrets with newly extracted plaintext secrets. */
export function mergeAiProviderSecretsPayloads(
  existing: AiProviderSecretsPayload,
  incoming: AiProviderSecretsPayload,
): AiProviderSecretsPayload {
  const providers: Record<string, MigratedProviderSecret> = {}
  for (const [id, secret] of Object.entries(existing.providers ?? {})) {
    providers[id] = { ...secret }
  }
  for (const [id, secret] of Object.entries(incoming.providers ?? {})) {
    const prev = providers[id]
    providers[id] = {
      apiKey: secret.apiKey,
      ...(secret.baseUrl !== undefined
        ? { baseUrl: secret.baseUrl }
        : prev?.baseUrl !== undefined
          ? { baseUrl: prev.baseUrl }
          : {}),
    }
  }

  let legacy: AiProviderSecretsPayload['legacy'] | undefined
  if (existing.legacy || incoming.legacy) {
    legacy = { ...(existing.legacy ?? {}), ...(incoming.legacy ?? {}) }
    if (Object.keys(legacy).length === 0) legacy = undefined
  }

  return {
    version: AI_PROVIDER_SECRETS_VAULT_VERSION,
    migratedAt: incoming.migratedAt,
    ...(legacy ? { legacy } : {}),
    providers,
  }
}

type ExistingVaultRead =
  | { kind: 'absent' }
  | { kind: 'ok'; payload: AiProviderSecretsPayload; bytes: Buffer }
  | { kind: 'invalid'; detail: string }

function readExistingVault(
  vaultPath: string,
  safeStorage: SafeStorageAdapter,
  fs: PrivateJsonFs,
): ExistingVaultRead {
  if (!fs.existsSync(vaultPath)) return { kind: 'absent' }
  let bytes: Buffer
  try {
    bytes = readFileBytes(vaultPath, fs)
  } catch {
    return { kind: 'invalid', detail: 'vault_unreadable' }
  }

  try {
    const written = JSON.parse(bytes.toString('utf8')) as AiProviderSecretsVaultFile
    if (
      written.version !== AI_PROVIDER_SECRETS_VAULT_VERSION ||
      typeof written.ciphertext !== 'string' ||
      written.ciphertext.length === 0
    ) {
      return { kind: 'invalid', detail: 'vault_bad_shape' }
    }
    const plain = safeStorage.decryptString(Buffer.from(written.ciphertext, 'base64'))
    const parsed = JSON.parse(plain) as unknown
    if (!isValidPayloadShape(parsed)) {
      return { kind: 'invalid', detail: 'vault_payload_invalid' }
    }
    return { kind: 'ok', payload: parsed, bytes }
  } catch {
    return { kind: 'invalid', detail: 'vault_decrypt_failed' }
  }
}

function restoreVaultAndSettings(args: {
  vaultPath: string
  settingsPath: string
  previousVaultBytes: Buffer | null
  originalSettingsBytes: Buffer
  fs: PrivateJsonFs
}): void {
  const { vaultPath, settingsPath, previousVaultBytes, originalSettingsBytes, fs } = args
  if (previousVaultBytes) {
    try {
      fs.writeFileSync(vaultPath, previousVaultBytes, { mode: 0o600 })
      try {
        fs.chmodSync(vaultPath, 0o600)
      } catch {
        /* best-effort */
      }
    } catch {
      safeUnlink(vaultPath, fs)
    }
  } else {
    safeUnlink(vaultPath, fs)
  }
  try {
    fs.writeFileSync(settingsPath, originalSettingsBytes)
  } catch {
    /* last resort */
  }
}

/**
 * If ai-settings.json still holds plaintext provider secrets and secure
 * storage is available, vault them then rewrite settings to preference-only.
 *
 * Failure / insecure backend: leave settings bytes untouched and leave no
 * unintended vault artifact. Never logs secret values.
 */
export function migrateLegacyAiProviderSecrets(
  options: MigrateLegacyAiProviderSecretsOptions,
): AiSecretsMigrationResult {
  const {
    settingsPath,
    vaultPath,
    safeStorage,
    toPreferenceOnly,
    platform = process.platform,
    log,
    fs = defaultFs,
  } = options
  const info = (msg: string) => {
    try {
      log?.(msg)
    } catch {
      /* ignore logger failures */
    }
  }

  if (!fs.existsSync(settingsPath)) {
    return { status: 'no_settings_file' }
  }

  let raw: unknown
  let originalBytes: Buffer
  try {
    originalBytes = readFileBytes(settingsPath, fs)
    raw = JSON.parse(originalBytes.toString('utf8')) as unknown
  } catch {
    info('ai-settings.json unreadable; skipping secrets migration')
    return { status: 'failed', detail: 'settings_unreadable' }
  }

  const extracted = extractLegacyAiSecrets(raw)
  if (!extracted) {
    if (fs.existsSync(vaultPath)) {
      info('ai provider secrets already migrated')
      return { status: 'already_migrated' }
    }
    return { status: 'no_secrets' }
  }

  const assessment = assessSecureEncryption(safeStorage, platform)
  if (!assessment.allowed) {
    info(
      `skipping ai secrets migration: ${assessment.reason}${
        assessment.backend ? ` (backend=${assessment.backend})` : ''
      }`,
    )
    return {
      status: 'skipped_insecure_storage',
      detail: assessment.reason,
    }
  }

  // Existing vault must decrypt+validate before we replace anything.
  const existing = readExistingVault(vaultPath, safeStorage, fs)
  if (existing.kind === 'invalid') {
    info(`ai secrets migration failed: existing vault unusable (${existing.detail})`)
    return { status: 'failed', detail: existing.detail }
  }

  const secrets =
    existing.kind === 'ok' ? mergeAiProviderSecretsPayloads(existing.payload, extracted) : extracted
  const previousVaultBytes = existing.kind === 'ok' ? existing.bytes : null

  // Preference-only rewrite payload must be ready before any final vault rename
  // so a sanitizer failure cannot leave a committed vault without rollback cover.
  let preferences: unknown
  try {
    preferences = toPreferenceOnly(raw)
  } catch {
    info('ai secrets migration failed: preference sanitizer error')
    return { status: 'failed', detail: 'preference_sanitize_failed' }
  }

  const stagingVault = `${vaultPath}.${process.pid}.staging`
  let vaultCommitted = false
  try {
    let ciphertextB64: string
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(secrets))
      ciphertextB64 = Buffer.from(encrypted).toString('base64')
    } catch {
      info('ai secrets migration failed: encrypt error')
      return { status: 'failed', detail: 'encrypt_failed' }
    }

    const vaultFile: AiProviderSecretsVaultFile = {
      version: AI_PROVIDER_SECRETS_VAULT_VERSION,
      backend: assessment.backend,
      ciphertext: ciphertextB64,
    }

    try {
      writePrivateJsonAtomic(stagingVault, vaultFile, fs)
    } catch {
      safeUnlink(stagingVault, fs)
      info('ai secrets migration failed: vault write error')
      return { status: 'failed', detail: 'vault_write_failed' }
    }

    // Verify staging vault decrypts and preserves every merged secret before commit.
    try {
      const written = readJsonUnknown(stagingVault, fs) as AiProviderSecretsVaultFile
      if (
        written.version !== AI_PROVIDER_SECRETS_VAULT_VERSION ||
        typeof written.ciphertext !== 'string'
      ) {
        throw new Error('bad vault shape')
      }
      const plain = safeStorage.decryptString(Buffer.from(written.ciphertext, 'base64'))
      const parsed = JSON.parse(plain) as unknown
      if (!payloadPreservesSecrets(secrets, parsed)) {
        throw new Error('vault payload missing secrets')
      }
    } catch {
      safeUnlink(stagingVault, fs)
      info('ai secrets migration failed: vault verify error')
      return { status: 'failed', detail: 'vault_verify_failed' }
    }

    // Commit vault to its final path first (requirement), then rewrite settings.
    // If anything after this fails, restore exact prior vault bytes (or remove
    // the new vault) and restore exact original settings bytes.
    try {
      fs.renameSync(stagingVault, vaultPath)
      vaultCommitted = true
      try {
        fs.chmodSync(vaultPath, 0o600)
      } catch {
        /* best-effort */
      }
    } catch {
      safeUnlink(stagingVault, fs)
      info('ai secrets migration failed: vault commit error')
      return { status: 'failed', detail: 'vault_commit_failed' }
    }

    try {
      writePrivateJsonAtomic(settingsPath, preferences, fs)
    } catch {
      restoreVaultAndSettings({
        vaultPath,
        settingsPath,
        previousVaultBytes,
        originalSettingsBytes: originalBytes,
        fs,
      })
      info('ai secrets migration failed: settings write error')
      return { status: 'failed', detail: 'settings_write_failed' }
    }

    info('migrated legacy ai provider secrets into encrypted vault')
    return { status: 'migrated', detail: assessment.backend }
  } catch {
    safeUnlink(stagingVault, fs)
    if (vaultCommitted) {
      restoreVaultAndSettings({
        vaultPath,
        settingsPath,
        previousVaultBytes,
        originalSettingsBytes: originalBytes,
        fs,
      })
    } else {
      try {
        if (Buffer.compare(readFileBytes(settingsPath, fs), originalBytes) !== 0) {
          fs.writeFileSync(settingsPath, originalBytes)
        }
      } catch {
        /* ignore */
      }
    }
    info('ai secrets migration failed: unexpected error')
    return { status: 'failed', detail: 'unexpected' }
  }
}

/**
 * Run migration (best-effort) then read ai-settings.json.
 * Shared entry point for get-settings / runtime config paths.
 */
export function loadAiSettingsJson(options: MigrateLegacyAiProviderSecretsOptions): unknown {
  migrateLegacyAiProviderSecrets(options)
  const fs = options.fs ?? defaultFs
  if (!fs.existsSync(options.settingsPath)) return {}
  try {
    return readJsonUnknown(options.settingsPath, fs)
  } catch {
    return {}
  }
}

/** Preference-only AI settings write (mode 0600, atomic). */
export function writeAiSettingsPreferences(
  settingsPath: string,
  value: unknown,
  fs: PrivateJsonFs = defaultFs,
): void {
  writePrivateJsonAtomic(settingsPath, value, fs)
}

/**
 * Shared set-settings operation: migrate legacy secrets, then write preferences
 * ONLY for safe migration statuses. On skipped_insecure_storage / failed,
 * preserve source bytes and reject the preference update with a nonsecret status.
 */
export function applyAiSettingsPreferencesUpdate(
  options: ApplyAiSettingsPreferencesOptions,
): ApplyAiSettingsPreferencesResult {
  const migration = migrateLegacyAiProviderSecrets(options)
  if (!AI_SETTINGS_PREFERENCE_WRITE_SAFE_STATUSES.has(migration.status)) {
    const blocked: ApplyAiSettingsPreferencesStatus =
      migration.status === 'skipped_insecure_storage'
        ? 'blocked_insecure_storage'
        : 'blocked_migration_failed'
    return {
      ok: false,
      status: blocked,
      detail: migration.detail ?? migration.status,
      migration,
    }
  }

  const fs = options.fs ?? defaultFs
  try {
    writeAiSettingsPreferences(options.settingsPath, options.preferences, fs)
    return { ok: true, status: 'ok', migration }
  } catch {
    return {
      ok: false,
      status: 'blocked_write_failed',
      detail: 'settings_write_failed',
      migration,
    }
  }
}
