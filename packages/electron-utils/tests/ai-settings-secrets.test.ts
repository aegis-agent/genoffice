/**
 * P0 C3: legacy plaintext AI provider secrets → encrypted vault migration.
 * Fake safeStorage + temp dirs only; never touch real credentials.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  applyAiSettingsPreferencesUpdate,
  assessSecureEncryption,
  extractLegacyAiSecrets,
  loadAiSettingsJson,
  migrateLegacyAiProviderSecrets,
  writePrivateJsonAtomic,
  type PrivateJsonFs,
  type SafeStorageAdapter,
} from '../src/ai-settings-secrets'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ai-secrets-'))
  dirs.push(d)
  return d
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/** In-memory "encryption" that round-trips; not real crypto. */
function fakeSafeStorage(opts?: {
  available?: boolean
  backend?: string
  encryptThrows?: boolean
  decryptThrows?: boolean
  corruptDecrypt?: boolean
}): SafeStorageAdapter {
  const available = opts?.available ?? true
  const backend = opts?.backend ?? 'gnome_libsecret'
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(plaintext: string): Buffer {
      if (opts?.encryptThrows) throw new Error('encrypt boom')
      // Prefix so we can detect double-encrypt mistakes in asserts.
      return Buffer.from(`enc:${plaintext}`, 'utf8')
    },
    decryptString(encrypted: Buffer): string {
      if (opts?.decryptThrows) throw new Error('decrypt boom')
      if (opts?.corruptDecrypt) return '{not-valid'
      const s = encrypted.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return s.slice(4)
    },
  }
}

function preferenceOnly(raw: unknown): unknown {
  // Minimal stand-in for C2 sanitizeRendererAiSettingsUpdate: force genspark, blank keys.
  const model =
    raw &&
    typeof raw === 'object' &&
    (raw as { providers?: { genspark?: { model?: string } } }).providers?.genspark?.model
  return {
    provider: 'genspark',
    providers: {
      genspark: { apiKey: '', model: typeof model === 'string' ? model : 'claude-opus-4-7' },
      anthropic: { apiKey: '', model: 'x' },
      gemini: { apiKey: '', model: 'x' },
      deepseek: { apiKey: '', model: 'x' },
      openai: { apiKey: '', model: 'x' },
      custom: { apiKey: '', model: '', baseUrl: '' },
    },
  }
}

describe('assessSecureEncryption', () => {
  it('allows non-Linux when encryption is available', () => {
    const a = assessSecureEncryption(fakeSafeStorage({ backend: 'basic_text' }), 'darwin')
    expect(a).toEqual({ allowed: true, backend: 'basic_text' })
  })

  it('refuses when encryption is unavailable', () => {
    const a = assessSecureEncryption(fakeSafeStorage({ available: false }), 'linux')
    expect(a.allowed).toBe(false)
    if (!a.allowed) expect(a.reason).toBe('encryption_unavailable')
  })

  it('refuses Linux basic_text', () => {
    const a = assessSecureEncryption(fakeSafeStorage({ backend: 'basic_text' }), 'linux')
    expect(a.allowed).toBe(false)
    if (!a.allowed) {
      expect(a.reason).toBe('insecure_backend')
      expect(a.backend).toBe('basic_text')
    }
  })

  it('refuses Linux unknown backend', () => {
    const a = assessSecureEncryption(fakeSafeStorage({ backend: 'unknown' }), 'linux')
    expect(a.allowed).toBe(false)
    if (!a.allowed) expect(a.reason).toBe('insecure_backend')
  })

  it('accepts known Linux keyring backends', () => {
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'] as const) {
      const a = assessSecureEncryption(fakeSafeStorage({ backend }), 'linux')
      expect(a).toEqual({ allowed: true, backend })
    }
  })
})

