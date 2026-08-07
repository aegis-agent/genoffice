import type { AgentToolCall, AgentToolDef, ToolExecution } from './types'

/**
 * A skill packages one capability domain for the agent loop: its system
 * prompt section, its tools, per-turn context, and the tool executor.
 * AI Docs ships a docx skill; Excel / PPT skills plug in the same way.
 */
export interface AgentSkill {
  id: string
  /** system prompt section describing this skill's rules and tools */
  systemPrompt: string
  tools: AgentToolDef[]
  /**
   * Fresh context sections attached to every user turn (e.g. document
   * skeleton + selection). Return '' when there is nothing to attach.
   */
  buildContext?(): string
  /**
   * signal: aborted when the user hits stop. Long-running tools (e.g.
   * generate_deck with internal LLM calls) should check signal.aborted in
   * their loops and stop promptly.
   */
  executeTool(call: AgentToolCall, signal?: AbortSignal): ToolExecution | Promise<ToolExecution>
}

/**
 * Merge several skills into one (tool names must be globally unique).
 * `intro` becomes the shared preamble of the combined system prompt.
 *
 * systemPrompt and tools are snapshotted at compose time so mid-session
 * child getter/backing-state changes cannot drift the AgentLoop skill.
 * buildContext stays live (per-turn document/attachment state).
 */
export function composeSkills(id: string, intro: string, skills: AgentSkill[]): AgentSkill {
  const owner = new Map<string, AgentSkill>()
  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (owner.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`)
      owner.set(tool.name, skill)
    }
  }
  // Snapshot prompt + tool defs at compose time (immutable composition).
  const systemPrompt = [intro, ...skills.map((s) => s.systemPrompt)].filter(Boolean).join('\n\n')
  const tools = skills.flatMap((s) => s.tools)
  return {
    id,
    systemPrompt,
    tools,
    buildContext: () =>
      skills
        .map((s) => s.buildContext?.() ?? '')
        .filter(Boolean)
        .join('\n\n'),
    executeTool: (call, signal) => {
      const skill = owner.get(call.name)
      if (!skill) {
        return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      return skill.executeTool(call, signal)
    },
  }
}

export type NativeHermesContextSource =
  (() => string) | Pick<AgentSkill, 'buildContext'> | { buildContext?: () => string }

export interface NativeHermesReadOnlySkillOptions {
  id: string
  /** Sole system prompt for native Hermes mode (never merged from source skills). */
  systemPrompt: string
  /**
   * Read-only per-turn context only. Source skills' system prompts, tool defs,
   * and executors are intentionally ignored — mutation must not be reachable.
   */
  contextSources?: readonly NativeHermesContextSource[]
}

/**
 * Immutable native-Hermes skill: fixed system prompt, empty tools, rejecting
 * executor. Optionally folds live `buildContext` from source skills without
 * reusing their prompts or executors.
 */
export function createNativeHermesReadOnlySkill(
  options: NativeHermesReadOnlySkillOptions,
): AgentSkill {
  const systemPrompt = options.systemPrompt
  const tools = Object.freeze([] as AgentToolDef[])
  const sources = options.contextSources ?? []
  return {
    id: options.id,
    systemPrompt,
    tools: tools as AgentToolDef[],
    buildContext: () =>
      sources
        .map((source) => {
          if (typeof source === 'function') return source()
          return source.buildContext?.() ?? ''
        })
        .filter(Boolean)
        .join('\n\n'),
    executeTool: (call) => ({
      output: `Unknown tool: ${call.name}. Native Hermes mode exposes no client tools.`,
      isError: true,
      summary: call.name,
    }),
  }
}

/**
 * Fail-closed agent mode for main-owned Hermes lock.
 * Unknown/null/empty provider → hermes (tool-less). Explicit non-hermes only
 * when a concrete non-hermes provider id is known before loop creation.
 */
export function resolveNativeHermesAgentMode(
  provider: string | null | undefined,
): 'hermes' | 'local-tools' {
  if (typeof provider === 'string' && provider.length > 0 && provider !== 'hermes') {
    return 'local-tools'
  }
  return 'hermes'
}
