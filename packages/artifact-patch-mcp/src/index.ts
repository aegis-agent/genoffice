export {
  createArtifactPatchMcpServer,
  createArtifactPatchMcpServerAsync,
  resolveArtifactRoot,
  type CreateArtifactPatchMcpServerOptions,
  type ArtifactPatchMcpServerHandle,
} from './server'
export { ConfirmationStore } from './confirmation-store'
export {
  resolveSourceDocxPath,
  resolveDestinationDocxPath,
  MAX_PENDING_CONFIRMATIONS,
  DEFAULT_CONFIRMATION_TTL_MS,
} from './path-policy'
export { ArtifactPatchMcpError, mcpErrorCodeSchema, mcpErrorOutputSchema } from './errors'
export {
  DEFAULT_MCP_MAX_COMPRESSED_BYTES,
  MAX_MCP_MAX_COMPRESSED_BYTES,
  MAX_PATCH_OPERATIONS,
  MAX_INSPECTION_BLOCKS,
  MAX_INSPECTION_TEXT_CHARS,
  MAX_PROPOSAL_TEXT_CHARS,
  MAX_PENDING_CONFIRMATION_TEXT_CHARS,
  MAX_DOCX_ZIP_ENTRIES,
  MAX_DOCX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_DOCX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  enforceInspectionBudget,
  readSourceBytesWithinLimit,
  assertDocxZipPreflight,
  proposalRetainedTextChars,
} from './limits'
