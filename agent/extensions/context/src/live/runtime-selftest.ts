import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, latestCheckpoint, projectCheckpoint } from "./projection.ts";
import { registerLiveContext } from "./index.ts";
import { LIVE_CONTEXT_SKILL_PATH } from "./document.ts";

const root = mkdtempSync(join(tmpdir(), "pi-live-runtime-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR);
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 2048 } }));
const handlers: Record<string, Array<(event: any, ctx: ExtensionContext) => any>> = {};
const notices: string[] = [];
function save(manager: SessionManager, drafts: SessionBoundaryDraft[]) {
  for (const draft of drafts) {
    switch (draft.type) {
      case "custom": manager.appendCustomEntry(draft.customType, draft.data); break;
      case "custom_message": manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details); break;
      case "context_edit": manager.appendContextEdit(draft.targetId, draft.replacement); break;
      case "compaction": manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 0, draft.details, true, draft.usage); break;
    }
  }
}
const manager = SessionManager.create(root, join(root, "sessions"));
manager.appendMessage({ role: "system", content: "SECRET_SYSTEM_PROMPT", timestamp: 0 });
manager.appendMessage({ role: "user", content: "OLDER_REQUEST", timestamp: 0 });
manager.appendMessage({ role: "user", content: "LATEST_REQUEST", timestamp: 0 });
const ctx = {
  cwd: root, hasUI: true, mode: "print", model: { id: "test", provider: "test", contextWindow: 200_000 },
  sessionManager: manager, isProjectTrusted: () => false, isIdle: () => true,
  getSystemPrompt: () => "SECRET_SYSTEM_PROMPT", getContextUsage: () => undefined,
  modelRegistry: { find: () => ctx.model }, ui: { notify: (text: string) => notices.push(text) },
} as unknown as ExtensionContext;
const pi = {
  on: (name: string, callback: (event: any, ctx: ExtensionContext) => any) => (handlers[name] ??= []).push(callback),
  appendEntry: (kind: string, data: unknown) => manager.appendCustomEntry(kind, data),
} as unknown as ExtensionAPI;
const live = registerLiveContext(pi);
function emit(name: string, event: unknown = {}) {
  return handlers[name]?.map((handler) => handler(event, ctx)).find((result) => result !== undefined);
}
function request() {
  return emit("context", { messages: manager.buildSessionProjection().messages })?.messages ?? manager.buildSessionProjection().messages;
}
function commit(outcome = "completed") {
  const projection = manager.buildSessionProjection();
  const result = emit("turn_end", { entries: [], outcome, message: { role: "assistant", provider: "test", model: "test" },
    context: { contextEntries: projection.entries, contextMessages: projection.messages } });
  const drafts: SessionBoundaryDraft[] = result?.entries ?? [];
  save(manager, drafts);
  return drafts;
}
try {
  emit("session_start");
  assert.equal(live.status(ctx).enabled, false);
  live.setEnabled(true, ctx);
  const file = live.status(ctx).path!;
  assert.ok(live.instructions(ctx)?.includes(JSON.stringify(LIVE_CONTEXT_SKILL_PATH)), "System prompt points to the internal skill");
  assert.ok(!live.instructions(ctx)?.includes("Do not read or print"), "Interaction instructions live only in the skill");
  const first = request();
  assert.equal(first.some((message: { content: unknown }) => JSON.stringify(message.content).includes("LATEST_REQUEST")), true);
  let text = readFileSync(file, "utf8");
  assert.ok(text.includes("LATEST_REQUEST"), "newest user turn is mirrored");
  assert.ok(!text.includes("SECRET_SYSTEM_PROMPT"), "system prompt is not mirrored");
  assert.ok(text.includes("<<<CTX:"), "CTX delimiter is used");
  text = text.replace("LATEST_REQUEST", "LATEST_REVISED").replace("OLDER_REQUEST", "OLDER_REVISED");
  writeFileSync(file, text);
  const drafts = commit();
  assert.equal(drafts[0]?.type, "custom");
  assert.equal(drafts[0]?.type === "custom" && drafts[0].customType, CHECKPOINT_TYPE);
  assert.ok(drafts.some((entry) => entry.type === "custom_message"), "receipt persisted");
  assert.match(JSON.stringify(request()), /LATEST_REVISED/);
  assert.doesNotMatch(JSON.stringify(request()), /LATEST_REQUEST/);
  assert.equal(live.status(ctx).edits > 0, true);
  assert.match(readFileSync(live.revisions(ctx), "utf8"), /LATEST_REVISED/);
  const resumed = SessionManager.open(manager.getSessionFile()!);
  const raw = resumed.buildSessionProjection();
  assert.match(JSON.stringify(projectCheckpoint(raw, latestCheckpoint(resumed.getBranch(), raw)).messages), /LATEST_REVISED/);
  assert.match(JSON.stringify(resumed.buildSessionProjection().messages), /LATEST_REQUEST/, "raw transcript archived");

  live.setEnabled(false, ctx);
  assert.match(JSON.stringify(request()), /LATEST_REQUEST/, "off bypasses checkpoint without deleting it");
  live.setEnabled(true, ctx);
  assert.match(JSON.stringify(request()), /LATEST_REVISED/, "on restores branch-local checkpoint");
  const baseline = readFileSync(file, "utf8");
  writeFileSync(file, baseline.replace("LATEST_REVISED", "DRAFT_NOT_APPLIED"));
  assert.equal(commit("aborted").some((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE), false);
  assert.match(JSON.stringify(request()), /LATEST_REVISED/);
  assert.ok(existsSync(`${manager.getSessionFile()}.context/rejected.md`));

  request();
  writeFileSync(file, "One compact note replacing all mirrored history.");
  const rewrite = commit();
  assert.ok(rewrite.some((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE));
  assert.match(JSON.stringify(request()), /One compact note replacing all mirrored history/);
  assert.doesNotMatch(JSON.stringify(request()), /LATEST_REVISED/);
  assert.match(readFileSync(live.revisions(ctx), "utf8"), /Revision 2/);
  assert.deepEqual(emit("session_before_compact", { reason: "threshold" }), { cancel: true }, "raw threshold cannot discard a fitting checkpoint");
  emit("session_compact", { reason: "manual" });
  assert.match(JSON.stringify(request()), /LATEST_REQUEST/, "native compaction explicitly resets overlay");
  assert.match(notices.join("\n"), /reset the live-context checkpoint/);
  emit("session_shutdown");
  assert.ok(!existsSync(`${manager.getSessionFile()}.context/writer.lock`));
  console.log("live runtime selftest passed (checkpoint → request → resume → off/on → aborted → full rewrite → revisions)");
} finally {
  try { emit("session_shutdown"); } catch { /* cleanup */ }
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  rmSync(root, { recursive: true, force: true });
}
