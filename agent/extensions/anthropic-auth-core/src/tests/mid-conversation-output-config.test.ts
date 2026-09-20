import { describe, expect, test } from 'bun:test'
import {
  applyMidConversationOutputConfig,
  MID_CONVERSATION_OUTPUT_CONFIG_BETA,
  normalizeAdaptiveEffort,
  usesMidConversationOutputConfig,
} from '../mid-conversation-output-config.ts'

function body(model = 'claude-fable-5-1') {
  return {
    model,
    output_config: { effort: 'max', format: { type: 'json_schema' } },
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'third' },
    ],
  } as Record<string, unknown>
}

describe('Fable 5.1 mid-conversation output configuration', () => {
  test('anchors top-level effort to the earliest retained turn and inserts later changes', () => {
    const request = body()

    expect(
      applyMidConversationOutputConfig(request, [
        { afterAssistantMessages: 0, effort: 'low' },
        { afterAssistantMessages: 1, effort: 'high' },
        { afterAssistantMessages: 2, effort: 'max' },
      ]),
    ).toEqual({ applied: true, inserted: 2 })

    expect(request.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema' },
    })
    expect(request.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      {
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'two' },
      {
        role: 'system',
        content: [],
        output_config: { effort: 'max' },
      },
      { role: 'user', content: 'third' },
    ])
  })

  test('keeps a stable top-level effort when the history has no change', () => {
    const request = body()

    expect(
      applyMidConversationOutputConfig(request, [
        { afterAssistantMessages: 0, effort: 'medium' },
        { afterAssistantMessages: 1, effort: 'medium' },
        { afterAssistantMessages: 2, effort: 'medium' },
      ]),
    ).toEqual({ applied: true, inserted: 0 })
    expect(request.output_config).toMatchObject({ effort: 'medium' })
    expect((request.messages as unknown[]).length).toBe(5)
  })

  test('uses the latest effort selected before the same user boundary', () => {
    const request = body()

    applyMidConversationOutputConfig(request, [
      { afterAssistantMessages: 0, effort: 'low' },
      { afterAssistantMessages: 1, effort: 'medium' },
      { afterAssistantMessages: 1, effort: 'high' },
    ])

    expect(request.output_config).toMatchObject({ effort: 'low' })
    expect(request.messages).toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    expect(request.messages).not.toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'medium' },
    })
  })

  test('does not add Fable 5.1 controls to other models', () => {
    for (const model of [
      'claude-fable-5',
      'claude-mythos-5-1',
      'claude-opus-5',
    ]) {
      const request = body(model)
      const before = structuredClone(request)
      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
        ]),
      ).toEqual({ applied: false, inserted: 0 })
      expect(request).toEqual(before)
      expect(usesMidConversationOutputConfig(request)).toBe(false)
    }
  })

  test('always identifies Fable 5.1 requests for the beta header', () => {
    expect(usesMidConversationOutputConfig(body())).toBe(true)
    expect(MID_CONVERSATION_OUTPUT_CONFIG_BETA).toBe(
      'mid-conversation-output-config-2026-07-01',
    )
  })

  test('normalizes host effort names', () => {
    expect(normalizeAdaptiveEffort('minimal')).toBe('low')
    expect(normalizeAdaptiveEffort('xhigh')).toBe('xhigh')
    expect(normalizeAdaptiveEffort('off')).toBeUndefined()
    expect(normalizeAdaptiveEffort('unknown')).toBeUndefined()
  })
})
