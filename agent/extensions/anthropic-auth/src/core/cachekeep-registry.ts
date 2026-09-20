import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CACHE_KEEP_REGISTRY_LEASE_MS = 3 * 60_000

export type CacheKeepTrackedSession = {
  id: string
  cacheExpiresAt: number
  nextPrewarmAt: number
}

type CacheKeepRegistryRecord = {
  version: 1
  updatedAt: number
  sessions: CacheKeepTrackedSession[]
}

function normalizeSession(value: unknown): CacheKeepTrackedSession | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.cacheExpiresAt !== 'number' ||
    !Number.isFinite(record.cacheExpiresAt) ||
    typeof record.nextPrewarmAt !== 'number' ||
    !Number.isFinite(record.nextPrewarmAt)
  ) {
    return
  }
  return {
    id: record.id,
    cacheExpiresAt: record.cacheExpiresAt,
    nextPrewarmAt: record.nextPrewarmAt,
  }
}

function normalizeRecord(value: unknown): CacheKeepRegistryRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    !Array.isArray(record.sessions)
  ) {
    return
  }
  return {
    version: 1,
    updatedAt: record.updatedAt,
    sessions: record.sessions.flatMap((session) => {
      const normalized = normalizeSession(session)
      return normalized ? [normalized] : []
    }),
  }
}

export function getDefaultCacheKeepRegistryDirectory(scope: 'opencode' | 'pi') {
  return join(tmpdir(), 'opencode-anthropic-auth', 'cachekeep-sessions', scope)
}

export class CacheKeepSessionRegistry {
  private readonly filePath: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      directory: string
      now?: () => number
      leaseMs?: number
      instanceId?: string
    },
  ) {
    const instanceId = options.instanceId ?? `${process.pid}-${randomUUID()}`
    this.filePath = join(options.directory, `${instanceId}.json`)
  }

  publish(sessions: readonly CacheKeepTrackedSession[]): Promise<void> {
    const snapshot = sessions.map((session) => ({ ...session }))
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        if (snapshot.length === 0) {
          await rm(this.filePath, { force: true })
          return
        }
        await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
        const tempPath = `${this.filePath}.${randomUUID()}.tmp`
        const record: CacheKeepRegistryRecord = {
          version: 1,
          updatedAt: this.options.now?.() ?? Date.now(),
          sessions: snapshot,
        }
        await writeFile(tempPath, `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        })
        await rename(tempPath, this.filePath)
      })
    return this.writeChain
  }

  async list(
    localSessions: readonly CacheKeepTrackedSession[] = [],
  ): Promise<CacheKeepTrackedSession[]> {
    await this.writeChain.catch(() => {})
    const now = this.options.now?.() ?? Date.now()
    const leaseMs = this.options.leaseMs ?? CACHE_KEEP_REGISTRY_LEASE_MS
    let names: string[]
    try {
      names = (await readdir(this.options.directory)).filter((name) =>
        name.endsWith('.json'),
      )
    } catch {
      names = []
    }

    const records = await Promise.all(
      names.map(async (name) => {
        try {
          const raw = await readFile(join(this.options.directory, name), 'utf8')
          return normalizeRecord(JSON.parse(raw))
        } catch {
          return undefined
        }
      }),
    )
    const sessions = new Map<string, CacheKeepTrackedSession>()
    for (const record of records) {
      if (
        !record ||
        now - record.updatedAt > leaseMs ||
        record.updatedAt > now
      ) {
        continue
      }
      for (const session of record.sessions) {
        const existing = sessions.get(session.id)
        if (!existing || session.cacheExpiresAt > existing.cacheExpiresAt) {
          sessions.set(session.id, session)
        }
      }
    }
    for (const session of localSessions) {
      const existing = sessions.get(session.id)
      if (!existing || session.cacheExpiresAt > existing.cacheExpiresAt) {
        sessions.set(session.id, { ...session })
      }
    }
    return [...sessions.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
  }

  async dispose(): Promise<void> {
    await this.writeChain.catch(() => {})
    await rm(this.filePath, { force: true })
  }
}
