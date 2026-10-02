import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import upHistory from "./index.ts";
import { loadRecentPrompts, parsePrompt } from "./history.ts";

type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
const user = (content: unknown, timestamp?: unknown) => ({ type: "message", message: { role: "user", content, timestamp } });

assert.deepEqual(parsePrompt(user("  hello  ", 0), 99), { text: "hello", timestamp: 0 });
assert.deepEqual(parsePrompt(user([
	null, 1, "wrong", [], { text: "missing type" }, { type: "image", text: "ignore" },
	{ type: "text", text: 2 }, { type: "text", text: "first" }, { type: "text", text: "" }, { type: "text", text: "second" },
]), 99), { text: "first\nsecond", timestamp: 99 });
for (const value of [null, 1, [], {}, { type: "message" }, { type: "message", message: null },
	{ type: "message", message: { role: "assistant", content: "ignore" } }, user("  "), user({}), user([])]) {
	assert.equal(parsePrompt(value, 99), undefined);
}
for (const timestamp of [undefined, null, "invalid", Infinity, -Infinity, NaN]) {
	assert.equal(parsePrompt({ ...user("fallback", timestamp), timestamp: "1970-01-01T00:00:02.000Z" }, 99)?.timestamp, 2000);
	assert.equal(parsePrompt(user("fallback", timestamp), 99)?.timestamp, 99);
}
assert.equal(parsePrompt(user("fallback", NaN), NaN)?.timestamp, 0);

const dir = await mkdtemp(join(tmpdir(), "pi-up-history-selftest-"));
const cwd = join(dir, "project");
const header = (path = cwd) => JSON.stringify({ type: "session", version: 3, cwd: path });
const save = async (name: string, entries: unknown[], modified: number, path = cwd) => {
	const file = join(dir, name);
	await writeFile(file, [header(path), ...entries.map((entry) => JSON.stringify(entry))].join("\n"));
	await utimes(file, modified / 1000, modified / 1000);
};
try {
	assert.deepEqual(await loadRecentPrompts(join(dir, "missing"), cwd), []);
	await save("old-mtime.jsonl", [user("latest", 1000), user("repeat", 500)], 1);
	await save("new-mtime.jsonl", [user("older", 10), user("repeat", 20)], 900);
	await save("other-cwd.jsonl", [user("foreign", 9999)], 9999, join(dir, "foreign"));
	await writeFile(join(dir, "bad-header.jsonl"), "null\n" + JSON.stringify(user("ignore", 9999)));
	await writeFile(join(dir, "missing-cwd.jsonl"), '{"type":"session"}\n' + JSON.stringify(user("ignore", 9999)));
	await save("empty-cwd.jsonl", [user("ignore", 9999)], 9999, "");
	assert.deepEqual(await loadRecentPrompts(dir, process.cwd()), []);
	await writeFile(join(dir, "not-jsonl.txt"), [header(), JSON.stringify(user("ignore", 9999))].join("\n"));
	await mkdir(join(dir, "directory.jsonl"));
	await writeFile(join(dir, "mixed.jsonl"), [
		"\ufeff" + header(), "not-json", "null", "1", "[]", '{"type":"message"}',
		JSON.stringify(user("valid", 300)), "{partial",
	].join("\r\n"));
	assert.deepEqual(await loadRecentPrompts(dir, cwd), ["latest", "repeat", "valid", "older"]);

	await save("a-tie.jsonl", [user("tie-a", 2000)], 2000);
	await save("z-tie.jsonl", [user("tie-z-first", 2000), user("tie-z-last", 2000)], 2000);
	assert.deepEqual((await loadRecentPrompts(dir, cwd)).slice(0, 3), ["tie-z-last", "tie-z-first", "tie-a"]);
	await save("fallback.jsonl", [user("file-time", null), {
		...user("entry-time", null), timestamp: "1970-01-01T00:00:02.500Z",
	}], 2400);
	assert.deepEqual((await loadRecentPrompts(dir, cwd)).slice(0, 2), ["entry-time", "file-time"]);
	await save("many.jsonl", Array.from({ length: 40 }, (_, i) => user(`prompt ${i}`, 3000 + i)), 0);
	await save("duplicate.jsonl", [user("prompt 39", 9999), user("old duplicate", 1)], 9999);
	const loaded = await loadRecentPrompts(dir, cwd);
	assert.equal(loaded.length, 30);
	assert.deepEqual(loaded, Array.from({ length: 30 }, (_, i) => `prompt ${39 - i}`));
	assert.deepEqual(await loadRecentPrompts(dir, join(dir, "no-sessions")), []);
} finally {
	await rm(dir, { recursive: true, force: true });
}

