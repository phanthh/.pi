/**
 * Remap canonical Claude model IDs to proxy-compatible names
 * using ANTHROPIC_DEFAULT_*_MODEL env vars.
 *
 * LiteLLM/proxy backends often use shorter model aliases
 * (e.g. `claude-sonnet-4-6` instead of `claude-sonnet-4-20250514`).
 * These proxy-route variables follow the Claude Code convention, except
 * ANTHROPIC_DEFAULT_FABLE_MODEL, which is plugin-specific:
 *
 *   ANTHROPIC_MODEL                  — default for any claude-* model
 *   ANTHROPIC_DEFAULT_SONNET_MODEL   — models matching claude-sonnet-*
 *   ANTHROPIC_DEFAULT_OPUS_MODEL     — models matching claude-opus-*
 *   ANTHROPIC_DEFAULT_HAIKU_MODEL    — models matching claude-haiku-*
 *   ANTHROPIC_DEFAULT_FABLE_MODEL    — models matching claude-fable / claude-mythos
 *
 * Tier-specific vars take precedence over the generic ANTHROPIC_MODEL.
 */

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

type ModelTier = 'sonnet' | 'opus' | 'haiku' | 'fable'

function getModelTier(model: string): ModelTier | null {
  if (/^claude-sonnet(?:-|$)/.test(model)) return 'sonnet'
  if (/^claude-opus(?:-|$)/.test(model)) return 'opus'
  if (/^claude-haiku(?:-|$)/.test(model)) return 'haiku'
  if (/^claude-(?:fable|mythos)(?:-|$)/.test(model)) return 'fable'
  return null
}

const TIER_ENV_MAP: Record<ModelTier, string> = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
}

/**
 * Resolve a canonical model ID to its proxy-compatible alias.
 * Returns the original model when no env override is configured.
 */
export function remapModelId(model: string): string {
  if (typeof model !== 'string' || !model) return model

  const tier = getModelTier(model)
  if (tier) {
    const tierModel = getEnv(TIER_ENV_MAP[tier])
    if (tierModel) return tierModel
  }

  // Generic fallback for any claude-* model
  if (model.startsWith('claude-')) {
    const defaultModel = getEnv('ANTHROPIC_MODEL')
    if (defaultModel) return defaultModel
  }

  return model
}

/**
 * Remap the `model` field in a parsed request body in place.
 * Returns true if the model was changed.
 */
export function remapRequestBodyModel(
  parsed: Record<string, unknown>,
): boolean {
  if (typeof parsed.model !== 'string') return false
  const remapped = remapModelId(parsed.model)
  if (remapped === parsed.model) return false
  parsed.model = remapped
  return true
}
