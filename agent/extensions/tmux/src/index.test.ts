import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { mock, test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

interface TestPane {
	name: string;
	content: string;
	outputPath?: string;
	shellCommand?: string;
}
const panes = new Map<string, TestPane>();
const closed: string[] = [];
let nextPaneId = 1;
mock.module("@pi-ext/tmux-layout", {
	namedExports: {
		createWorkerPane: ({ title }: { title: string }) => {
			const id = `%${nextPaneId++}`;
			panes.set(id, { name: title, content: "initial output\n" });
			return id;
		},
		isPaneAlive: (id: string) => panes.has(id),
		closeWorkerPane: (id: string) => {
			const pane = panes.get(id)!;
			assert.equal(readFileSync(pane.outputPath!, "utf8"), pane.content.replace(/\n+$/, "\n"));
			closed.push(id);
			panes.delete(id);
		},
	},
});
const extension = (await import("./index.ts")).default;
const exec = promisify(execFile);
const success = { code: 0, stdout: "", stderr: "", killed: false };

async function harness(t: TestContext) {
	const dir = await mkdtemp("/tmp/pi-tmux-test-");
	const sessionDir = join(dir, "session ' $ folder");
	await mkdir(sessionDir);
	t.after(() => rm(dir, { recursive: true, force: true }));
	const oldTmux = process.env.TMUX;
	const oldHerdr = process.env.HERDR_ENV;
	process.env.TMUX = "test";
	delete process.env.HERDR_ENV;
	t.after(() => {
		if (oldTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = oldTmux;
		if (oldHerdr !== undefined) process.env.HERDR_ENV = oldHerdr;
		panes.clear();
	});
	let tool!: ToolDefinition;
	let start!: () => Promise<void>;
	const waiting = new Map<string, (result: typeof success) => void>();
	const messages: Array<{ content: string; details: Record<string, any> }> = [];
	let onMessage: (() => void) | undefined;
	let captureFails = false;
	const pi = {
		on(name: string, handler: () => Promise<void>) { if (name === "session_start") start = handler; },
		registerTool(value: ToolDefinition) { tool = value; },
		registerMessageRenderer() {},
		sendMessage(message: (typeof messages)[number], options: { triggerTurn: boolean; deliverAs: string }) {
			assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
			messages.push(message);
			onMessage?.();
		},
		async exec(_command: string, args: string[]) {
			switch (args[0]) {
				case "display-message": return { ...success, stdout: "%0\t@0\t$0\n" };
				case "list-panes": return {
					...success,
					stdout: [...panes].map(([id, pane]) => `${id}\t${pane.name}\tbash\t123\t0`).join("\n"),
				};
				case "capture-pane": {
					assert.ok(args.includes("-J"));
					assert.equal(args.at(-1), "-");
					if (captureFails) return { ...success, code: 1, stderr: "capture failed" };
					return { ...success, stdout: panes.get(args[2])!.content };
				}
				case "send-keys": {
					if (args.includes("-l")) panes.get(args[args.indexOf("-t") + 1])!.shellCommand = args.at(-1);
					return success;
				}
				case "wait-for": {
					if (args[1] === "-S") { waiting.get(args[2])?.(success); return success; }
					return new Promise<typeof success>((resolve) => waiting.set(args[1], resolve));
				}
				default: throw new Error(`Unexpected tmux command: ${args}`);
			}
		},
	};
	extension(pi as unknown as ExtensionAPI);
	await start();
	const ctx = { sessionManager: { getSessionDir: () => sessionDir } } as unknown as ExtensionToolContext;
	async function call(params: Record<string, unknown>) {
		return tool.execute("test", params, new AbortController().signal, undefined, ctx);
	}
	async function run(command = "echo hello", restart = false) {
		const result = await call({ action: "run", pane: "job", command, restart });
		const details = result.details as { paneId: string; fullOutputPath: string };
		panes.get(details.paneId)!.outputPath = details.fullOutputPath;
		assert.ok(details.fullOutputPath.startsWith(sessionDir + "/"));
		assert.match(result.content[0].type === "text" ? result.content[0].text : "", /do not poll/);
		return details;
	}
	async function complete(paneId: string, exitCode: number) {
		const pane = panes.get(paneId)!;
		const pending = new Promise<void>((resolve) => { onMessage = resolve; });
		await writeFile(join(pane.outputPath!, "..", "exit-code"), String(exitCode));
		const channel = (globalThis as any)[Symbol.for("pi-tmux/auto-exit-watchers")].get(paneId);
		assert.ok(channel);
		waiting.get(channel)!(success);
		await pending;
	}
	return { run, call, complete, messages, tool, sessionDir, failCapture(fail = true) { captureFails = fail; } };
}

test("every run closes after saving full snapshot and delivers only its path", { timeout: 5000 }, async (t) => {
	const h = await harness(t);
	assert.equal(Object.hasOwn((h.tool.parameters as any).properties, "autoExit"), false);
	const run = await h.run();
	const output = "history\n".repeat(12000) + "final result\n";
	panes.get(run.paneId)!.content = output;
	await h.complete(run.paneId, 0);
	assert.equal(await readFile(run.fullOutputPath, "utf8"), output);
	assert.ok(closed.includes(run.paneId));
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].details.exitCode, 0);
	assert.equal(h.messages[0].details.fullOutputPath, run.fullOutputPath);
	assert.match(h.messages[0].content, /Use the read tool/);
	assert.ok(!h.messages[0].content.includes("final result"));
	assert.deepEqual(await readdir(join(run.fullOutputPath, "..")), ["output.txt"]);
	assert.equal((globalThis as any)[Symbol.for("pi-tmux/auto-exit-watchers")].size, 0);
});

