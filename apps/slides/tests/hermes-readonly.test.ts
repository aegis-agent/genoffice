import { describe, expect, it } from 'vitest'
import type { AgentSkill } from '@genoffice/agent-core'
import {
  buildHermesSlidesReadonlySystemPrompt,
  composeSlidesPanelSkills,
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

describe('composeSlidesPanelSkills', () => {
  it('fail-closes initial null/empty/hermes to read-only zero-tool skill', async () => {
    let slidesReached = false
    const slides: AgentSkill = {
      id: 'slides',
      systemPrompt: 'PROMPT_slides',
      tools: [{ name: 'execute_slide_script', description: '', inputSchema: {} }],
      buildContext: () => 'CTX_slides',
      executeTool: () => {
        slidesReached = true
        return { output: 'mutated', summary: 'execute_slide_script', mutated: true }
      },
    }
    const files = stubSkill('files', ['read_attachment'])

    for (const provider of [null, undefined, '', 'hermes'] as const) {
      expect(resolveNativeHermesAgentMode(provider)).toBe('hermes')
      const skill = composeSlidesPanelSkills({
        provider,
        slidesSkill: slides,
        filesSkill: files,
      })
      expect(skill.systemPrompt).toBe(buildHermesSlidesReadonlySystemPrompt())
      expect(skill.systemPrompt).toMatch(/read-only|cannot mutate/i)
      expect(skill.systemPrompt).toMatch(/unavailable/i)
      expect(skill.systemPrompt).not.toContain('PROMPT_slides')
      expect(skill.tools).toEqual([])
      expect(skill.buildContext?.()).toContain('CTX_slides')
      expect(skill.buildContext?.()).toContain('CTX_files')

      const rejected = await skill.executeTool({
        id: '1',
        name: 'execute_slide_script',
        input: {},
      })
      expect(slidesReached).toBe(false)
      expect(rejected.isError).toBe(true)
      expect(rejected.mutated).toBeFalsy()
      expect(rejected.output).toMatch(/unknown tool|no client tools/i)
    }
  })

  it('retains local tools only for explicit non-hermes providers', () => {
    const skill = composeSlidesPanelSkills({
      provider: 'openai',
      slidesSkill: stubSkill('slides', ['execute_slide_script']),
      filesSkill: stubSkill('files', ['read_attachment']),
    })
    expect(skill.systemPrompt).toContain('PROMPT_slides')
    expect(skill.tools.map((t) => t.name)).toEqual(['execute_slide_script', 'read_attachment'])
  })
})