describe('extractLegacyAiSecrets', () => {
  it('returns null when no nonempty secrets', () => {
    expect(
      extractLegacyAiSecrets({ provider: 'genspark', providers: { genspark: { apiKey: '' } } }),
    ).toBeNull()
    expect(extractLegacyAiSecrets({})).toBeNull()
    expect(extractLegacyAiSecrets(null)).toBeNull()
  })

  it('captures every nonempty provider apiKey and legacy top-level apiKey/baseUrl', () => {
    const payload = extractLegacyAiSecrets({
      apiKey: 'legacy-key',
      baseUrl: 'https://legacy.example/v1',
      model: 'gpt-x',
      providers: {
        anthropic: { apiKey: 'ant-key', model: 'c' },
        openai: { apiKey: '  ', model: 'o' },
        custom: { apiKey: 'cust-key', baseUrl: 'https://custom.example', model: 'm' },
        genspark: { apiKey: '', model: 'g' },
      },
    })
    expect(payload).not.toBeNull()
    expect(payload!.legacy).toEqual({
      apiKey: 'legacy-key',
      baseUrl: 'https://legacy.example/v1',
      model: 'gpt-x',
    })
    expect(payload!.providers.anthropic).toEqual({ apiKey: 'ant-key' })
    expect(payload!.providers.custom).toEqual({
      apiKey: 'cust-key',
      baseUrl: 'https://custom.example',
    })
    expect(payload!.providers.openai).toBeUndefined()
    expect(payload!.providers.genspark).toBeUndefined()
  })
})

describe('writePrivateJsonAtomic', () => {
  it('writes JSON with mode 0600', () => {
    const dir = tempDir()
    const path = join(dir, 'prefs.json')
    writePrivateJsonAtomic(path, { a: 1 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 })
    expect(modeOf(path)).toBe(0o600)
  })
})

