import { createHash } from 'node:crypto'

/**
 * Stable, non-reversible fingerprint used to bind persisted state to an access
 * token without storing another copy of the credential.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}
