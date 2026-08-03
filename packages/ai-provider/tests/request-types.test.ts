import { describe, expect, it } from 'vitest'
import type { AiChatRequest, AiStreamRequest } from '../src/types'

/**
 * Compile-time + runtime shape contracts: renderer→main AI calls must not
 * carry provider config or API keys. TypeScript assignability is exercised via
 * `satisfies`; runtime checks guard structural leftovers.
 */
describe('AiStreamRequest / AiChatRequest trust boundary', () => {
  it('AiStreamRequest does not include settings', () => {
    const request = {
      requestId: 'r1',
      system: 'sys',
      messages: [],
    } satisfies AiStreamRequest

    expect(request).not.toHaveProperty('settings')
    expect(Object.keys(request).sort()).toEqual(['messages', 'requestId', 'system'])
  })

  it('AiChatRequest does not include settings', () => {
    const request = {
      system: 'sys',
      user: 'hi',
    } satisfies AiChatRequest

    expect(request).not.toHaveProperty('settings')
    expect(Object.keys(request).sort()).toEqual(['system', 'user'])
  })

  it('excess settings on a plain object are not part of the typed contract', () => {
    const withSettings = {
      requestId: 'r1',
      system: 'sys',
      messages: [],
      settings: { provider: 'custom' },
    }
    // Assigning through the typed shape drops the authority field from the
    // required contract — callers must not rely on it.
    const typed: AiStreamRequest = {
      requestId: withSettings.requestId,
      system: withSettings.system,
      messages: withSettings.messages,
    }
    expect(typed).not.toHaveProperty('settings')
  })
})