function deferred() {
	let resolve!: (value: string[]) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<string[]>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const tui = { requestRender() {} } as Parameters<Factory>[0];
const theme = { borderColor: (s: string) => s, selectList: {} } as Parameters<Factory>[1];
const kb = { matches: () => false } as unknown as Parameters<Factory>[2];
class ExistingEditor extends CustomEditor {
	marker = "custom";
}
function harness(custom: Factory | null = (t, theme, keys) => new ExistingEditor(t, theme, keys)) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = { on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	} } as unknown as ExtensionAPI;
	let factory = custom ?? undefined;
	let editor = new CustomEditor(tui, theme, kb);
	editor.setText("draft survives");
	let installations = 0;
	const ctx = {
		mode: "tui", hasUI: true, cwd: "/project",
		sessionManager: { getSessionDir: () => "/custom/shared/sessions" },
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent(next: Factory) {
				installations++;
				factory = next;
				const draft = editor.getText();
				editor = next(tui, theme, kb) as CustomEditor;
				editor.setText(draft);
			},
		},
	} as unknown as ExtensionContext;
	const emit = (name: string) => handlers.get(name)?.({ type: name }, ctx);
	return { pi, ctx, emit, editor: () => editor, factory: () => factory!, installations: () => installations };
}

// Exercise real native history, preserving the existing custom editor and draft.
const h = harness();
const pending = deferred();
upHistory(h.pi, (sessionDir, cwd) => {
	assert.equal(sessionDir, "/custom/shared/sessions");
	assert.equal(cwd, "/project");
	return pending.promise;
});
h.emit("session_start");
assert.ok(h.editor() instanceof ExistingEditor);
assert.equal(h.editor().getText(), "draft survives");
pending.resolve(["newest", "middle", "oldest"]);
await setImmediate();
assert.equal(h.editor().getText(), "draft survives");
h.editor().setText("");
for (const expected of ["newest", "middle", "oldest"]) {
	h.editor().handleInput("\x1b[A");
	assert.equal(h.editor().getText(), expected);
}
const fresh = h.factory()(tui, theme, kb);
fresh.handleInput("\x1b[A");
assert.equal(fresh.getText(), "newest");

// The default editor also gains history without changing draft text.
const native = harness(null);
upHistory(native.pi, async () => ["native history"]);
native.emit("session_start");
await setImmediate();
assert.equal(native.editor().getText(), "draft survives");
native.editor().setText("");
native.editor().handleInput("\x1b[A");
assert.equal(native.editor().getText(), "native history");

// Unsupported history is a no-op; reused custom editor instances seed once.
let calls = 0;
const shared = new ExistingEditor(tui, theme, kb);
shared.addToHistory = () => { calls++; };
const reused = harness(() => shared);
upHistory(reused.pi, async () => ["two", "one"]);
reused.emit("session_start");
await setImmediate();
reused.factory()(tui, theme, kb);
assert.equal(calls, 2);
const unsupported = harness(() => ({ render: () => [], invalidate() {}, getText: () => "", setText() {}, handleInput() {} }));
upHistory(unsupported.pi, async () => ["ignored"]);
unsupported.emit("session_start");
await setImmediate();

for (const mode of ["rpc", "json", "print"] as const) {
	const headless = harness();
	headless.ctx.mode = mode;
	upHistory(headless.pi, async () => { assert.fail("headless must not load history"); });
	headless.emit("session_start");
	assert.equal(headless.installations(), 0);
}
const noUI = harness();
noUI.ctx.hasUI = false;
upHistory(noUI.pi, async () => { assert.fail("no UI must not load history"); });
noUI.emit("session_start");
assert.equal(noUI.installations(), 0);
for (const boundary of ["session_shutdown", "session_start", "replacement", "headless-start"] as const) {
	const stale = harness();
	const oldLoad = deferred();
	upHistory(stale.pi, () => oldLoad.promise);
	stale.emit("session_start");
	const oldEditor = stale.editor();
	if (boundary === "replacement") stale.ctx.ui.setEditorComponent((t, theme, keys) => new ExistingEditor(t, theme, keys));
	else {
		if (boundary === "headless-start") stale.ctx.mode = "print";
		stale.emit(boundary === "headless-start" ? "session_start" : boundary);
	}
	if (boundary === "session_start") stale.emit("session_shutdown");
	oldLoad.resolve(["stale"]);
	await setImmediate();
	for (const editor of new Set([oldEditor, stale.editor()])) {
		editor.setText("");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "");
	}
}
const switched = harness();
const oldLoad = deferred();
let starts = 0;
upHistory(switched.pi, () => ++starts === 1 ? oldLoad.promise : Promise.resolve(["fresh session"]));
switched.emit("session_start");
switched.emit("session_start");
oldLoad.resolve(["old session"]);
await setImmediate();
switched.editor().setText("");
switched.editor().handleInput("\x1b[A");
assert.equal(switched.editor().getText(), "fresh session");
switched.editor().handleInput("\x1b[A");
assert.equal(switched.editor().getText(), "fresh session");
const failure = harness();
upHistory(failure.pi, async () => { throw new Error("unreadable"); });
failure.emit("session_start");
await setImmediate();
assert.equal(failure.editor().getText(), "draft survives");

console.log("up-history selftest passed: parsing, cwd isolation, global order/dedupe/limit, native/custom editors, lifecycle");
