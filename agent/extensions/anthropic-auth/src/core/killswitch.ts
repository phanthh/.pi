import type { KillswitchConfig, KillswitchThresholds } from './accounts.ts'
import {
  DEFAULT_KILLSWITCH_THRESHOLDS as DEFAULT_THRESHOLDS,
  normalizeKillswitchThresholds,
} from './accounts.ts'

export const KILLSWITCH_COMMAND_NAME = 'claude-killswitch'

export type KillswitchCommandAction =
  | { type: 'status' }
  | { type: 'on' }
  | { type: 'off' }
  | {
      type: 'set'
      entries: Array<{
        account: string
        fh: number
        sd: number
        scoped?: number
      }>
    }
  | { type: 'usage' }

export function parseKillswitchCommandAction(
  argumentsText: string,
): KillswitchCommandAction {
  const parts = argumentsText.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { type: 'status' }
  if (parts.length === 1 && parts[0] === 'on') return { type: 'on' }
  if (parts.length === 1 && parts[0] === 'off') return { type: 'off' }

  if (parts[0] === 'set') {
    const entries: Array<{
      account: string
      fh: number
      sd: number
      scoped?: number
    }> = []
    for (let i = 1; i < parts.length; i++) {
      const match = parts[i]?.match(/^([^:]+):(\d+),(\d+)(?:,(\d+))?$/)
      if (!match) return { type: 'usage' }
      const [, account, fhStr, sdStr, scopedStr] = match as RegExpMatchArray &
        [string, string, string, string, string | undefined]
      const scoped =
        typeof scopedStr === 'string' && scopedStr.length > 0
          ? Number.parseInt(scopedStr, 10)
          : undefined
      const entry: {
        account: string
        fh: number
        sd: number
        scoped?: number
      } = {
        account,
        fh: Number.parseInt(fhStr, 10),
        sd: Number.parseInt(sdStr, 10),
      }
      if (scoped !== undefined) entry.scoped = scoped
      entries.push(entry)
    }
    if (entries.length === 0) return { type: 'usage' }
    return { type: 'set', entries }
  }

  return { type: 'usage' }
}

function buildStatusTable(
  config: KillswitchConfig,
  accountIds: string[],
): string {
  const enabled = config.enabled === true
  const lines: string[] = [
    '## Killswitch',
    '',
    `Status: **${enabled ? 'ON' : 'OFF'}**`,
  ]

  if (enabled) {
    lines.push('')
    lines.push('| Account | 5h threshold | 1w threshold | Scoped |')
    lines.push('| ------- | ------------ | ------------ | ------ |')

    const mainT = normalizeKillswitchThresholds(config.main)
    lines.push(
      `| main | \u2265 ${mainT.five_hour}% | \u2265 ${mainT.seven_day}% | \u2264 ${mainT.scoped}% |`,
    )

    for (const id of accountIds) {
      const t = normalizeKillswitchThresholds(
        config.accounts?.[id] ?? config.main,
      )
      lines.push(
        `| ${id} | \u2265 ${t.five_hour}% | \u2265 ${t.seven_day}% | \u2264 ${t.scoped}% |`,
      )
    }
  }

  return lines.join('\n')
}

const USAGE_TEXT = [
  '## Killswitch Commands',
  '',
  '```',
  `/${KILLSWITCH_COMMAND_NAME}              — show status`,
  `/${KILLSWITCH_COMMAND_NAME} on           — enable with current or default thresholds`,
  `/${KILLSWITCH_COMMAND_NAME} off          — disable`,
  `/${KILLSWITCH_COMMAND_NAME} set all:5,10 — set all accounts to 5h≥5%, 1w≥10%`,
  `/${KILLSWITCH_COMMAND_NAME} set main:3,8,0 — set 5h≥3%, 1w≥8%, scoped≤0%`,
  `/${KILLSWITCH_COMMAND_NAME} set main:3,8 work-alt:5,10 — per-account`,
  '```',
].join('\n')

export function executeKillswitchCommand(input: {
  argumentsText: string
  config: KillswitchConfig
  accountIds: string[]
}): { text: string; updatedConfig?: KillswitchConfig } {
  const action = parseKillswitchCommandAction(input.argumentsText)

  if (action.type === 'status') {
    const status = buildStatusTable(input.config, input.accountIds)
    return { text: `${status}\n\n${USAGE_TEXT}` }
  }

  if (action.type === 'on') {
    const updated: KillswitchConfig = {
      ...input.config,
      enabled: true,
      main: input.config.main ?? {
        five_hour: DEFAULT_THRESHOLDS.five_hour,
        seven_day: DEFAULT_THRESHOLDS.seven_day,
      },
    }
    const status = buildStatusTable(updated, input.accountIds)
    return {
      text: `## Killswitch Enabled\n\n${status}`,
      updatedConfig: updated,
    }
  }

  if (action.type === 'off') {
    const updated: KillswitchConfig = { ...input.config, enabled: false }
    return {
      text: '## Killswitch Disabled',
      updatedConfig: updated,
    }
  }

  if (action.type === 'set') {
    const accounts = { ...(input.config.accounts ?? {}) }
    const updated: KillswitchConfig = {
      ...input.config,
      enabled: true,
      accounts,
    }
    for (const entry of action.entries) {
      const thresholds: KillswitchThresholds = {
        five_hour: entry.fh,
        seven_day: entry.sd,
      }
      if (entry.scoped !== undefined) thresholds.scoped = entry.scoped
      if (entry.account === 'main') {
        updated.main = thresholds
      } else if (entry.account === 'all') {
        updated.main = thresholds
        for (const id of input.accountIds) {
          accounts[id] = thresholds
        }
      } else {
        accounts[entry.account] = thresholds
      }
    }

    const status = buildStatusTable(updated, input.accountIds)
    return {
      text: `## Killswitch Updated\n\n${status}`,
      updatedConfig: updated,
    }
  }

  // usage
  const status = buildStatusTable(input.config, input.accountIds)
  return { text: `${status}\n\n${USAGE_TEXT}` }
}
