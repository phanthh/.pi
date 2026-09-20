import type {
  AccountQuotaWindow,
  AccountScopedQuotaWindow,
  AccountStorage,
  OAuthAccount,
  OAuthQuotaSnapshot,
  QuotaMoney,
  QuotaWindowName,
} from './accounts.ts'
import { isOAuthAccount } from './accounts.ts'
import { formatOAuthAccountTier } from './oauth-profile.ts'

export const CLAUDE_QUOTAS_COMMAND_NAME = 'claude-quota'

const WINDOW_LABELS: Record<QuotaWindowName, string> = {
  five_hour: '5h',
  seven_day: '1w',
}

export type QuotaAccountSummary = {
  name: string
  role: 'main' | 'fallback'
  enabled?: boolean
  quota?: OAuthQuotaSnapshot
  lastRefreshedAt?: number
  error?: string
  tierLabel?: string
}

function formatPercent(value: number) {
  return `${Math.round(value * 10) / 10}%`
}

function formatAge(checkedAt: number, now: number) {
  const elapsedMs = Math.max(0, now - checkedAt)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1m ago'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (remainder === 0) return `${hours}h ago`
  return `${hours}h ${remainder}m ago`
}

function formatResetDuration(resetsAt: string, now: number) {
  const resetTime = Date.parse(resetsAt)
  if (!Number.isFinite(resetTime)) return resetsAt

  const remainingMs = resetTime - now
  if (remainingMs <= 0) return 'now'

  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  if (totalMinutes < 60) return `in ${totalMinutes}m`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes === 0) return `in ${hours}h`
  return `in ${hours}h ${minutes}m`
}

function formatReset(resetsAt: string | undefined, now: number) {
  if (!resetsAt) return ''
  return `, resets ${formatResetDuration(resetsAt, now)}`
}

function formatWindow(
  key: QuotaWindowName,
  window: AccountQuotaWindow | undefined,
  now: number,
  bindingWindow?: string,
) {
  if (!window) return `  - ${WINDOW_LABELS[key]}: unknown`
  const line = [
    `  - ${WINDOW_LABELS[key]}: ${formatPercent(window.remainingPercent)} remaining`,
    ` (${formatPercent(window.usedPercent)} used`,
    `${formatReset(window.resetsAt, now)}, checked ${formatAge(window.checkedAt, now)})`,
  ].join('')
  return bindingWindow === key ? `${line} •` : line
}

export function formatQuotaMoney(money: QuotaMoney) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: money.currency,
      minimumFractionDigits: money.exponent,
      maximumFractionDigits: money.exponent,
    }).format(money.amountMinor / 10 ** money.exponent)
  } catch {
    return `${money.amountMinor} ${money.currency}`
  }
}

function formatScopedWindow(window: AccountScopedQuotaWindow, now: number) {
  return [
    `  - ${window.title}: ${formatPercent(window.remainingPercent)} remaining`,
    ` (${formatPercent(window.usedPercent)} used`,
    `${formatReset(window.resetsAt, now)}, checked ${formatAge(window.checkedAt, now)})`,
  ].join('')
}

function accountName(account: OAuthAccount) {
  return account.label?.trim() || account.id
}

function accountStoredError(account: OAuthAccount) {
  return (
    account.lastQuotaRefreshError?.message ?? account.lastRefreshError?.message
  )
}

export function buildFallbackQuotaSummaries(
  storage: AccountStorage | null,
  errors: ReadonlyMap<string, string> = new Map(),
) {
  if (!storage?.accounts.length) return []
  return storage.accounts.filter(isOAuthAccount).map((account) => {
    const error = errors.get(account.id) ?? accountStoredError(account)
    return {
      name: accountName(account),
      role: 'fallback' as const,
      enabled: account.enabled !== false,
      quota: account.quota,
      ...(formatOAuthAccountTier(account.profile) && {
        tierLabel: formatOAuthAccountTier(account.profile),
      }),
      lastRefreshedAt: account.lastRefreshedAt,
      ...(error && { error }),
    }
  })
}

export function buildClaudeQuotaSummary(input: {
  accounts: QuotaAccountSummary[]
  refreshedAt?: number
  now?: number
}) {
  const now = input.now ?? Date.now()
  const lines = ['## Claude Quotas', '']

  if (input.refreshedAt) {
    lines.push(`Refreshed: ${formatAge(input.refreshedAt, now)}`, '')
  }

  if (!input.accounts.length) {
    lines.push('No Claude OAuth accounts found yet.')
    return lines.join('\n')
  }

  for (const account of input.accounts) {
    const role = account.role === 'main' ? 'main' : 'fallback'
    const disabled = account.enabled === false ? ' disabled' : ''
    lines.push(`### ${account.name} (${role}${disabled})`)
    if (account.tierLabel) lines.push(`  - Tier: ${account.tierLabel}`)
    if (account.lastRefreshedAt) {
      lines.push(
        `  - Last token refresh: ${formatAge(account.lastRefreshedAt, now)}`,
      )
    }
    if (account.error) {
      lines.push(`  - Error: ${account.error}`)
    }
    lines.push(
      formatWindow(
        'five_hour',
        account.quota?.five_hour,
        now,
        account.quota?.bindingWindow,
      ),
    )
    lines.push(
      formatWindow(
        'seven_day',
        account.quota?.seven_day,
        now,
        account.quota?.bindingWindow,
      ),
    )
    for (const window of account.quota?.scoped ?? []) {
      const line = formatScopedWindow(window, now)
      lines.push(
        account.quota?.bindingWindow === window.id ? `${line} •` : line,
      )
    }
    const extraUsage = account.quota?.extraUsage
    if (extraUsage) {
      const used = formatQuotaMoney(extraUsage.used)
      const limit = formatQuotaMoney(extraUsage.limit)
      lines.push(
        `  - credits ${used}/${limit}${extraUsage.exhausted ? ' · exhausted' : ''}`,
      )
    }
    if (account.quota?.fallbackAdvised === true) {
      lines.push('  - → fallback advised')
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
