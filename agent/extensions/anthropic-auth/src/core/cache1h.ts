import { type Cache1hMode, DEFAULT_CACHE_1H_MODE } from './constants.ts'

export const CACHE_1H_COMMAND_NAME = 'claude-cache'

const CACHE_1H_STATUS_TITLE = '## Claude Cache Status'
const CACHE_1H_ENABLED_TITLE = '## Claude Cache Enabled'
const CACHE_1H_DISABLED_TITLE = '## Claude Cache Disabled'
const CACHE_1H_USAGE_TITLE = '## Claude Cache Usage'
const CACHE_1H_USAGE =
  'Usage: `/claude-cache`, `/claude-cache on`, `/claude-cache off`, or `/claude-cache mode explicit|automatic|hybrid`.'

let cache1hEnabled = false
let cache1hMode: Cache1hMode = DEFAULT_CACHE_1H_MODE

export type Cache1hCommandAction =
  | { type: 'status' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'mode'; mode: Cache1hMode }
  | { type: 'usage' }

export function isCache1hEnabled() {
  return cache1hEnabled
}

export function getCache1hMode() {
  return cache1hMode
}

export function setCache1hEnabled(enabled: boolean) {
  cache1hEnabled = enabled
}

export function setCache1hMode(mode: Cache1hMode) {
  cache1hMode = mode
}

export function setCache1hState(input: {
  enabled: boolean
  mode: Cache1hMode
}) {
  cache1hEnabled = input.enabled
  cache1hMode = input.mode
}

export function resetCache1hState() {
  cache1hEnabled = false
  cache1hMode = DEFAULT_CACHE_1H_MODE
}

export function parseCache1hCommandAction(
  argumentsText: string,
): Cache1hCommandAction {
  const normalized = argumentsText.trim().split(/\s+/).filter(Boolean)

  if (normalized.length === 0) return { type: 'status' }
  if (normalized.length === 1 && normalized[0] === 'on')
    return { type: 'enable' }
  if (normalized.length === 1 && normalized[0] === 'off')
    return { type: 'disable' }
  if (
    normalized.length === 2 &&
    normalized[0] === 'mode' &&
    (normalized[1] === 'explicit' ||
      normalized[1] === 'automatic' ||
      normalized[1] === 'hybrid')
  ) {
    return { type: 'mode', mode: normalized[1] }
  }
  return { type: 'usage' }
}

export function buildCache1hStatusSummary(input?: {
  enabled?: boolean
  mode?: Cache1hMode
}) {
  const enabled = input?.enabled ?? cache1hEnabled
  const mode = input?.mode ?? cache1hMode
  return [
    CACHE_1H_STATUS_TITLE,
    '',
    `- Enabled: ${enabled ? 'enabled' : 'disabled'}`,
    `- Mode: ${mode}`,
    '- Persisted: ~/.config/opencode/anthropic-auth.json',
    '- Scope: main sessions only; subagent sessions keep default ephemeral cache behavior',
    '- Modes: explicit = existing OpenCode breakpoints; automatic = top-level cache_control only; hybrid = system + messages[0] + top-level cache_control',
    '- TTL: 1h when enabled for main sessions; default ephemeral cache behavior otherwise',
  ].join('\n')
}

export function executeCache1hCommand(input: {
  argumentsText: string
  enabled?: boolean
  mode?: Cache1hMode
}) {
  const action = parseCache1hCommandAction(input.argumentsText)
  const enabled = input.enabled ?? cache1hEnabled
  const mode = input.mode ?? cache1hMode

  if (action.type === 'status')
    return buildCache1hStatusSummary({ enabled, mode })

  if (action.type === 'enable') {
    return [
      CACHE_1H_ENABLED_TITLE,
      '',
      buildCache1hStatusSummary({ enabled: true, mode }),
    ].join('\n')
  }

  if (action.type === 'disable') {
    return [
      CACHE_1H_DISABLED_TITLE,
      '',
      buildCache1hStatusSummary({ enabled: false, mode }),
    ].join('\n')
  }

  if (action.type === 'mode') {
    return [
      CACHE_1H_STATUS_TITLE,
      '',
      `Mode updated to \`${action.mode}\`.`,
      '',
      buildCache1hStatusSummary({ enabled, mode: action.mode }),
    ].join('\n')
  }

  return [
    CACHE_1H_USAGE_TITLE,
    '',
    CACHE_1H_USAGE,
    '',
    buildCache1hStatusSummary({ enabled, mode }),
  ].join('\n')
}
