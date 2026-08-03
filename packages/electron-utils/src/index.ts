export { installNavigationGuard } from './navigation-guard'
export { safeExternalUrl, type SafeExternalUrlOptions } from './safe-external-url'
export {
  fetchWithSsrfGuard,
  isBlockedAddress,
  isSafeRemoteUrl,
  type FetchWithSsrfGuardOptions,
} from './safe-remote-url'
export {
  ReadablePathGrantRegistry,
  type GrantCleanupSender,
  type RealpathFn,
} from './readable-path-grants'
export { DroppedPathPermitGate, type ConsumeAllResult } from './dropped-path-permits'
export {
  AI_PROVIDER_SECRETS_VAULT_FILENAME,
  AI_PROVIDER_SECRETS_VAULT_VERSION,
  AI_SETTINGS_PREFERENCE_WRITE_SAFE_STATUSES,
  LINUX_SECURE_STORAGE_BACKENDS,
  applyAiSettingsPreferencesUpdate,
  assessSecureEncryption,
  extractLegacyAiSecrets,
  loadAiSettingsJson,
  mergeAiProviderSecretsPayloads,
  migrateLegacyAiProviderSecrets,
  writeAiSettingsPreferences,
  writePrivateJsonAtomic,
  type AiProviderSecretsPayload,
  type AiProviderSecretsVaultFile,
  type AiSecretsMigrationResult,
  type AiSecretsMigrationStatus,
  type ApplyAiSettingsPreferencesOptions,
  type ApplyAiSettingsPreferencesResult,
  type ApplyAiSettingsPreferencesStatus,
  type MigrateLegacyAiProviderSecretsOptions,
  type PrivateJsonFs,
  type SafeStorageAdapter,
  type SecureEncryptionAssessment,
} from './ai-settings-secrets'
