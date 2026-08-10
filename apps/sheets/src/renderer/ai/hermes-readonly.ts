import {
  composeSkills,
  createNativeHermesReadOnlySkill,
  resolveNativeHermesAgentMode,
  type AgentSkill,
} from '@genoffice/agent-core'

/**
 * System rules for native Hermes Sheets: read-only client surface.
 * Workbook mutation tools are unavailable; do not claim edits.
 */
export const HERMES_SHEETS_READONLY_SYSTEM_PROMPT = `## Hermes native Sheets mode (read-only)

You are running as native Hermes (not a GenOffice renderer tool loop) against Sheets.

### Client tools
- GenOffice does **not** forward renderer-local workbook, search, or files tool schemas to you.
- Client workbook/search/files tools are **unavailable** and **unexecutable** in this mode.
- Do **not** invent or call \`genoffice_*\` tools. Do **not** claim \`propose_operations\`, workbook DSL tools, search tools, or \`read_attachment\` work through this provider.

### Mutation policy
- This build **cannot mutate Sheets through Hermes**.
- Never claim you edited cells, sheets, charts, names, pivots, filters, or any workbook state.
- If the user asks for an edit, tell them clearly that this build cannot mutate Sheets through Hermes.

### Context
Workbook/attachment context below is **read-only DATA** for answering questions and reasoning. It is not a mutation channel.`

export function buildHermesSheetsReadonlySystemPrompt(): string {
  return HERMES_SHEETS_READONLY_SYSTEM_PROMPT
}

export interface SheetsAiSettingsLike {
  provider: string
  providers: Record<string, { model?: string; apiKey?: string } | undefined>
}

/**
 * Pure readiness for the Sheets AgentLoop path.
 * Hermes (and historical Genspark) keys are main-owned / redacted in public
 * renderer settings — treat those providers as configured so NL sends take the
 * agent path; main returns the real missing-key/network error if env is absent.
 */
export function isSheetsAgentConfigured(
  settings: SheetsAiSettingsLike | null | undefined,
): boolean {
  if (!settings) return false
  const config = settings.providers[settings.provider]
  if (!config?.model) return false
  return settings.provider === 'hermes' || settings.provider === 'genspark' || !!config.apiKey
}

/**
 * Sheets panel skill composition. Fail-closed Hermes → empty tools + read-only
 * prompt/context. Explicit non-Hermes retains local workbook/files/search tools.
 */
export function composeSheetsPanelSkills(options: {
  provider: string | null | undefined
  workbookSkill: AgentSkill
  filesSkill: AgentSkill
  searchSkill: AgentSkill
}): AgentSkill {
  const mode = resolveNativeHermesAgentMode(options.provider)
  if (mode === 'hermes') {
    return createNativeHermesReadOnlySkill({
      id: 'sheets-hermes',
      systemPrompt: HERMES_SHEETS_READONLY_SYSTEM_PROMPT,
      contextSources: [options.workbookSkill, options.filesSkill, options.searchSkill],
    })
  }
  return composeSkills('sheets+files', '', [
    options.workbookSkill,
    options.filesSkill,
    options.searchSkill,
  ])
}

export { resolveNativeHermesAgentMode }
