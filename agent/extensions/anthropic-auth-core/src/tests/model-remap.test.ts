import { afterEach, describe, expect, test } from 'bun:test'
import { remapModelId } from '../model-remap.ts'

const MODEL_ENV_NAMES = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const

const originals = new Map(
  MODEL_ENV_NAMES.map((name) => [name, process.env[name]]),
)

afterEach(() => {
  for (const [name, value] of originals) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('proxy model remapping', () => {
  test('requires a family boundary before applying a tier override', () => {
    process.env.ANTHROPIC_MODEL = 'generic-alias'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet-alias'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'fable-alias'

    expect(remapModelId('claude-sonnet-4-6')).toBe('sonnet-alias')
    expect(remapModelId('claude-sonnetx')).toBe('generic-alias')
    expect(remapModelId('claude-fable-5-1')).toBe('fable-alias')
    expect(remapModelId('claude-fablet')).toBe('generic-alias')
  })

  test('keeps bracketed capability suffixes in the canonical family', () => {
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'fable-proxy-alias'
    expect(remapModelId('claude-fable-5-1[1m]')).toBe('fable-proxy-alias')
  })
})
