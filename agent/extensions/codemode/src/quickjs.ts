/**
 * QuickJS (WASM) sandbox. Guest code has no process, require, fs, net, or timers
 * beyond what is installed here; the only escape is one host function that
 * takes (ref, args) and resolves JSON. Ported (trimmed) from pi-fabric
 * src/runtime/quickjs-runtime.ts — agents/mesh/memory/speculation removed.
 */
import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import ts from "typescript";
import { guestSetupSource } from "./guest-setup.ts";
import { transpileGuestCode } from "./type-checker.ts";

export type HostCall = (
	ref: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<unknown>;

export interface SandboxOptions {
	payloads?: Record<string, string>;
	timeoutMs: number;
	memoryLimitBytes: number;
	transpiledCode?: string;
	signal?: AbortSignal;
}

export type TerminationReason = "completed" | "timed_out" | "aborted" | "runtime_error";

export interface SandboxResult {
	value: unknown;
	logs: string[];
	terminationReason: TerminationReason;
	error?: string;
}

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let modulePromise: Promise<QuickJsModule> | undefined;
const quickJsModule = (): Promise<QuickJsModule> => {
	modulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
	return modulePromise;
};

// The release-sync WASM variant exhausts the host stack before QuickJS can throw
// its guest-catchable InternalError.
const MAX_STACK_SIZE_BYTES = 256 * 1024;
const GC_LIST_ASSERTION = "list_empty(&rt->gc_obj_list)";
const HOST_TASK_SETTLE_GRACE_MS = 250;

/** Static π.<identifier> reads; π[k] is not provable and is left to runtime. */
const referencedPayloadKeys = (code: string): string[] => {
	const source = ts.createSourceFile(
		"guest.ts",
		`async function __main() {\n${code}\n}`,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	);
	const keys: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "π" &&
			!keys.includes(node.name.text)
		) {
			keys.push(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return keys;
};

const formatValue = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

/**
 * Frames point at the emitted bundle. Type erasure keeps lines 1:1 and the
 * wrapper adds exactly one line, so N-1 is the line the model wrote.
 */
const guestErrorText = (value: unknown): string =>
	formatValue(value)
		.replace(
			/codemode-guest\.js:(\d+):(\d+)/g,
			(_match, lineNumber: string, column: string) =>
				`your code line ${Math.max(1, Number(lineNumber) - 1)}, column ${column}`,
		)
		.trim();

const jsonHandle = (context: any, jsonObject: any, jsonParse: any, value: unknown): any => {
	if (value === undefined) return context.undefined;
	if (value === null) return context.null;
	if (typeof value === "string") return context.newString(value);
	if (typeof value === "boolean") return value ? context.true : context.false;
	if (typeof value === "number") {
		return Number.isFinite(value) ? context.newNumber(value) : context.null;
	}
	let text: string;
	try {
		text = JSON.stringify(value) ?? "null";
	} catch {
		text = JSON.stringify(String(value));
	}
	const serialized = context.newString(text);
	try {
		return context.unwrapResult(context.callFunction(jsonParse, jsonObject, serialized));
	} finally {
		serialized.dispose();
	}
};

const disposeContext = (context: any): void => {
	try {
		context.dispose();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Known Emscripten teardown assertion; the result is already computed.
		if (message.includes(GC_LIST_ASSERTION) && message.includes("JS_FreeRuntime")) return;
		throw error;
	}
};

const settleWithin = async (tasks: Iterable<Promise<unknown>>, ms: number): Promise<boolean> => {
	const pending = [...tasks];
	if (pending.length === 0) return true;
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			Promise.allSettled(pending).then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), Math.max(0, ms));
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const execute = async (
	code: string,
	hostCall: HostCall,
	options: SandboxOptions,
): Promise<SandboxResult> => {
	if (options.signal?.aborted) {
		return { value: undefined, logs: [], terminationReason: "aborted", error: "Execution cancelled" };
	}
	const payloads = options.payloads ?? {};
	const missing = referencedPayloadKeys(code).filter((key) => !(key in payloads));
	if (missing.length > 0) {
		const provided = Object.keys(payloads);
		return {
			value: undefined,
			logs: [],
			terminationReason: "runtime_error",
			error:
				`Pre-execution check: ${missing.map((key) => `π.${key}`).join(", ")} referenced in code but missing from the payloads parameter` +
				(provided.length ? ` (provided: ${provided.join(", ")})` : " (none provided)") +
				`. Add payloads: { ${missing.map((key) => `${key}: '...'`).join(", ")} }.`,
		};
	}

	const module = await quickJsModule();
	const context = module.newContext();
	const runtime = context.runtime;
	const jsonObject = context.getProp(context.global, "JSON");
	const jsonParse = context.getProp(jsonObject, "parse");
	const deadlineAt = Date.now() + options.timeoutMs;
	let interruptedByDeadline = false;
	runtime.setMemoryLimit(options.memoryLimitBytes);
	runtime.setMaxStackSize(MAX_STACK_SIZE_BYTES);
	runtime.setInterruptHandler(() => {
		if (options.signal?.aborted === true) return true;
		if (Date.now() <= deadlineAt) return false;
		interruptedByDeadline = true;
		return true;
	});

	const logs: string[] = [];
	const maxLogChars = 100_000;
	let logChars = 0;
	let logsTruncated = false;
	const pendingHostPromises = new Set<any>();
	const hostTasks = new Set<Promise<void>>();
	let closing = false;
	let cancelled = false;
	let timedOut = false;
	let timeout: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | undefined;
	let activePromiseHandle: any;
	// Guest awaits race against this gate, so a timeout unblocks code parked on
	// a host call instead of waiting for the interrupt handler to see a tick.
	let executionGate: any;
	let pendingResolution: Promise<any> | undefined;
	const hostAbort = new AbortController();
	const abortHostCalls = (reason: string): void => {
		if (!hostAbort.signal.aborted) hostAbort.abort(new Error(reason));
	};
	const timeoutMessage = (): string => `Execution timed out after ${options.timeoutMs}ms`;
	const rejectGate = (message: string): void => {
		if (!executionGate || executionGate.alive === false) return;
		const handle = context.newError(message);
		executionGate.reject(handle);
		handle.dispose();
		runtime.executePendingJobs();
	};

	const terminalResult = (fallback: string): SandboxResult => {
		const deadlineExceeded = timedOut || interruptedByDeadline || Date.now() > deadlineAt;
		if (deadlineExceeded) timedOut = true;
		const aborted = cancelled || options.signal?.aborted === true;
		const error = aborted
			? "Execution cancelled"
			: deadlineExceeded
				? timeoutMessage()
				: fallback;
		abortHostCalls(error);
		return {
			value: undefined,
			logs,
			terminationReason: aborted ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
			error,
		};
	};

	try {
		const hostFunction = context.newFunction(
			"__codeModeHostCall",
			(refHandle: any, argsHandle: any) => {
				const ref = context.getString(refHandle);
				const dumped = context.dump(argsHandle);
				const args =
					typeof dumped === "object" && dumped !== null && !Array.isArray(dumped)
						? (dumped as Record<string, unknown>)
						: {};
				const promise = context.newPromise();
				pendingHostPromises.add(promise);
				void promise.settled.then(() => pendingHostPromises.delete(promise));
				const task = Promise.resolve()
					.then(() => hostCall(ref, args, hostAbort.signal))
					.then((value) => {
						if (closing || promise.alive === false) return;
						const handle = jsonHandle(context, jsonObject, jsonParse, value);
						promise.resolve(handle);
						handle.dispose();
					})
					.catch((error: unknown) => {
						if (closing || promise.alive === false) return;
						const handle = context.newError(
							error instanceof Error ? error.message : String(error),
						);
						promise.reject(handle);
						handle.dispose();
					})
					.finally(() => {
						if (!closing) runtime.executePendingJobs();
					});
				hostTasks.add(task);
				void task.finally(() => hostTasks.delete(task));
				return promise.handle;
			},
		);
		context.setProp(context.global, "__codeModeHostCall", hostFunction);
		hostFunction.dispose();

		const printFunction = context.newFunction("print", (...handles: any[]) => {
			if (logsTruncated) return;
			const line = handles.map((handle) => formatValue(context.dump(handle))).join(" ");
			const remaining = maxLogChars - logChars;
			if (line.length > remaining) {
				if (remaining > 0) logs.push(line.slice(0, remaining));
				logs.push("[log output truncated]");
				logsTruncated = true;
				return;
			}
			logs.push(line);
			logChars += line.length;
		});
		context.setProp(context.global, "print", printFunction);
		printFunction.dispose();

		const payloadHandle = jsonHandle(context, jsonObject, jsonParse, payloads);
		context.setProp(context.global, "π", payloadHandle);
		payloadHandle.dispose();

		const setup = context.evalCode(guestSetupSource(), "codemode-setup.js");
		if (setup.error) {
			const text = guestErrorText(context.dump(setup.error));
			setup.error.dispose();
			return terminalResult(text);
		}
		setup.value.dispose();

		executionGate = context.newPromise();
		context.setProp(context.global, "__codeModeGate", executionGate.handle);
		const guestJs = options.transpiledCode ?? transpileGuestCode(code);
		const evaluation = context.evalCode(
			`${guestJs}\nPromise.race([__codeModeMain(), globalThis.__codeModeGate])`,
			"codemode-guest.js",
		);
		runtime.executePendingJobs();
		if (evaluation.error) {
			const text = guestErrorText(context.dump(evaluation.error));
			evaluation.error.dispose();
			return terminalResult(text);
		}

		activePromiseHandle = evaluation.value;
		const cancellation = new Promise<never>((_resolve, reject) => {
			abortHandler = () => {
				cancelled = true;
				hostAbort.abort(options.signal?.reason);
				rejectGate("Execution cancelled");
				reject(new Error("Execution cancelled"));
			};
			if (options.signal?.aborted) abortHandler();
			else options.signal?.addEventListener("abort", abortHandler, { once: true });
		});
		void cancellation.catch(() => undefined);
		const deadline = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				if (closing || cancelled || timedOut) return;
				timedOut = true;
				const message = timeoutMessage();
				abortHostCalls(message);
				rejectGate(message);
				reject(new Error(message));
			}, Math.max(0, deadlineAt - Date.now()));
		});
		void deadline.catch(() => undefined);

		pendingResolution = context.resolvePromise(activePromiseHandle);
		runtime.executePendingJobs();
		const resolution = await Promise.race([pendingResolution, deadline, cancellation]);
		pendingResolution = undefined;
		activePromiseHandle.dispose();
		activePromiseHandle = undefined;
		if (resolution.error) {
			const text = guestErrorText(context.dump(resolution.error));
			resolution.error.dispose();
			return terminalResult(text);
		}
		const value = context.dump(resolution.value);
		resolution.value.dispose();
		return { value, logs, terminationReason: "completed" };
	} catch (error) {
		return terminalResult(error instanceof Error ? error.message : String(error));
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
		if (hostTasks.size > 0) {
			const settled = await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
			if (!settled) {
				abortHostCalls("Guest execution ended before its host calls settled");
				await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
			}
			runtime.executePendingJobs();
		}
		closing = true;
		if (timedOut || cancelled || pendingHostPromises.size > 0) {
			const message = cancelled
				? "Execution cancelled"
				: timedOut
					? timeoutMessage()
					: "Guest execution ended before its host calls settled";
			abortHostCalls(message);
			rejectGate(message);
			const handle = context.newError(message);
			for (const promise of pendingHostPromises) promise.reject(handle);
			handle.dispose();
			runtime.executePendingJobs();
			await new Promise((resolve) => setImmediate(resolve));
			const settled = await Promise.race<any>([
				pendingResolution ? pendingResolution.catch(() => undefined) : Promise.resolve(undefined),
				new Promise<undefined>((resolve) => {
					const timer = setTimeout(() => resolve(undefined), 1_000);
					timer.unref?.();
				}),
			]);
			settled?.error?.dispose();
			settled?.value?.dispose();
			for (const promise of pendingHostPromises) {
				if (promise.alive !== false) promise.dispose();
			}
		}
		if (activePromiseHandle?.alive !== false) activePromiseHandle?.dispose();
		if (executionGate?.alive !== false) executionGate?.dispose();
		runtime.executePendingJobs();
		jsonParse.dispose();
		jsonObject.dispose();
		disposeContext(context);
	}
};