describe('migrateLegacyAiProviderSecrets', () => {
  it('migrates secrets into an encrypted vault, verifies decrypt, sanitizes source, modes 0600', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'ai-provider-secrets.vault.json')
    const original = {
      provider: 'anthropic',
      providers: {
        genspark: { apiKey: '', model: 'claude-sonnet-4-6' },
        anthropic: { apiKey: 'sk-ant-SECRET', model: 'claude-x' },
        openai: { apiKey: 'sk-OPENAI', model: 'gpt-4' },
        custom: { apiKey: 'cust', baseUrl: 'https://my.proxy/v1', model: 'm' },
      },
    }
    writeFileSync(settingsPath, JSON.stringify(original, null, 2))
    chmodSync(settingsPath, 0o644)
    const originalBytes = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })

    expect(result.status).toBe('migrated')
    expect(existsSync(vaultPath)).toBe(true)
    expect(modeOf(vaultPath)).toBe(0o600)
    expect(modeOf(settingsPath)).toBe(0o600)

    // Source is preference-only — no secrets remain.
    const sanitized = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      provider: string
      providers: Record<string, { apiKey?: string; baseUrl?: string; model?: string }>
    }
    expect(sanitized.provider).toBe('genspark')
    expect(sanitized.providers.genspark.model).toBe('claude-sonnet-4-6')
    for (const p of Object.values(sanitized.providers)) {
      expect(p.apiKey ?? '').toBe('')
    }
    expect(sanitized.providers.custom?.baseUrl ?? '').toBe('')
    // Bytes changed (migration happened).
    expect(Buffer.compare(readFileSync(settingsPath), originalBytes)).not.toBe(0)

    // Vault decrypts and preserves every key.
    const vault = JSON.parse(readFileSync(vaultPath, 'utf8')) as {
      version: number
      ciphertext: string
    }
    expect(vault.version).toBe(1)
    const plain = fakeSafeStorage().decryptString(Buffer.from(vault.ciphertext, 'base64'))
    const payload = JSON.parse(plain) as {
      version: number
      providers: Record<string, { apiKey: string; baseUrl?: string }>
    }
    expect(payload.version).toBe(1)
    expect(payload.providers.anthropic.apiKey).toBe('sk-ant-SECRET')
    expect(payload.providers.openai.apiKey).toBe('sk-OPENAI')
    expect(payload.providers.custom.apiKey).toBe('cust')
    expect(payload.providers.custom.baseUrl).toBe('https://my.proxy/v1')
  })

  it('refuses Linux basic_text and leaves source bytes unchanged with no vault', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const body = JSON.stringify({ providers: { openai: { apiKey: 'sk-keep' } } })
    writeFileSync(settingsPath, body)
    const before = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })

    expect(result.status).toBe('skipped_insecure_storage')
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), before)).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toContain('sk-keep')
  })

  it('on encrypt failure leaves source unchanged and creates no vault', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const body = JSON.stringify({ providers: { openai: { apiKey: 'sk-keep' } } })
    writeFileSync(settingsPath, body)
    const before = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage({ encryptThrows: true }),
      toPreferenceOnly: preferenceOnly,
      platform: 'darwin',
    })

    expect(result.status).toBe('failed')
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), before)).toBe(0)
  })

  it('on decrypt verify failure leaves source unchanged and creates no final vault', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const body = JSON.stringify({ providers: { openai: { apiKey: 'sk-keep' } } })
    writeFileSync(settingsPath, body)
    const before = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage({ corruptDecrypt: true }),
      toPreferenceOnly: preferenceOnly,
      platform: 'darwin',
    })

    expect(result.status).toBe('failed')
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), before)).toBe(0)
  })

  it('is idempotent: second run does not rewrite or drop vault secrets', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ providers: { anthropic: { apiKey: 'sk-once', model: 'm' } } }),
    )

    const first = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })
    expect(first.status).toBe('migrated')
    const vaultBytes = readFileSync(vaultPath)
    const settingsBytes = readFileSync(settingsPath)

    const second = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })
    expect(second.status).toBe('already_migrated')
    expect(Buffer.compare(readFileSync(vaultPath), vaultBytes)).toBe(0)
    expect(Buffer.compare(readFileSync(settingsPath), settingsBytes)).toBe(0)

    const plain = fakeSafeStorage().decryptString(
      Buffer.from(JSON.parse(vaultBytes.toString('utf8')).ciphertext, 'base64'),
    )
    expect(JSON.parse(plain).providers.anthropic.apiKey).toBe('sk-once')
  })

  it('never logs secret values', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const secret = 'sk-MUST-NOT-APPEAR-IN-LOGS'
    writeFileSync(settingsPath, JSON.stringify({ providers: { openai: { apiKey: secret } } }))
    const lines: string[] = []
    migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
      log: (m) => lines.push(m),
    })
    expect(lines.join('\n')).not.toContain(secret)
    expect(lines.some((l) => /migrat/i.test(l))).toBe(true)
  })

  it('returns no_secrets when settings have no keys', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    writeFileSync(settingsPath, JSON.stringify(preferenceOnly({})))
    const before = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })

    expect(result.status).toBe('no_secrets')
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), before)).toBe(0)
  })
})

describe('loadAiSettingsJson', () => {
  it('runs migration then returns preference JSON', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({
        providers: {
          genspark: { apiKey: '', model: 'claude-haiku-4-5' },
          openai: { apiKey: 'sk-load' },
        },
      }),
    )

    const loaded = loadAiSettingsJson({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })

    expect(existsSync(vaultPath)).toBe(true)
    expect(loaded).toMatchObject({
      provider: 'genspark',
      providers: { genspark: { model: 'claude-haiku-4-5', apiKey: '' } },
    })
  })
})

function decryptVaultPayload(vaultPath: string): {
  version: number
  legacy?: { apiKey?: string; baseUrl?: string; model?: string }
  providers: Record<string, { apiKey: string; baseUrl?: string }>
} {
  const vault = JSON.parse(readFileSync(vaultPath, 'utf8')) as { ciphertext: string }
  const plain = fakeSafeStorage().decryptString(Buffer.from(vault.ciphertext, 'base64'))
  return JSON.parse(plain)
}

