/**
 * Runnable check for the engine: type gate, host bridge, parallelism, payloads,
 * argument repair, sandbox isolation, timeout, and output budget.
 * Run: node --experimental-strip-types src/selftest.ts
 */
import assert from "node:assert/strict";
import { Type } from "typebox";
import { buildDeclarations } from "./declarations.ts";
import { createDispatcher } from "./dispatch.ts";
import { normalizePiArgs } from "./guest-setup.ts";
import { applyOutputBudget, DISPLAY_JSON_STRING_CHARS, formatDisplayValue, formatValue } from "./output.ts";
import { execute, type HostCall } from "./quickjs.ts";
import { typeCheckGuestCode } from "./type-checker.ts";

const declarations = buildDeclarations([
	{
		definition: {
			name: "echo_tool",
			label: "echo",
			description: "Echo a message",
			parameters: {
				type: "object",
				properties: { message: { type: "string" }, times: { type: "number" } },
				required: ["message"],
			},
			execute: async () => ({ content: "" }),
		},
		sourceInfo: { path: "test" },
	} as any,
]);

const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
const hostCall: HostCall = async (ref, args) => {
	calls.push({ ref, args });
	if (ref === "pi.read") return `contents of ${String(args.path)}`;
	if (ref === "pi.bash") return { ok: true, output: "done", details: null };
	if (ref === "pi.echo_tool") return { echoed: args.message };
	if (ref === "$list") return [{ ref: "pi.read", description: "read", inputSchema: {} }];
	if (ref === "$call") return hostCall(String(args.ref), (args.args ?? {}) as any, new AbortController().signal);
	if (ref === "sleep") return new Promise((resolve) => setTimeout(resolve, 5_000));
	throw new Error(`unexpected ref ${ref}`);
};

const run = async (code: string, payloads?: Record<string, string>, timeoutMs = 10_000) => {
	const checked = typeCheckGuestCode(code, declarations);
	if (checked.errors.length > 0) return { typeErrors: checked.errors };
	const result = await execute(code, hostCall, {
		payloads,
		env: { TMPDIR: "/tmp/pi-codemode", CODEMODE_TEST_VALUE: "available" },
		timeoutMs,
		memoryLimitBytes: 64 * 1024 * 1024,
		transpiledCode: checked.javascript,
	});
	return { result };
};

