import { parseJsonRedacted } from './json.ts'
import { logger } from './logger.ts'

export const ANTHROPIC_CUSTOM_HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS'

type HeaderEntries = Array<[string, string]>

const CUSTOM_HEADER_CACHE_LIMIT = 64
const parsedHeadersByRawValue = new Map<string, HeaderEntries | null>()
const warnedMalformedRawValues = new Set<string>()

// Proxy-specific metadata is allowed, but custom configuration must never
// replace route authentication, protocol negotiation, body framing, or
// plugin-internal correlation headers after those guards have run.
const PROTECTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'anthropic-version',
  'anthropic-beta',
  'x-parent-session-id',
  'x-session-affinity',
  'x-opencode-session',
  'x-anthropic-effort-plan',
  'x-cortexkit-billing-lineage',
])

function cacheParsed(raw: string, entries: HeaderEntries | null) {
  parsedHeadersByRawValue.delete(raw)
  parsedHeadersByRawValue.set(raw, entries)
  while (parsedHeadersByRawValue.size > CUSTOM_HEADER_CACHE_LIMIT) {
    const oldest = parsedHeadersByRawValue.keys().next().value
    if (oldest === undefined) break
    parsedHeadersByRawValue.delete(oldest)
    warnedMalformedRawValues.delete(oldest)
  }
}

function setCustomHeader(headers: Headers, name: string, value: string) {
  if (PROTECTED_HEADERS.has(name.trim().toLowerCase())) {
    throw new TypeError('protected header')
  }
  headers.set(name, value)
}

export function parseCustomHeaders(raw: string | undefined): Headers {
  if (!raw?.trim()) return new Headers()

  const cached = parsedHeadersByRawValue.get(raw)
  if (cached !== undefined || parsedHeadersByRawValue.has(raw)) {
    return new Headers(cached ?? [])
  }

  try {
    const headers = new Headers()
    const trimmed = raw.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      for (const entry of trimmed
        .split(/\r?\n|,\s*(?=[^,\s:]+:)/)
        .map((value) => value.trim())
        .filter(Boolean)) {
        const separator = entry.indexOf(':')
        if (separator <= 0) {
          throw new TypeError('invalid header entry')
        }
        setCustomHeader(
          headers,
          entry.slice(0, separator).trim(),
          entry.slice(separator + 1).trim(),
        )
      }
    } else {
      const parsed = parseJsonRedacted(trimmed)
      if (
        parsed == null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new TypeError('invalid header object')
      }

      for (const [key, value] of Object.entries(parsed)) {
        if (value == null) continue
        setCustomHeader(
          headers,
          key,
          Array.isArray(value) ? value.map(String).join(', ') : String(value),
        )
      }
    }

    const entries = [...headers.entries()] as HeaderEntries
    cacheParsed(raw, entries)
    return new Headers(entries)
  } catch {
    cacheParsed(raw, null)
    if (!warnedMalformedRawValues.has(raw)) {
      warnedMalformedRawValues.add(raw)
      logger.warn(
        'custom-headers',
        'ignoring malformed ANTHROPIC_CUSTOM_HEADERS',
        { reason: 'invalid or protected header configuration' },
      )
    }
    return new Headers()
  }
}

export function applyCustomHeaders(
  headers: Headers,
  raw = process.env[ANTHROPIC_CUSTOM_HEADERS_ENV],
): Headers {
  const customHeaders = parseCustomHeaders(raw)
  customHeaders.forEach((value, key) => {
    headers.set(key, value)
  })
  return headers
}
