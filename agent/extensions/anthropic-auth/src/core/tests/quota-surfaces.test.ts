import { describe, expect, test } from 'bun:test'

import { fetchOAuthQuotaSnapshot } from '../accounts.ts'
import {
  isQuotaBearingHeaderFrame,
  normalizeQuotaHeaders,
} from '../quota-headers.ts'

const MAIN_USAGE_CAPTURE = {
  five_hour: { utilization: 4 },
  seven_day: { utilization: 13 },
  limits: [
    { kind: 'session', group: 'session', percent: 4, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 13, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 15,
      is_active: true,
      scope: { model: { id: null, display_name: 'Fable' } },
    },
  ],
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
  spend: null,
}

const TEAM_USAGE_CAPTURE = {
  five_hour: { utilization: 77 },
  seven_day: { utilization: 40 },
  limits: [
    { kind: 'session', group: 'session', percent: 77, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 51,
      is_active: false,
      scope: { model: { id: null, display_name: 'Fable' } },
    },
  ],
  extra_usage: {
    is_enabled: true,
    monthly_limit: 10000,
    used_credits: 10035,
    utilization: 100,
  },
  spend: {
    severity: 'critical',
    limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
    can_purchase_credits: false,
  },
}

const MAIN_HEADERS = new Headers({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-reset': '1784252400',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-5h-reset': '1784252400',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.12',
  'anthropic-ratelimit-unified-7d-reset': '1784502000',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
})

const TEAM_HEADERS = new Headers({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-reset': '1784246400',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.78',
  'anthropic-ratelimit-unified-5h-reset': '1784246400',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': '1784628000',
  'anthropic-ratelimit-unified-fallback': 'available',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-disabled-reason':
    'org_spend_cap_reached',
  'anthropic-ratelimit-unified-overage-utilization': '1.0',
  'anthropic-ratelimit-unified-overage-surpassed-threshold': '1.0',
  'anthropic-ratelimit-unified-overage-reset': '1785542400',
})

async function snapshotFor(capture: unknown) {
  return fetchOAuthQuotaSnapshot({
    accessToken: 'test-token',
    now: () => 1_700_000_000_000,
    fetchImpl: (async () => Response.json(capture)) as unknown as typeof fetch,
  })
}

describe('quota surface normalization', () => {
  test('normalizes enabled exhausted extra usage from the Team capture', async () => {
    const team = await snapshotFor(TEAM_USAGE_CAPTURE)

    expect(team.extraUsage?.used.amountMinor).toBe(10035)
    expect(team.extraUsage?.limit.amountMinor).toBe(10000)
    expect(team.extraUsage?.severity).toBe('critical')
    expect(team.extraUsage?.exhausted).toBe(true)
    expect(team.source).toBe('poll')
  })

  test('omits extraUsage when the personal capture says is_enabled false', async () => {
    const main = await snapshotFor(MAIN_USAGE_CAPTURE)

    expect(main.extraUsage).toBeUndefined()
  })

  test('rejects extra usage with invalid currency or exponent metadata', async () => {
    const invalidCurrency = await snapshotFor({
      ...TEAM_USAGE_CAPTURE,
      spend: {
        ...TEAM_USAGE_CAPTURE.spend,
        limit: { amount_minor: 10000, currency: 'ZZZZ', exponent: 2 },
      },
    })
    const invalidExponent = await snapshotFor({
      ...TEAM_USAGE_CAPTURE,
      spend: {
        ...TEAM_USAGE_CAPTURE.spend,
        limit: { amount_minor: 10000, currency: 'USD', exponent: 50 },
      },
    })

    expect(invalidCurrency.extraUsage).toBeUndefined()
    expect(invalidExponent.extraUsage).toBeUndefined()
  })

  test('maps the active session limit to bindingWindow five_hour', async () => {
    const team = await snapshotFor(TEAM_USAGE_CAPTURE)

    expect(team.bindingWindow).toBe('five_hour')
    expect(team.bindingWindowSource).toBe('poll')
  })

  test('maps an active scoped limit to its wire-derived identity without coercing it to seven_day', async () => {
    const main = await snapshotFor(MAIN_USAGE_CAPTURE)

    expect(main.bindingWindow).toBe('claude-weekly-scoped-fable')
    expect(main.bindingWindowSource).toBe('poll')
  })

  test('classifies a frame only when at least one unified utilization header exists', () => {
    expect(isQuotaBearingHeaderFrame(MAIN_HEADERS)).toBe(true)
    expect(
      isQuotaBearingHeaderFrame(
        new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }),
      ),
    ).toBe(false)
  })

  test('rejects overage-only utilization frames', () => {
    expect(
      isQuotaBearingHeaderFrame(
        new Headers({
          'anthropic-ratelimit-unified-overage-utilization': '0.8',
        }),
      ),
    ).toBe(false)
  })

  test('normalizes the personal Max 20x capture with rounded percentages and ISO resets', () => {
    const now = 1_700_000_000_000
    const personal = normalizeQuotaHeaders(MAIN_HEADERS, now)

    expect(personal).toMatchObject({
      five_hour: { usedPercent: 3, remainingPercent: 97, checkedAt: now },
      seven_day: { usedPercent: 12, remainingPercent: 88, checkedAt: now },
      bindingWindow: 'five_hour',
      bindingWindowSource: 'headers',
      source: 'headers',
      checkedAt: now,
    })
    expect(personal.five_hour?.resetsAt).toBe(
      new Date(1784252400 * 1000).toISOString(),
    )
    expect(personal.fallbackAdvised).toBe(false)
  })

  test('normalizes the Team Max-5x capture and fallback advisory', () => {
    const team = normalizeQuotaHeaders(TEAM_HEADERS)

    expect(team.five_hour?.usedPercent).toBe(78)
    expect(team.seven_day?.usedPercent).toBe(40)
    expect(team.fallbackAdvised).toBe(true)
  })

  test('treats every non-core header as optional', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.125',
    })

    expect(normalizeQuotaHeaders(headers).five_hour?.usedPercent).toBe(13)
  })

  test('rejects non-finite utilization and reset values without throwing', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': 'Infinity',
      'anthropic-ratelimit-unified-5h-reset': 'not-a-number',
      'anthropic-ratelimit-unified-7d-utilization': 'NaN',
    })

    expect(normalizeQuotaHeaders(headers)).toMatchObject({
      fallbackAdvised: false,
      source: 'headers',
    })
    expect(normalizeQuotaHeaders(headers).five_hour).toBeUndefined()
    expect(normalizeQuotaHeaders(headers).seven_day).toBeUndefined()
    expect(isQuotaBearingHeaderFrame(headers)).toBe(false)
  })

  test('keeps valid windows when reset values exceed the JavaScript date range', () => {
    const snapshot = normalizeQuotaHeaders(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-5h-reset': '1e308',
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-7d-reset': '1e308',
      }),
    )

    expect(snapshot.five_hour?.usedPercent).toBe(20)
    expect(snapshot.seven_day?.usedPercent).toBe(40)
    expect(snapshot.five_hour?.resetsAt).toBeUndefined()
    expect(snapshot.seven_day?.resetsAt).toBeUndefined()
  })
})