function nodeFs(): PrivateJsonFs {
  return {
    existsSync,
    readFileSync: readFileSync as PrivateJsonFs['readFileSync'],
    writeFileSync: writeFileSync as PrivateJsonFs['writeFileSync'],
    renameSync,
    unlinkSync,
    mkdirSync: mkdirSync as PrivateJsonFs['mkdirSync'],
    chmodSync,
  }
}

describe('applyAiSettingsPreferencesUpdate (guarded preference write)', () => {
  it('refuses preference write on Linux basic_text with legacy key; original settings bytes remain; no vault', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const body = JSON.stringify({ providers: { openai: { apiKey: 'sk-keep-pref' } } }, null, 2)
    writeFileSync(settingsPath, body)
    const before = readFileSync(settingsPath)

    const result = applyAiSettingsPreferencesUpdate({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage({ backend: 'basic_text' }),
      toPreferenceOnly: preferenceOnly,
      preferences: preferenceOnly({ providers: { genspark: { model: 'm' } } }),
      platform: 'linux',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toMatch(/blocked|skipped_insecure_storage/)
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), before)).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toContain('sk-keep-pref')
  })

  it('refuses preference write when encryption/verify fails; original bytes remain', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const body = JSON.stringify({ providers: { openai: { apiKey: 'sk-keep-fail' } } })
    writeFileSync(settingsPath, body)
    const before = readFileSync(settingsPath)

    const result = applyAiSettingsPreferencesUpdate({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage({ encryptThrows: true }),
      toPreferenceOnly: preferenceOnly,
      preferences: preferenceOnly({}),
      platform: 'darwin',
    })

    expect(result.ok).toBe(false)
    expect(result.status).toMatch(/blocked|failed/)
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), before)).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toContain('sk-keep-fail')
  })

  it('success/no-secrets path writes preferences mode 0600', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    writeFileSync(settingsPath, JSON.stringify(preferenceOnly({})), { mode: 0o644 })
    chmodSync(settingsPath, 0o644)

    const prefs = preferenceOnly({ providers: { genspark: { model: 'claude-opus-4-7' } } })
    const result = applyAiSettingsPreferencesUpdate({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      preferences: prefs,
      platform: 'linux',
    })

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(prefs)
    expect(modeOf(settingsPath)).toBe(0o600)
    expect(existsSync(vaultPath)).toBe(false)
  })
})

describe('existing vault merge', () => {
  it('merges existing vault key A with new plaintext key B; settings sanitized', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')

    // Seed vault with provider A only.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        apiKey: 'legacy-A',
        baseUrl: 'https://legacy-a.example',
        model: 'model-A',
        providers: { anthropic: { apiKey: 'sk-A', model: 'claude' } },
      }),
    )
    expect(
      migrateLegacyAiProviderSecrets({
        settingsPath,
        vaultPath,
        safeStorage: fakeSafeStorage(),
        toPreferenceOnly: preferenceOnly,
        platform: 'linux',
      }).status,
    ).toBe('migrated')

    // Settings later contain a new plaintext key B (unrelated id).
    writeFileSync(
      settingsPath,
      JSON.stringify({
        providers: {
          genspark: { apiKey: '', model: 'claude-sonnet-4-6' },
          openai: { apiKey: 'sk-B', model: 'gpt' },
        },
      }),
    )

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })

    expect(result.status).toBe('migrated')
    const payload = decryptVaultPayload(vaultPath)
    expect(payload.providers.anthropic.apiKey).toBe('sk-A')
    expect(payload.providers.openai.apiKey).toBe('sk-B')
    expect(payload.legacy).toEqual({
      apiKey: 'legacy-A',
      baseUrl: 'https://legacy-a.example',
      model: 'model-A',
    })

    const sanitized = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      providers: Record<string, { apiKey?: string }>
    }
    for (const p of Object.values(sanitized.providers)) {
      expect(p.apiKey ?? '').toBe('')
    }
  })

  it('fails closed when existing vault cannot be decrypted; source and prior vault bytes unchanged', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')

    writeFileSync(settingsPath, JSON.stringify({ providers: { anthropic: { apiKey: 'sk-A' } } }))
    expect(
      migrateLegacyAiProviderSecrets({
        settingsPath,
        vaultPath,
        safeStorage: fakeSafeStorage(),
        toPreferenceOnly: preferenceOnly,
        platform: 'linux',
      }).status,
    ).toBe('migrated')

    const priorVault = readFileSync(vaultPath)
    // New plaintext B, but vault decrypt will fail with a different adapter.
    const settingsBody = JSON.stringify({ providers: { openai: { apiKey: 'sk-B' } } })
    writeFileSync(settingsPath, settingsBody)
    const priorSettings = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage({ decryptThrows: true }),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })

    expect(result.status).toBe('failed')
    expect(Buffer.compare(readFileSync(vaultPath), priorVault)).toBe(0)
    expect(Buffer.compare(readFileSync(settingsPath), priorSettings)).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toContain('sk-B')
  })

  it('fails closed when existing vault shape is invalid; source and prior vault bytes unchanged', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    writeFileSync(vaultPath, JSON.stringify({ version: 1, backend: 'x', ciphertext: 'not-real' }))
    const priorVault = readFileSync(vaultPath)
    const settingsBody = JSON.stringify({ providers: { openai: { apiKey: 'sk-B' } } })
    writeFileSync(settingsPath, settingsBody)
    const priorSettings = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
    })

    expect(result.status).toBe('failed')
    expect(Buffer.compare(readFileSync(vaultPath), priorVault)).toBe(0)
    expect(Buffer.compare(readFileSync(settingsPath), priorSettings)).toBe(0)
  })
})

