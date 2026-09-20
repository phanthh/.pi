import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __setLogTestSink,
  applyCustomHeaders,
  type LogTestRecord,
  parseCustomHeaders,
} from '../index.ts'

describe('custom proxy headers', () => {
  let records: LogTestRecord[]

  beforeEach(() => {
    records = []
    __setLogTestSink((record) => records.push(record))
  })

  afterEach(() => {
    __setLogTestSink(null)
  })

  test('accepts optional whitespace after comma delimiters', () => {
    const headers = parseCustomHeaders(
      'x-one: one, x-two: two,\t x-three: value:with:colon',
    )

    expect(headers.get('x-one')).toBe('one')
    expect(headers.get('x-two')).toBe('two')
    expect(headers.get('x-three')).toBe('value:with:colon')
  })

  test('rejects the whole configuration when it tries to replace protected headers', () => {
    const headers = new Headers({
      authorization: 'Bearer route-secret',
      'anthropic-beta': 'required-beta',
    })

    applyCustomHeaders(
      headers,
      JSON.stringify({
        'x-safe-proxy-header': 'safe',
        authorization: 'Bearer attacker-controlled',
        'x-session-affinity': 'internal-header-reintroduced',
        'x-cortexkit-billing-lineage': 'forged-lineage',
      }),
    )

    expect(headers.get('authorization')).toBe('Bearer route-secret')
    expect(headers.get('anthropic-beta')).toBe('required-beta')
    expect(headers.get('x-safe-proxy-header')).toBeNull()
    expect(headers.get('x-session-affinity')).toBeNull()
    expect(headers.get('x-cortexkit-billing-lineage')).toBeNull()
  })

  test('rejects a forged internal billing-lineage header on its own', () => {
    const headers = new Headers({ authorization: 'Bearer route-secret' })

    applyCustomHeaders(
      headers,
      JSON.stringify({
        'x-safe-proxy-header': 'safe',
        'x-cortexkit-billing-lineage': 'forged-lineage',
      }),
    )

    expect(headers.get('authorization')).toBe('Bearer route-secret')
    expect(headers.get('x-safe-proxy-header')).toBeNull()
    expect(headers.get('x-cortexkit-billing-lineage')).toBeNull()
  })

  test('redacts malformed JSON and invalid header values from warning records', () => {
    const secret = `secret-${crypto.randomUUID()}`
    const malformedJson = `{"x-proxy-key":"${secret}"`
    const invalidValue = JSON.stringify({
      'x-proxy-key': `allowed\r\n${secret}`,
    })

    expect(() => parseCustomHeaders(malformedJson)).not.toThrow()
    expect(() => parseCustomHeaders(invalidValue)).not.toThrow()

    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain(secret)
    expect(
      records.filter(
        (record) =>
          record.channel === 'custom-headers' &&
          record.message === 'ignoring malformed ANTHROPIC_CUSTOM_HEADERS',
      ),
    ).toHaveLength(2)
  })
})
