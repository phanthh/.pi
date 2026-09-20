import { describe, expect, test } from 'bun:test'
import {
  applyThinkingBindingControls,
  getThinkingPrefixMismatchBehavior,
  hasReplayableThinkingBlocks,
  hasThinkingBindingControls,
} from '../thinking-binding.ts'

const bodyWith = (model: string, block?: Record<string, unknown>) => ({
  model,
  thinking: { type: 'adaptive', display: 'summarized' },
  messages: [
    { role: 'user', content: 'summary' },
    ...(block
      ? [
          {
            role: 'assistant',
            content: [block, { type: 'text', text: 'answer' }],
          },
          { role: 'user', content: 'continue' },
        ]
      : []),
  ],
})

describe('Fable 5.1 thinking binding controls', () => {
  test('does nothing when no replayable thinking block exists', () => {
    const body = bodyWith('claude-fable-5-1')

    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
    expect(hasThinkingBindingControls(body)).toBe(false)
  })

  test('leaves replay behavior to the account by default', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'signature',
    })

    expect(hasReplayableThinkingBlocks(body)).toBe(true)
    expect(applyThinkingBindingControls(body, 'account-default')).toBe(false)
    expect(body.thinking.block_binding).toBeUndefined()
    expect(hasThinkingBindingControls(body)).toBe(false)
  })

  test('adds an explicit drop_block override for signed history', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'signature',
    })

    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(true)
    expect(body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    })
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('adds an explicit error override for prefix-mismatch testing', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'signature',
    })

    expect(applyThinkingBindingControls(body, 'error')).toBe(true)
    expect(body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'error',
    })
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('recognizes redacted Fable 5.1 thinking history', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'redacted_thinking',
      data: 'redacted-payload',
    })

    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(true)
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('does not apply Fable prefix controls to Mythos 5.1 or older models', () => {
    for (const model of ['claude-mythos-5-1', 'claude-fable-5']) {
      const body = bodyWith(model, {
        type: 'thinking',
        thinking: 'reasoning',
        signature: 'signature',
      })
      expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
      expect(hasThinkingBindingControls(body)).toBe(false)
    }
  })

  test('reads only explicit persisted behavior values', () => {
    expect(getThinkingPrefixMismatchBehavior({})).toBe('account-default')
    expect(
      getThinkingPrefixMismatchBehavior({
        thinkingBinding: { prefixMismatchBehavior: 'error' },
      }),
    ).toBe('error')
    expect(
      getThinkingPrefixMismatchBehavior({
        thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
      }),
    ).toBe('drop_block')
    expect(
      getThinkingPrefixMismatchBehavior({
        thinkingBinding: { prefixMismatchBehavior: 'invalid' as never },
      }),
    ).toBe('account-default')
  })
})