describe('migration rollback integrity', () => {
  it('when toPreferenceOnly throws, source and prior/no vault bytes unchanged', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const body = JSON.stringify({ providers: { openai: { apiKey: 'sk-throw-sanitizer' } } })
    writeFileSync(settingsPath, body)
    const before = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: () => {
        throw new Error('sanitizer boom')
      },
      platform: 'linux',
    })

    expect(result.status).toBe('failed')
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), before)).toBe(0)
  })

  it('when toPreferenceOnly throws after a prior vault existed, prior vault bytes restored', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    writeFileSync(settingsPath, JSON.stringify({ providers: { anthropic: { apiKey: 'sk-A' } } }))
    expect(
      migrateLegacyAiProviderSecrets({
        settingsPath,
        vaultPath,
        safeStorage: fakeSafeStorage(),
        toPreferenceOnly: preferenceOnly,
        platform: 'linux',
      }).status,
    ).toBe('migrated')
    const priorVault = readFileSync(vaultPath)

    writeFileSync(settingsPath, JSON.stringify({ providers: { openai: { apiKey: 'sk-B' } } }))
    const priorSettings = readFileSync(settingsPath)

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: () => {
        throw new Error('sanitizer boom')
      },
      platform: 'linux',
    })

    expect(result.status).toBe('failed')
    expect(Buffer.compare(readFileSync(vaultPath), priorVault)).toBe(0)
    expect(Buffer.compare(readFileSync(settingsPath), priorSettings)).toBe(0)
  })

  it('failure after vault final commit restores exact prior vault and settings bytes', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')

    writeFileSync(settingsPath, JSON.stringify({ providers: { anthropic: { apiKey: 'sk-A' } } }))
    expect(
      migrateLegacyAiProviderSecrets({
        settingsPath,
        vaultPath,
        safeStorage: fakeSafeStorage(),
        toPreferenceOnly: preferenceOnly,
        platform: 'linux',
      }).status,
    ).toBe('migrated')
    const priorVault = readFileSync(vaultPath)

    writeFileSync(settingsPath, JSON.stringify({ providers: { openai: { apiKey: 'sk-B' } } }))
    const priorSettings = readFileSync(settingsPath)

    let vaultFinalized = false
    let injectedSettingsFailure = false
    const fs: PrivateJsonFs = {
      ...nodeFs(),
      renameSync(from: string, to: string) {
        renameSync(from, to)
        if (to === vaultPath) vaultFinalized = true
      },
      writeFileSync(
        path: string,
        data: string | Buffer,
        opts?: { encoding?: BufferEncoding; mode?: number },
      ) {
        // After vault is at final path, fail the first settings-side write only
        // (tmp or direct) so rollback restore writes still succeed.
        if (vaultFinalized && !injectedSettingsFailure && String(path).startsWith(settingsPath)) {
          injectedSettingsFailure = true
          throw new Error('injected settings write failure')
        }
        writeFileSync(path, data, opts as { encoding?: BufferEncoding; mode?: number })
      },
    }

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
      fs,
    })

    expect(result.status).toBe('failed')
    expect(Buffer.compare(readFileSync(settingsPath), priorSettings)).toBe(0)
    expect(Buffer.compare(readFileSync(vaultPath), priorVault)).toBe(0)
    // Prior vault still holds A, not a partial B-only vault.
    expect(decryptVaultPayload(vaultPath).providers.anthropic.apiKey).toBe('sk-A')
  })

  it('failure after vault final commit with no prior vault removes the new vault and restores settings', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'ai-settings.json')
    const vaultPath = join(dir, 'vault.json')
    const body = JSON.stringify({ providers: { openai: { apiKey: 'sk-only' } } })
    writeFileSync(settingsPath, body)
    const priorSettings = readFileSync(settingsPath)

    let vaultFinalized = false
    let injectedSettingsFailure = false
    const fs: PrivateJsonFs = {
      ...nodeFs(),
      renameSync(from: string, to: string) {
        renameSync(from, to)
        if (to === vaultPath) vaultFinalized = true
      },
      writeFileSync(
        path: string,
        data: string | Buffer,
        opts?: { encoding?: BufferEncoding; mode?: number },
      ) {
        if (vaultFinalized && !injectedSettingsFailure && String(path).startsWith(settingsPath)) {
          injectedSettingsFailure = true
          throw new Error('injected settings write failure')
        }
        writeFileSync(path, data, opts as { encoding?: BufferEncoding; mode?: number })
      },
    }

    const result = migrateLegacyAiProviderSecrets({
      settingsPath,
      vaultPath,
      safeStorage: fakeSafeStorage(),
      toPreferenceOnly: preferenceOnly,
      platform: 'linux',
      fs,
    })

    expect(result.status).toBe('failed')
    expect(existsSync(vaultPath)).toBe(false)
    expect(Buffer.compare(readFileSync(settingsPath), priorSettings)).toBe(0)
  })
})

