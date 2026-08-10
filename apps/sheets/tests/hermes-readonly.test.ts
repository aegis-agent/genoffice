import { describe, expect, it } from 'vitest'
import type { AgentSkill } from '@genoffice/agent-core'
import {
  buildHermesSheetsReadonlySystemPrompt,
  composeSheetsPanelSkills,
  isSheetsAgentConfigured,
  resolveNativeHermesAgentMode,
} from '../src/renderer/ai/hermes-readonly'

function stubSkill(id: string, tools: string[] = []): AgentSkill {
  return {
    id,
    systemPrompt: `PROMPT_${id}`,
    tools: tools.map((name) => ({ name, description: '', inputSchema: {} })),
    buildContext: () => `CTX_${id}`,
    executeTool: () => ({ output: `${id}-executed`, summary: id, mutated: true }),
  }
}

describe('isSheetsAgentConfigured', () => {
  it('treats hermes as configured even with blank redacted renderer apiKey', () => {
    expect(
      isSheetsAgentConfigured({
        provider: 'hermes',
        providers: {
          hermes: { model: 'hermes-agent', apiKey: '' },
        },
      }),
    ).toBe(true)
  })

  it('treats genspark as configured without renderer apiKey', () => {
    expect(
      isSheetsAgentConfigured({
        provider: 'genspark',
        providers: {
          genspark: { model: 'claude-opus-4-7', apiKey: '' },
        },
      }),
    ).toBe(true)
  })

  it('requires apiKey for key-bearing providers and rejects missing settings/model', () => {
    expect(isSheetsAgentConfigured(null)).toBe(false)
    expect(isSheetsAgentConfigured(undefined)).toBe(false)
    expect(
      isSheetsAgentConfigured({
        provider: 'openai',
        providers: { openai: { model: 'gpt-4.1-mini', apiKey: '' } },
      }),
    ).toBe(false)
    expect(
      isSheetsAgentConfigured({
        provider: 'openai',
        providers: { openai: { model: 'gpt-4.1-mini', apiKey: 'sk-test' } },
      }),
    ).toBe(true)
    expect(
      isSheetsAgentConfigured({
        provider: 'hermes',
        providers: { hermes: { model: '', apiKey: '' } },
      }),
    ).toBe(false)
  })
})

describe('composeSheetsPanelSkills', () => {
  it('fail-closes initial null/empty/hermes to read-only zero-tool skill', async () => {
    let workbookReached = false
    const workbook: AgentSkill = {
      id: 'sheets',
      systemPrompt: 'PROMPT_workbook',
      tools: [{ name: 'propose_operations', description: '', inputSchema: {} }],
      buildContext: () => 'CTX_workbook',
      executeTool: () => {
        workbookReached = true
        return { output: 'mutated', summary: 'propose_operations', mutated: true }
      },
    }
    const files = stubSkill('files', ['read_attachment'])
    const search = stubSkill('search', ['web_search'])

    for (const provider of [null, undefined, '', 'hermes'] as const) {
      expect(resolveNativeHermesAgentMode(provider)).toBe('hermes')
      const skill = composeSheetsPanelSkills({
        provider,
        workbookSkill: workbook,
        filesSkill: files,
        searchSkill: search,
      })
      expect(skill.systemPrompt).toBe(buildHermesSheetsReadonlySystemPrompt())
      expect(skill.systemPrompt).toMatch(/read-only|cannot mutate Sheets/i)
      expect(skill.systemPrompt).toMatch(/unavailable/i)
      expect(skill.systemPrompt).not.toContain('PROMPT_workbook')
      expect(skill.tools).toEqual([])
      expect(skill.buildContext?.()).toContain('CTX_workbook')
      expect(skill.buildContext?.()).toContain('CTX_files')
      expect(skill.buildContext?.()).toContain('CTX_search')

      const rejected = await skill.executeTool({
        id: '1',
        name: 'propose_operations',
        input: {},
      })
      expect(workbookReached).toBe(false)
      expect(rejected.isError).toBe(true)
      expect(rejected.mutated).toBeFalsy()
      expect(rejected.output).toMatch(/unknown tool|no client tools/i)
    }
  })

  it('retains local tools only for explicit non-hermes providers', () => {
    const skill = composeSheetsPanelSkills({
      provider: 'anthropic',
      workbookSkill: stubSkill('workbook', ['propose_operations']),
      filesSkill: stubSkill('files', ['read_attachment']),
      searchSkill: stubSkill('search', ['web_search']),
    })
    expect(skill.systemPrompt).toContain('PROMPT_workbook')
    expect(skill.tools.map((t) => t.name)).toEqual([
      'propose_operations',
      'read_attachment',
      'web_search',
    ])
  })
})
