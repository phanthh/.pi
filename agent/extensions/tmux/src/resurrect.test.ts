import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerResurrect } from "./resurrect.ts";

function harness(t: TestContext, inTmux = true) {
	const original = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
	process.env.TMUX = inTmux ? "/tmp/test-socket,1,0" : "";
	process.env.TMUX_PANE = "%12";
	let shutdown: () => void | Promise<void> = () => {};
	const originalListeners = new Set(process.listeners("SIGCONT"));
	t.after(async () => {
		await shutdown();
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	let start: ((_event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
	const calls: string[][] = [];
	const warnings: string[] = [];
	let code = 0;
	let foreground = true;
	let foregroundWait: Promise<void> | undefined;
	let publicationWait: Promise<void> | undefined;
	let onPublication: (() => void) | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_shutdown") shutdown = handler as typeof shutdown;
			else {
				assert.equal(event, "session_start");
				start = handler as typeof start;
			}
		},
		async exec(command: string, args: string[], options: { timeout: number }) {
			assert.equal(options.timeout, 2000);
			if (command === "ps") {
				assert.deepEqual(args, ["-p", String(process.pid), "-o", "pgid=,tpgid="]);
				if (foregroundWait) await foregroundWait;
				return { code, stdout: `100 ${foreground ? 100 : 200}`, stderr: "", killed: false };
			}
			assert.equal(command, "tmux");
			calls.push(args);
			const wait = publicationWait;
			publicationWait = undefined;
			onPublication?.();
			onPublication = undefined;
			await wait;
			return { code, stdout: "", stderr: code ? "no server" : "", killed: false };
		},
	};
	registerResurrect(pi as unknown as ExtensionAPI);
	return {
		calls, warnings, registered: !!start,
		fail() { code = 1; },
		background() { foreground = false; },
		delayForegroundCheck() {
			let release!: () => void;
			foregroundWait = new Promise<void>((resolve) => { release = resolve; });
			return release;
		},
		delayPublication() {
			let release!: () => void;
			publicationWait = new Promise<void>((resolve) => { release = resolve; });
			const started = new Promise<void>((resolve) => { onPublication = resolve; });
			return { release, started };
		},
		shutdown() { return shutdown(); },
		listeners() { return process.listeners("SIGCONT").filter((handler) => !originalListeners.has(handler)); },
		async resume() { await this.listeners()[0]?.("SIGCONT"); },
		async start(file?: string, mode = "tui", reason = "startup") {
			await start?.({ reason }, {
				mode,
				sessionManager: { getSessionFile: () => file },
				ui: { notify: (message: string) => warnings.push(message) },
			} as unknown as ExtensionContext);
		},
	};
}

test("publishes exact session paths on startup, reload, new, resume and fork", async (t) => {
	const h = harness(t);
	for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
		const file = `/tmp/session's ${reason}.jsonl`;
		await h.start(file, "tui", reason);
		assert.deepEqual(h.calls.at(-1), [
			"set-option", "-p", "-t", "%12", "@pi_resurrect",
			JSON.stringify({ pid: process.pid, file }),
		]);
	}
	await h.start();
	assert.equal(JSON.parse(h.calls.at(-1)!.at(-1)!).file, null);
});

test("does not overwrite pane metadata from print/RPC processes", async (t) => {
	const h = harness(t);
	await h.start("/tmp/print.jsonl", "print");
	await h.start("/tmp/rpc.jsonl", "rpc");
	assert.deepEqual(h.calls, []);
});

test("does not register outside tmux", (t) => {
	assert.equal(harness(t, false).registered, false);
});

test("reports publishing failures", async (t) => {
	const h = harness(t);
	h.fail();
	await h.start("/tmp/session.jsonl");
	assert.match(h.warnings[0], /tmux-resurrect: Error: no server/);
});

test("reclaims identity on fg, skips bg, and removes listeners on shutdown", async (t) => {
	const h = harness(t);
	await h.start("/tmp/a.jsonl");
	await h.start("/tmp/current.jsonl", "tui", "resume");
	assert.equal(h.listeners().length, 1);
	await h.resume();
	assert.equal(h.calls.length, 3);
	assert.equal(JSON.parse(h.calls.at(-1)!.at(-1)!).file, "/tmp/current.jsonl");
	h.background();
	await h.resume();
	assert.equal(h.calls.length, 3);
	h.shutdown();
	assert.equal(h.listeners().length, 0);
	await h.resume();
	assert.equal(h.calls.length, 3);
});

test("in-flight resume checks cannot republish a replaced session", async (t) => {
	const h = harness(t);
	await h.start("/tmp/old.jsonl");
	const release = h.delayForegroundCheck();
	const pending = h.resume();
	h.shutdown();
	await h.start("/tmp/new.jsonl", "tui", "resume");
	release();
	await pending;
	assert.equal(h.calls.length, 2);
	assert.equal(JSON.parse(h.calls.at(-1)!.at(-1)!).file, "/tmp/new.jsonl");
});

test("session replacement waits for an already-started publication", async (t) => {
	const h = harness(t);
	await h.start("/tmp/old.jsonl");
	const gate = h.delayPublication();
	const pending = h.resume();
	await gate.started;
	const shutdown = h.shutdown();
	const start = h.start("/tmp/new.jsonl", "tui", "resume");
	await Promise.resolve();
	try {
		assert.equal(h.calls.length, 2);
	} finally {
		gate.release();
	}
	await Promise.all([pending, shutdown, start]);
	assert.equal(h.calls.length, 3);
	assert.equal(JSON.parse(h.calls.at(-1)!.at(-1)!).file, "/tmp/new.jsonl");
});

test("concurrent resume writes are serialized before session replacement", async (t) => {
	const h = harness(t);
	await h.start("/tmp/old.jsonl");
	const gate = h.delayPublication();
	const first = h.resume();
	await gate.started;
	const second = h.resume();
	await Promise.resolve();
	const shutdown = h.shutdown();
	const start = h.start("/tmp/new.jsonl", "tui", "resume");
	try {
		assert.equal(h.calls.length, 2);
	} finally {
		gate.release();
	}
	await Promise.all([first, second, shutdown, start]);
	assert.equal(h.calls.length, 4);
	assert.equal(JSON.parse(h.calls.at(-1)!.at(-1)!).file, "/tmp/new.jsonl");
});

test("resume publishing errors are caught instead of rejecting signal handlers", async (t) => {
	const h = harness(t);
	await h.start("/tmp/session.jsonl");
	h.fail();
	await h.resume();
	assert.match(h.warnings[0], /Could not check foreground process group/);
});