describe('app AI settings wiring (source contracts)', () => {
  const root = join(import.meta.dirname, '../../..')

  const MAIN_AI_FILES = [
    'apps/docs/src/main/docs-main.ts',
    'apps/slides/src/main/ai-ipc.ts',
    'apps/sheets/src/main/sheets-main.ts',
  ] as const

  for (const file of MAIN_AI_FILES) {
    it(`${file} migrates via shared helper and private-writes AI settings`, () => {
      const src = readFileSync(join(root, file), 'utf8')
      expect(src).toMatch(/loadAiSettingsJson|migrateLegacyAiProviderSecrets/)
      expect(src).toMatch(/safeStorage/)
      expect(src).toMatch(/AI_PROVIDER_SECRETS_VAULT_FILENAME/)
      expect(src).toMatch(/sanitizeRendererAiSettingsUpdate/)
    })

    it(`${file} set-settings uses guarded shared operation, not load-then-unconditional-write`, () => {
      const src = readFileSync(join(root, file), 'utf8')
      expect(src).toMatch(/applyAiSettingsPreferencesUpdate/)
      // Must not call load then unconditional preference write in set-settings.
      expect(src).not.toMatch(/loadStoredAiSettings\(\)\s*\n\s*writeAiSettingsPreferences\(/)
      expect(src).not.toMatch(
        /loadStoredAiSettings\(\)\s*\n\s*\/\/ Preference channel only[\s\S]{0,80}writeAiSettingsPreferences\(/,
      )
    })
  }
})