test("stop and restart preserve snapshots, returning and delivering each path once", { timeout: 5000 }, async (t) => {
	const h = await harness(t);
	const first = await h.run("sleep 60");
	await assert.rejects(h.run(), /already exists/);
	const second = await h.run("sleep 30", true);
	assert.notEqual(second.fullOutputPath, first.fullOutputPath);
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].details.fullOutputPath, first.fullOutputPath);
	const stopped = await h.call({ action: "stop", pane: "job" });
	assert.equal((stopped.details as any).fullOutputPath, second.fullOutputPath);
	assert.equal(h.messages.length, 2);
	assert.equal(h.messages[1].details.exitCode, -1);
	assert.equal(await readFile(second.fullOutputPath, "utf8"), "initial output\n");
});

test("stop racing natural completion finalizes only once", { timeout: 5000 }, async (t) => {
	const h = await harness(t);
	const run = await h.run();
	await Promise.all([h.complete(run.paneId, 0), h.call({ action: "stop", pane: "job" })]);
	assert.equal(h.messages.length, 1);
	assert.equal(closed.filter((id) => id === run.paneId).length, 1);
});

test("capture failure leaves pane intact and reports error", { timeout: 5000 }, async (t) => {
	const h = await harness(t);
	const run = await h.run();
	h.failCapture();
	await h.complete(run.paneId, 0);
	assert.ok(panes.has(run.paneId));
	assert.match(h.messages[0].content, /capture failed/);
	await assert.rejects(readFile(run.fullOutputPath), { code: "ENOENT" });
});

test("failed stop can retry capture without losing its watcher or snapshot path", { timeout: 5000 }, async (t) => {
	const h = await harness(t);
	const run = await h.run("sleep 60");
	h.failCapture();
	await assert.rejects(h.call({ action: "stop", pane: "job" }), /capture failed/);
	assert.ok(panes.has(run.paneId));
	assert.equal((globalThis as any)[Symbol.for("pi-tmux/auto-exit-watchers")].size, 1);
	assert.equal(h.messages.length, 0);
	h.failCapture(false);
	const stopped = await h.call({ action: "stop", pane: "job" });
	assert.equal((stopped.details as any).fullOutputPath, run.fullOutputPath);
	assert.equal(h.messages.length, 1);
	assert.equal((globalThis as any)[Symbol.for("pi-tmux/auto-exit-watchers")].size, 0);
});

test("failed snapshot write can retry restart and preserve the original output path", { timeout: 5000 }, async (t) => {
	const h = await harness(t);
	const first = await h.run("sleep 60");
	await mkdir(first.fullOutputPath);
	await assert.rejects(h.run("echo replacement", true), { code: "EISDIR" });
	assert.ok(panes.has(first.paneId));
	assert.equal(h.messages.length, 0);
	assert.equal((globalThis as any)[Symbol.for("pi-tmux/auto-exit-watchers")].size, 1);
	await rm(first.fullOutputPath, { recursive: true });
	const second = await h.run("echo replacement", true);
	assert.equal(h.messages[0].details.fullOutputPath, first.fullOutputPath);
	assert.equal(await readFile(first.fullOutputPath, "utf8"), "initial output\n");
	await h.complete(second.paneId, 0);
	assert.equal(h.messages.length, 2);
});

test("runner reports failures and waits for background commands, including explicit exit", { timeout: 10000 }, async (t) => {
	const h = await harness(t);
	for (const [command, expectedCode] of [
		["printf 'ok\\n'", 0],
		["false # trailing comment", 1],
		["exit 7", 7],
		["exec bash -c 'exit 8'", 8],
		["if (", 2],
		["(sleep 0.05; printf late) & exit 9", 9],
	] as const) {
		const run = await h.run(command);
		let stdout = "";
		try {
			({ stdout } = await exec("bash", ["-c", `tmux() { printf __completed__; }; export -f tmux\n${panes.get(run.paneId)!.shellCommand}`]));
		} catch (error) {
			const failed = error as { code: number; stdout: string };
			assert.equal(failed.code, expectedCode);
			stdout = failed.stdout;
		}
		assert.ok(stdout.endsWith("__completed__"), command);
		if (command.includes("printf late")) assert.equal(stdout, "late__completed__");
		assert.equal(Number(await readFile(join(run.fullOutputPath, "..", "exit-code"), "utf8")), expectedCode);
		panes.get(run.paneId)!.content = stdout;
		await h.complete(run.paneId, expectedCode);
	}
});

test("C-c still signals completion with exit 130", { timeout: 5000 }, async (t) => {
	const h = await harness(t);
	const run = await h.run("bash -c 'printf ready; exec sleep 60'");
	const script = await readFile(join(run.fullOutputPath, "..", "command.sh"), "utf8");
	const child = spawn("bash", ["-c", `tmux() { :; }\n${script}`], { detached: true });
	t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
	const done = new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	child.stdout.once("data", () => process.kill(-child.pid!, "SIGINT"));
	assert.equal(await done, 130);
	assert.equal(Number(await readFile(join(run.fullOutputPath, "..", "exit-code"), "utf8")), 130);
	await h.complete(run.paneId, 130);
});
