import { isClaudeFable51Model } from './models.ts'

export const MID_CONVERSATION_OUTPUT_CONFIG_BETA =
  'mid-conversation-output-config-2026-07-01'

export type AdaptiveEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type MidConversationEffortTransition = {
  /** Number of assistant messages preceding the user boundary for this effort. */
  afterAssistantMessages: number
  effort: AdaptiveEffort
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeAdaptiveEffort(
  value: unknown,
): AdaptiveEffort | undefined {
  if (value === 'minimal') return 'low'
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value
  }
  return undefined
}

export function usesMidConversationOutputConfig(
  body: Record<string, unknown>,
): boolean {
  return isClaudeFable51Model(body.model)
}

function compactTransitions(
  transitions: readonly MidConversationEffortTransition[],
) {
  const compacted: MidConversationEffortTransition[] = []
  for (const transition of transitions) {
    if (
      !Number.isSafeInteger(transition.afterAssistantMessages) ||
      transition.afterAssistantMessages < 0 ||
      !normalizeAdaptiveEffort(transition.effort)
    ) {
      continue
    }
    const normalized = {
      afterAssistantMessages: transition.afterAssistantMessages,
      effort: transition.effort,
    }
    const previous = compacted.at(-1)
    if (
      previous &&
      previous.afterAssistantMessages === normalized.afterAssistantMessages
    ) {
      previous.effort = normalized.effort
      continue
    }
    if (previous?.effort === normalized.effort) continue
    compacted.push(normalized)
  }
  return compacted
}

export function applyMidConversationOutputConfig(
  body: Record<string, unknown>,
  transitions: readonly MidConversationEffortTransition[],
): { applied: boolean; inserted: number } {
  if (!usesMidConversationOutputConfig(body) || !Array.isArray(body.messages)) {
    return { applied: false, inserted: 0 }
  }

  const compacted = compactTransitions(transitions)
  const currentOutputConfig = isRecord(body.output_config)
    ? body.output_config
    : {}
  const baseline =
    compacted[0]?.effort ??
    normalizeAdaptiveEffort(currentOutputConfig.effort) ??
    'high'
  body.output_config = { ...currentOutputConfig, effort: baseline }

  if (compacted.length < 2) return { applied: true, inserted: 0 }

  const messages = body.messages as unknown[]
  const transitionsByBoundary = new Map<number, AdaptiveEffort>()
  for (const transition of compacted.slice(1)) {
    transitionsByBoundary.set(
      transition.afterAssistantMessages,
      transition.effort,
    )
  }

  let assistantMessages = 0
  let activeEffort = baseline
  let inserted = 0
  const rewritten: unknown[] = []
  for (const message of messages) {
    if (
      isRecord(message) &&
      message.role === 'user' &&
      transitionsByBoundary.has(assistantMessages)
    ) {
      const effort = transitionsByBoundary.get(assistantMessages)
      if (effort && effort !== activeEffort) {
        rewritten.push({
          role: 'system',
          content: [],
          output_config: { effort },
        })
        activeEffort = effort
        inserted++
      }
    }
    rewritten.push(message)
    if (isRecord(message) && message.role === 'assistant') assistantMessages++
  }

  body.messages = rewritten
  return { applied: true, inserted }
}
