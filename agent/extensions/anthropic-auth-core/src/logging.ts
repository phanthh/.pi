import type { LogLevel } from './logger.ts'

// Known limitation: the TUI bundle is a SEPARATE module instance from the loader,
// so /claude-logging sets the SERVER-side (loader) logger level and persists it
// (applied on next boot); the TUI-side logger level is only raised via the
// OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL env override. The command still correctly
// persists and applies server-side — just note this asymmetry.

export const CLAUDE_LOGGING_COMMAND_NAME = 'claude-logging'
export const LOGGING_LEVELS: LogLevel[] = [
  'error',
  'warn',
  'info',
  'debug',
  'trace',
]

const LOGGING_USAGE =
  'Usage: `/claude-logging`, `/claude-logging error|warn|info|debug|trace`.'

export type LoggingCommandAction =
  | { type: 'status' }
  | { type: 'level'; level: LogLevel }
  | { type: 'usage' }

export function parseLoggingCommandAction(
  argumentsText: string,
): LoggingCommandAction {
  const tokens = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { type: 'status' }
  if (tokens.length === 1 && LOGGING_LEVELS.includes(tokens[0] as LogLevel)) {
    return { type: 'level', level: tokens[0] as LogLevel }
  }
  return { type: 'usage' }
}

export function buildLoggingStatusSummary(input?: { level?: LogLevel }) {
  const level = input?.level ?? 'info'
  return [
    '## Claude Log Level',
    '',
    `Current log level: \`${level}\``,
    '- Persisted: ~/.config/opencode/anthropic-auth.json',
    '- Valid levels: error, warn, info, debug, trace',
    '',
    LOGGING_USAGE,
  ].join('\n')
}

export function executeLoggingCommand(input: {
  argumentsText: string
  level?: LogLevel
}) {
  const action = parseLoggingCommandAction(input.argumentsText)
  const level = input.level ?? 'info'

  if (action.type === 'status') return buildLoggingStatusSummary({ level })

  if (action.type === 'level') {
    return [
      '## Claude Log Level Updated',
      '',
      `Level set to \`${action.level}\`.`,
      '',
      ...buildLoggingStatusSummary({ level: action.level })
        .split('\n')
        .slice(2),
    ].join('\n')
  }

  return [
    '## Claude Log Level Usage',
    '',
    LOGGING_USAGE,
    '',
    ...buildLoggingStatusSummary({ level }).split('\n').slice(2),
  ].join('\n')
}
