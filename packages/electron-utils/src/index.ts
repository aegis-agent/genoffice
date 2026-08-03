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
export { IpcValidationError, safeHandle, type IpcMainLike, type RuntimeSchema } from './safe-handle'
export {
  IPC_PATH_LIST_MAX,
  IPC_PATH_MAX,
  IPC_PASTED_IMAGE_EXT_MAX,
  IPC_PASTED_IMAGE_MAX_BYTES,
  IPC_READ_MAX_CHARS_MAX,
  IPC_READ_OFFSET_MAX,
  filesAddArgsSchema,
  filesAddPastedImageArgsSchema,
  filesPickArgsSchema,
  filesReadArgsSchema,
  filesReadImageArgsSchema,
  type FilesAddArgs,
  type FilesAddPastedImageArgs,
  type FilesReadArgs,
  type FilesReadImageArgs,
} from './ipc-arg-schemas'
