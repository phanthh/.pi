/**
 * Cross-process request spacing. Every pi process (main session + subagents)
 * reserves the next start slot in a shared file under the OS temp dir, so the
 * combined SearXNG request rate stays below upstream engine rate limits.
 */
import { mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 15;

function paths() {
	const dir = tmpdir();
	return {
		lock: join(dir, "pi-web-search.lock"),
		state: join(dir, "pi-web-search.next"),
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function withLock<T>(
	fn: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const { lock } = paths();
	for (;;) {
		signal?.throwIfAborted();
		try {
			await mkdir(lock);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
					await rmdir(lock).catch(() => {});
					continue;
				}
			} catch {
				continue; // released between mkdir and stat
			}
			await sleep(LOCK_RETRY_MS, signal);
		}
	}
	try {
		return await fn();
	} finally {
		await rmdir(lock).catch(() => {});
	}
}

/** Reserve the next global start slot; returns how long the caller waits. */
export async function reserveSlot(
	intervalMs: number,
	signal?: AbortSignal,
): Promise<number> {
	if (intervalMs <= 0) return 0;
	const { state } = paths();
	const start = await withLock(async () => {
		let next = 0;
		try {
			next = Number(await readFile(state, "utf-8")) || 0;
		} catch {
			/* first use */
		}
		const now = Date.now();
		const slot = Math.max(now, next);
		await writeFile(state, String(slot + intervalMs));
		return slot;
	}, signal);
	return Math.max(0, start - Date.now());
}

/** Wait for this caller's slot. */
export async function throttle(
	intervalMs: number,
	signal?: AbortSignal,
): Promise<number> {
	const wait = await reserveSlot(intervalMs, signal);
	await sleep(wait, signal);
	return wait;
}
