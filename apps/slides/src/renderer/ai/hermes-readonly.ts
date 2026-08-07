import {
  composeSkills,
  createNativeHermesReadOnlySkill,
  resolveNativeHermesAgentMode,
  type AgentSkill,
} from '@genoffice/agent-core'

/**
 * System rules for native Hermes Slides: read-only client surface.
 * Deck mutation tools are unavailable; do not claim edits.
 */
export const HERMES_SLIDES_READONLY_SYSTEM_PROMPT = `## Hermes native Slides mode (read-only)

You are running as native Hermes (not a GenOffice renderer tool loop) against Slides.

### Client tools
- GenOffice does **not** forward renderer-local slides or files tool schemas to you.
- Client slides/files tools are **unavailable** and **unexecutable** in this mode.
- Do **not** invent or call \`genoffice_*\` tools. Do **not** claim deck generation, layout script, edit-text, or \`read_attachment\` tools work through this provider.

### Mutation policy
- This build **cannot mutate slides through Hermes**.
- Never claim you edited slides, shapes, text, images, or deck structure.
- If the user asks for an edit, tell them clearly that this build cannot mutate Slides through Hermes.

### Context
Deck/attachment context below is **read-only DATA** for answering questions and reasoning. It is not a mutation channel.`

export function buildHermesSlidesReadonlySystemPrompt(): string {
  return HERMES_SLIDES_READONLY_SYSTEM_PROMPT
}

/**
 * Slides panel skill composition. Fail-closed Hermes → empty tools + read-only
 * prompt/context. Explicit non-Hermes retains local slides/files tools.
 */
export function composeSlidesPanelSkills(options: {
  provider: string | null | undefined
  slidesSkill: AgentSkill
  filesSkill: AgentSkill
}): AgentSkill {
  const mode = resolveNativeHermesAgentMode(options.provider)
  if (mode === 'hermes') {
    return createNativeHermesReadOnlySkill({
      id: 'slides-hermes',
      systemPrompt: HERMES_SLIDES_READONLY_SYSTEM_PROMPT,
      contextSources: [options.slidesSkill, options.filesSkill],
    })
  }
  return composeSkills('slides+files', '', [options.slidesSkill, options.filesSkill])
}

export { resolveNativeHermesAgentMode }