const tests: Array<[string, () => Promise<void> | void]> = [
	[
		"type gate rejects an unknown global before executing",
		async () => {
			const before = calls.length;
			const outcome = await run(`return await nope.read({ path: "a" });`);
			assert.ok(outcome.typeErrors && outcome.typeErrors.length > 0);
			assert.equal(calls.length, before, "no host call may happen after a failed check");
		},
	],
	[
		"host rejects arguments that violate a tool's schema",
		async () => {
			let executed = false;
			const tool = {
				definition: {
					name: "echo_tool",
					description: "Echo a message",
					parameters: Type.Object({ message: Type.String() }),
					execute: async () => {
						executed = true;
						return { content: "echoed" };
					},
				},
				sourceInfo: { path: "test" },
			} as any;
			const dispatcher = createDispatcher({
				cwd: process.cwd(),
				captured: { list: () => [tool], get: () => tool },
				context: {} as any,
				toolCallId: "t1",
			});
			const signal = new AbortController().signal;
			await assert.rejects(
				() => dispatcher.hostCall("pi.echo_tool", { times: 2 }, signal),
				/Invalid arguments/,
			);
			assert.equal(executed, false, "invalid args must not reach the tool");
			const ok = await dispatcher.hostCall("pi.echo_tool", { message: "hi" }, signal);
			assert.deepEqual(ok, { ok: true, output: "echoed", details: null });
			assert.ok(dispatcher.refs().some((entry) => entry.ref === "pi.echo_tool"));
		},
	],
	[
		"unknown refs list what is callable",
		async () => {
			const dispatcher = createDispatcher({
				cwd: process.cwd(),
				captured: { list: () => [], get: () => undefined },
				context: {} as any,
				toolCallId: "t2",
			});
			await assert.rejects(
				() => dispatcher.hostCall("pi.nope", {}, new AbortController().signal),
				/Unknown tool ref .*pi\.read/s,
			);
		},
	],
	[
		"host bridge round-trips a core tool call",
		async () => {
			const outcome = await run(`return await pi.read({ path: "package.json" });`);
			assert.equal(outcome.result?.terminationReason, "completed");
			assert.equal(outcome.result?.value, "contents of package.json");
		},
	],
	[
		"captured tools share the pi namespace",
		async () => {
			const outcome = await run(`return await pi.echo_tool({ message: "hello" });`);
			assert.deepEqual(outcome.result?.value, { echoed: "hello" });
		},
	],
	[
		"tool discovery shares the pi namespace",
		async () => {
			const outcome = await run(`const refs = await pi.list(); return refs[0].ref;`);
			assert.equal(outcome.result?.value, "pi.read");
		},
	],
	[
		"independent calls run in parallel",
		async () => {
			const outcome = await run(
				`const [a, b] = await Promise.all([pi.read({ path: "a" }), pi.read({ path: "b" })]);
				 return [a, b].length;`,
			);
			assert.equal(outcome.result?.value, 2);
		},
	],
	[
		"guest argument repair reaches the host canonicalized",
		async () => {
			calls.length = 0;
			await run(`return await pi.read("src/index.ts", { limit: "10" });`);
			const call = calls.find((entry) => entry.ref === "pi.read");
			assert.deepEqual(call?.args, { path: "src/index.ts", limit: 10 });
		},
	],
	[
		"host-side normalizer matches the guest's (single closed factory)",
		() => {
			assert.deepEqual(normalizePiArgs("read", { file_path: "x", limit: "3" }), {
				path: "x",
				limit: 3,
			});
			assert.deepEqual(normalizePiArgs("edit", { path: "x", oldText: "a", newText: "b" }), {
				path: "x",
				edits: [{ oldText: "a", newText: "b" }],
			});
		},
	],
	[
		"payloads arrive as π.<key>",
		async () => {
			const outcome = await run(`return π.contract.length;`, { contract: "hello" });
			assert.equal(outcome.result?.value, 5);
		},
	],
	[
		"a missing payload key is caught before execution",
		async () => {
			const outcome = await run(`return π.absent;`);
			assert.equal(outcome.result?.terminationReason, "runtime_error");
			assert.match(String(outcome.result?.error), /Pre-execution check/);
		},
	],
	[
		"host environment is readable through process.env",
		async () => {
			const outcome = await run(
				`const tmp = process.env.TMPDIR!; return [tmp, process.env["CODEMODE_TEST_VALUE"]];`,
			);
			assert.deepEqual(outcome.result?.value, ["/tmp/pi-codemode", "available"]);
		},
	],
	[
		"sandbox denies ambient capabilities",
		async () => {
			for (const global of ["require", "fetch", "globalThis.Deno"]) {
				const outcome = await run(`return typeof ${global};`);
				assert.equal(outcome.result?.value, "undefined", `${global} must not exist`);
			}
		},
	],
	[
		"envelope misuse names the fix",
		async () => {
			const outcome = await run(`const r = await pi.bash({ command: "ls" }); return r.trim();`);
			assert.equal(outcome.result?.terminationReason, "runtime_error");
			assert.match(String(outcome.result?.error), /\.output/);
		},
	],
	[
		"legacy tool namespaces are absent",
		async () => {
			const outcome = await run(
				`return [typeof (globalThis as any).extensions, typeof (globalThis as any).tools];`,
			);
			assert.deepEqual(outcome.result?.value, ["undefined", "undefined"]);
		},
	],
	[
		"a program parked on a host call still times out",
		async () => {
			const started = Date.now();
			const result = await execute(`return await pi.call({ ref: "sleep" });`, hostCall, {
				timeoutMs: 300,
				memoryLimitBytes: 64 * 1024 * 1024,
			});
			assert.equal(result.terminationReason, "timed_out");
			assert.ok(Date.now() - started < 3_000, "timeout must not wait for the host call");
		},
	],
	[
		"a runtime-computed ref gets the same argument repair as the proxy",
		async () => {
			const dispatcher = createDispatcher({
				cwd: process.cwd(),
				captured: { list: () => [], get: () => undefined },
				context: {} as any,
				toolCallId: "t3",
			});
			// file_path is an alias; unrepaired it fails the schema gate.
			const result = await dispatcher.hostCall(
				"$call",
				{ ref: "pi.read", args: { file_path: "package.json" } },
				new AbortController().signal,
			);
			assert.match(String(result), /pi-codemode/);
		},
	],
	[
		"aliases inside edits[] are repaired",
		() => {
			assert.deepEqual(
				normalizePiArgs("edit", {
					path: "x",
					edits: [{ old_string: "a", new_string: "b" }],
				}),
				{ path: "x", edits: [{ oldText: "a", newText: "b" }] },
			);
		},
	],
	[
		"runtime errors carry the user's line number",
		async () => {
			const outcome = await run(`const value = 1;\nreturn (value as any).nope();`);
			assert.match(String(outcome.result?.error), /your code line 2/);
		},
	],
	[
		"print output is captured",
		async () => {
			const outcome = await run(`print("hello", 1); return 0;`);
			assert.deepEqual(outcome.result?.logs, ["hello 1"]);
		},
	],
	[
		"display JSON recursively caps string values without changing model output",
		() => {
			const long = "x".repeat(DISPLAY_JSON_STRING_CHARS + 20);
			const value = { top: long, nested: [{ value: long }] };
			const display = formatDisplayValue(value);
			assert.equal(display.match(new RegExp(`${long.length} chars`, "g"))?.length, 2);
			assert.ok(display.length < formatValue(value).length);
			assert.equal(formatDisplayValue(JSON.stringify(value)), display);
			assert.equal(JSON.parse(formatValue(value)).nested[0].value, long);
		},
	],
	[
		"output budget keeps both ends and spills the rest",
		() => {
			const text = `HEAD${"x".repeat(5_000)}TAIL`;
			const bounded = applyOutputBudget(text, 500);
			assert.ok(bounded.text.startsWith("HEAD"));
			assert.ok(bounded.text.endsWith("TAIL"));
			assert.ok(bounded.text.length <= 500);
			assert.ok(bounded.artifact, "full output must be retrievable");
		},
	],
];

let failures = 0;
for (const [name, test] of tests) {
	try {
		await test();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
	}
}
console.log(failures === 0 ? `\n${tests.length} passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
