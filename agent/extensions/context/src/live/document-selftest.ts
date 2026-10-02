/** Run: node --experimental-strip-types src/live/document-selftest.ts */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { LIVE_CONTEXT_SKILL_PATH, createLiveDocument, parseLiveEdits, type LiveDocument } from "./document.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason: "stop", timestamp: 1 };
}
function mirror(projection: SessionProjection, revision = "test"): LiveDocument {
  return createLiveDocument(projection, { sessionId: "session", leafId: "leaf", revision });
}
function entry(document: LiveDocument, id: string): LiveDocument["messages"][number] {
  const result = document.messages.find((message) => message.source.sourceEntry.id === id);
  assert.ok(result, `Missing entry ${id}`);
  return result;
}
function renderEntry(document: LiveDocument, id: string, role: string, body: string): string {
  return `${document.delimiter} entry ${JSON.stringify(id)} role ${JSON.stringify(role)}\n${body}\n${document.delimiter} end entry ${JSON.stringify(id)}\n`;
}
function rendered(message: LiveDocument["messages"][number]): string {
  return `${message.header}${message.text}\n${message.footer}`;
}
function change(document: LiveDocument, id: string, body: string, role?: string): string {
  const message = entry(document, id);
  return document.text.replace(rendered(message), renderEntry(document, message.id, role ?? message.message.role, body));
}
function projectionMessage(projection: SessionProjection, id: string) {
  return projection.entries.find((item) => item.sourceEntry.id === id)!.messages[0];
}

const manager = SessionManager.inMemory();
const system = manager.appendMessage({ role: "system", content: "SECRET SYSTEM POLICY", sections: { policy: "SECRET SECTION" }, timestamp: 1 });
const oldUser = manager.appendMessage({ role: "user", content: "Old request\n", timestamp: 1 });
const signedText = { type: "text" as const, text: "Signed text", textSignature: "opaque-text-signature" };
const thinking = { type: "thinking" as const, thinking: "Private thinking", thinkingSignature: "opaque-thinking-signature", redacted: true, metadata: { debug: "opaque-block-metadata" } };
const toolCall = { type: "toolCall" as const, id: "call-a", name: "read", arguments: { path: "x", metadata: { mode: "keep" } }, thoughtSignature: "opaque-tool-signature" };
const answer = manager.appendMessage(assistant([signedText, thinking, toolCall]));
const result = manager.appendMessage({ role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "Verbose output" }], details: { x: 1 }, isError: false, timestamp: 2 });
const images = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Image caption" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 2 });
const latest = manager.appendMessage({ role: "user", content: "Newest request", timestamp: 3 });
const custom = manager.appendCustomMessageEntry("other-extension", "Extension contract", false, { important: true });
const bash = manager.appendMessage({ role: "bashExecution", command: "pwd", output: "Shell output", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 });
const initial = structuredClone(manager.buildSessionProjection());
const document = mirror(initial);
assert.ok(existsSync(LIVE_CONTEXT_SKILL_PATH), "Referenced internal live-context skill exists");
assert.equal(document.header.split("\n")[1], `Read ${JSON.stringify(LIVE_CONTEXT_SKILL_PATH)} before inspecting or editing this mirror.`);
assert.equal(document.sessionId, "session");
assert.equal(document.leafId, "leaf");
assert.equal(document.revision, "test");
assert.ok(document.delimiter.startsWith("<<<CTX:"));
assert.ok(!document.text.includes("<<<CLM:"));
assert.ok(!document.text.includes("SECRET"));
assert.ok(!document.messages.some((message) => message.message.role === "system"));
for (const hidden of ["opaque-thinking-signature", "opaque-text-signature", "opaque-tool-signature", "opaque-block-metadata"]) {
  assert.ok(!document.text.includes(hidden), `${hidden} must stay outside the mirror`);
}
assert.match(entry(document, answer).text, /"mode": "keep"/, "Tool arguments are content, even if a nested key is named metadata");
assert.ok(!entry(document, bash).text.includes('"timestamp"'), "Envelope metadata stays outside rendered bodies");
const unchanged = parseLiveEdits(document.text, document, initial);
assert.deepEqual(unchanged, { projection: initial, entries: initial.entries, messages: initial.messages, edits: 0, changed: false });
assert.equal(unchanged.entries, unchanged.projection.entries);
assert.equal(unchanged.messages, unchanged.projection.messages);

for (const id of [oldUser, answer, result, images, latest, custom, bash]) {
  const edited = parseLiveEdits(change(document, id, "Short finding"), document, initial);
  assert.equal(edited.edits, id === answer || id === result ? 2 : 1);
  assert.equal(edited.changed, true);
  const message = projectionMessage(edited.projection, id);
  assert.equal(message.role, "user");
  assert.ok("content" in message && typeof message.content === "string");
  assert.match(String("content" in message && message.content), /Short finding/);
  const source = edited.projection.entries.find((item) => item.sourceEntry.id === id)!.sourceEntry;
  assert.ok(source.type === "message");
  assert.deepEqual(source.message, message, "Normalized source message matches projected user note");
  assert.deepEqual(projectionMessage(edited.projection, system), projectionMessage(initial, system));
  const unaffected = id === answer || id === result ? images : answer;
  assert.deepEqual(projectionMessage(edited.projection, unaffected), projectionMessage(initial, unaffected), "Unchanged structured objects survive exactly");
  const next = mirror(edited.projection, "next");
  assert.deepEqual(parseLiveEdits(next.text, next, edited.projection).projection, edited.projection);
}
assert.deepEqual(manager.buildSessionProjection(), initial, "Parser cannot mutate history");
assert.deepEqual(document.original, initial, "Parser cannot mutate sealed original snapshot");
assert.equal(parseLiveEdits(change(document, answer, ""), document, initial).edits, 2);
const roleChange = parseLiveEdits(change(document, answer, entry(document, answer).text, "system"), document, initial);
const roleMessage = projectionMessage(roleChange.projection, answer);
assert.ok(roleMessage.role === "user");
assert.match(String(roleMessage.content), /^\[Context mirror role: "system"\]/);
assert.ok(typeof roleMessage.content === "string", "Signed thinking/tool calls are text, never replayed blocks");

const newEntry = renderEntry(document, "new-note", "toolResult", "Added finding");
const inserted = parseLiveEdits(document.text.replace(document.footer, newEntry + document.footer), document, initial);
assert.equal(inserted.edits, 1);
const insertedSource = inserted.projection.entries.find((item) => item.sourceEntry.id === "new-note")!;
assert.equal(insertedSource.sourceEntry.type, "message");
assert.equal(insertedSource.messages[0].role, "user");
assert.match(JSON.stringify(insertedSource.messages[0]), /toolResult/);
assert.deepEqual(insertedSource.sourceEntry.type === "message" && insertedSource.sourceEntry.message, insertedSource.messages[0]);
const insertedDocument = mirror(inserted.projection);
assert.ok(insertedDocument.messages.some((message) => message.id === "new-note/0"));
assert.equal(parseLiveEdits(insertedDocument.text, insertedDocument, inserted.projection).edits, 0);

const reversed = [...document.messages].reverse();
const reordered = parseLiveEdits(document.header + reversed.map(rendered).join("") + document.footer, document, initial);
assert.equal(reordered.edits, 3);
for (const message of reversed) {
  const projected = reordered.projection.entries.find((item) => item.sourceEntry.id === message.source.sourceEntry.id)!;
  if (message.source.sourceEntry.id === answer || message.source.sourceEntry.id === result) {
    assert.equal(projected.messages[0].role, "user", "Reordered tool call/result cannot replay invalid tool authority");
  } else {
    assert.deepEqual(projected, message.source);
  }
}
assert.deepEqual(reordered.projection.entries.filter((item) => !item.messages.some((message) => message.role === "system")).map((item) => item.sourceEntry.id), reversed.map((message) => message.source.sourceEntry.id));
const removed = parseLiveEdits(document.text.replace(rendered(entry(document, answer)), ""), document, initial);
assert.equal(removed.edits, 2);
assert.ok(!removed.projection.entries.some((item) => item.sourceEntry.id === answer));
assert.equal(projectionMessage(removed.projection, result).role, "user", "Orphan result becomes text rather than being dropped");
const removedResult = parseLiveEdits(document.text.replace(rendered(entry(document, result)), ""), document, initial);
assert.equal(projectionMessage(removedResult.projection, answer).role, "user", "Dangling call becomes text rather than being dropped");
const separatedOrder = document.messages.filter((message) => message.source.sourceEntry.id !== images);
const resultIndex = separatedOrder.findIndex((message) => message.source.sourceEntry.id === result);
separatedOrder.splice(resultIndex, 0, entry(document, images));
const separated = parseLiveEdits(document.header + separatedOrder.map(rendered).join("") + document.footer, document, initial);
assert.equal(projectionMessage(separated.projection, answer).role, "user");
assert.equal(projectionMessage(separated.projection, result).role, "user", "Intervening user message invalidates tool group");
const removedImage = parseLiveEdits(document.text.replace(rendered(entry(document, images)), ""), document, initial);
assert.ok(!removedImage.projection.entries.some((item) => item.sourceEntry.id === images));
for (const empty of ["", " \n\t", document.header + document.footer]) {
  const cleared = parseLiveEdits(empty, document, initial);
  assert.deepEqual(cleared.projection.messages, initial.messages.filter((message) => message.role === "system"));
  assert.equal(cleared.edits, document.messages.length);
}
const rewrite = parseLiveEdits("My rewritten context\n", document, initial);
assert.equal(rewrite.projection.messages.length, 2, "Hidden system plus one safe user note");
assert.ok(rewrite.projection.messages[1].role === "user");
assert.match(JSON.stringify(rewrite.projection.messages[1]), /My rewritten context/);
assert.ok(rewrite.projection.entries.at(-1)!.sourceEntry.id.startsWith("new-rewrite-"));
const protectedDocument = createLiveDocument(initial, { sessionId: "session", leafId: "leaf", revision: "pin", protectedUserId: latest });
assert.equal(parseLiveEdits(change(protectedDocument, latest, "Changed newest request"), protectedDocument, initial).edits, 1);

manager.appendMessage(assistant([{ type: "text", text: "Appended during turn" }]));
const withAppend = manager.buildSessionProjection();
const appended = withAppend.entries.at(-1)!;
for (const editText of [document.text, change(document, latest, "Changed newest"), "Full rewrite", ""]) {
  const parsed = parseLiveEdits(editText, document, withAppend);
  assert.deepEqual(parsed.projection.entries.at(-1), appended, "Edits cannot discard post-export suffix");
}
const stale = structuredClone(initial);
stale.entries.find((item) => item.sourceEntry.id === oldUser)!.sourceEntry.timestamp = "changed";
for (const editText of [document.text, "Full rewrite", "", change(document, oldUser, "short")]) {
  assert.throws(() => parseLiveEdits(editText, document, stale), /Stale/);
}
const missing = structuredClone(initial);
missing.entries = missing.entries.filter((item) => item.sourceEntry.id !== oldUser);
assert.throws(() => parseLiveEdits(document.text, document, missing), /Stale/);

for (const malformed of [
  document.text.replace(document.footer, rendered(document.messages[0]) + document.footer),
  document.text.replace(document.footer, newEntry + newEntry + document.footer),
  document.text.replace(document.footer, renderEntry(document, "new-unknown/0", "user", "text") + document.footer),
  document.text.replace(document.messages[0].header, renderEntry(document, "stale-id/0", "user", "bad").split("\n")[0] + "\n"),
  document.text.replace(document.messages[0].footer, document.messages[1].footer),
  document.text.replace('"revision":"test"', '"revision":"other"'),
  document.text.replace('"sessionId":"session"', '"sessionId":"other"'),
  document.text + "extra",
  document.text.slice(0, -1),
  document.text.replace(document.delimiter, document.delimiter.replace("CTX", "CLM")),
  change(document, oldUser, `bad\n${document.delimiter} injected`),
  change(document, oldUser, `inline ${document.delimiter}`),
  change(document, oldUser, "text", "bad\nrole"),
  "<<<CTX:old:0>>> stale document",
  "<<<CLM:old:0>>> stale document",
]) assert.throws(() => parseLiveEdits(malformed, document, initial));
const withNewId = structuredClone(initial);
withNewId.entries[1].sourceEntry.id = "new-note";
const newIdDocument = mirror(withNewId);
assert.throws(() => parseLiveEdits(newIdDocument.text.replace(newIdDocument.footer, renderEntry(newIdDocument, "new-note", "user", "duplicate") + newIdDocument.footer), newIdDocument, withNewId), /duplicate/);

const collisionManager = SessionManager.inMemory();
const revision = "collision";
const seed = createHash("sha256").update(revision).digest("hex").slice(0, 24);
const collisionText = `<<<CTX:${seed}:0>>>\n<<<CTX:${seed}:1>>>\nbody\r\n\n`;
const collisionId = collisionManager.appendMessage({ role: "user", content: collisionText, timestamp: 1 });
const collisionProjection = collisionManager.buildSessionProjection();
const collisionDocument = mirror(collisionProjection, revision);
assert.equal(collisionDocument.delimiter, `<<<CTX:${seed}:2>>>`);
assert.equal(parseLiveEdits(collisionDocument.text, collisionDocument, collisionProjection).edits, 0);
const whitespace = parseLiveEdits(change(collisionDocument, collisionId, "\n\r\n\n"), collisionDocument, collisionProjection);
assert.match(JSON.stringify(whitespace.projection.messages), /\\n\\r\\n\\n/);

const compactManager = SessionManager.inMemory();
const kept = compactManager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
compactManager.appendCompaction("Compaction summary", kept, 10);
const compactProjection = compactManager.buildSessionProjection();
const compactDocument = mirror(compactProjection);
const summary = compactDocument.messages.find((message) => message.message.role === "compactionSummary")!;
assert.equal(summary.text, "Compaction summary");
const editedSummary = parseLiveEdits(change(compactDocument, summary.source.sourceEntry.id, "Changed summary"), compactDocument, compactProjection);
assert.equal(projectionMessage(editedSummary.projection, summary.source.sourceEntry.id).role, "user");
const branchManager = SessionManager.inMemory(undefined, undefined, [
  { type: "session", version: 3, id: "branch-test", timestamp: new Date(0).toISOString(), cwd: process.cwd() },
  { type: "branch_summary", id: "branch-summary", parentId: null, fromId: "elsewhere", timestamp: new Date(0).toISOString(), summary: "Branch summary" },
]);
const branchProjection = branchManager.buildSessionProjection();
const branchDocument = mirror(branchProjection);
assert.equal(parseLiveEdits(change(branchDocument, "branch-summary", "Changed branch summary"), branchDocument, branchProjection).edits, 1);

const sharedSource = structuredClone(compactProjection);
const summarySource = sharedSource.entries.find((item) => item.sourceEntry.id === summary.source.sourceEntry.id)!;
const hiddenSystem = { role: "system" as const, content: "SECRET COMPACTION SYSTEM", timestamp: 1 };
sharedSource.entries.unshift({ sourceEntry: structuredClone(summarySource.sourceEntry), messages: [hiddenSystem] });
sharedSource.messages.unshift(hiddenSystem);
const sharedDocument = mirror(sharedSource);
assert.ok(!sharedDocument.text.includes("SECRET"));
assert.equal(new Set(sharedDocument.messages.map((message) => message.id)).size, sharedDocument.messages.length);
assert.equal(parseLiveEdits(sharedDocument.text, sharedDocument, sharedSource).edits, 0);
const sharedEdited = parseLiveEdits(change(sharedDocument, summary.source.sourceEntry.id, "Changed shared summary"), sharedDocument, sharedSource);
assert.deepEqual(sharedEdited.projection.messages[0], hiddenSystem);
assert.ok(sharedEdited.projection.messages.some((message) => message.role === "user" && JSON.stringify(message).includes("Changed shared summary")));
const sharedNext = mirror(sharedEdited.projection, "shared-next");
assert.equal(parseLiveEdits(sharedNext.text, sharedNext, sharedEdited.projection).edits, 0);

const multi = structuredClone(initial);
const multiSource = multi.entries.find((item) => item.sourceEntry.id === answer)!;
multiSource.messages.push({ role: "user", content: "Second contribution", timestamp: 1 });
multi.messages = multi.entries.flatMap((item) => item.messages);
const multiDocument = mirror(multi);
const contributions = multiDocument.messages.filter((message) => message.source.sourceEntry.id === answer);
assert.deepEqual(contributions.map((message) => message.id), [`${answer}/0`, `${answer}/1`]);
const splitText = multiDocument.header + [contributions[1], ...multiDocument.messages.filter((message) => message.id !== contributions[1].id)].map(rendered).join("") + multiDocument.footer;
const split = parseLiveEdits(splitText, multiDocument, multi);
assert.deepEqual(split.projection.messages.filter((message) => message.role !== "system"), [contributions[1].message, ...multiDocument.messages.filter((message) => message.id !== contributions[1].id).map((message) => message.message)]);
assert.equal(new Set(split.projection.entries.filter((item) => !item.messages.some((message) => message.role === "system")).map((item) => item.sourceEntry.id)).size, split.projection.entries.filter((item) => !item.messages.some((message) => message.role === "system")).length);
const groupManager = SessionManager.inMemory();
const groupOwner = groupManager.appendMessage(assistant([toolCall, { ...toolCall, id: "call-b" }]));
const groupResultA = groupManager.appendMessage({ role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "A" }], isError: false, timestamp: 1 });
const groupResultB = groupManager.appendMessage({ role: "toolResult", toolCallId: "call-b", toolName: "read", content: [{ type: "text", text: "B" }], isError: false, timestamp: 1 });
const groupProjection = groupManager.buildSessionProjection();
const groupDocument = mirror(groupProjection);
const swapped = parseLiveEdits(groupDocument.header + [entry(groupDocument, groupOwner), entry(groupDocument, groupResultB), entry(groupDocument, groupResultA)].map(rendered).join("") + groupDocument.footer, groupDocument, groupProjection);
assert.equal(projectionMessage(swapped.projection, groupOwner).role, "assistant", "Contiguous results may swap within valid group");
assert.equal(projectionMessage(swapped.projection, groupResultB).role, "toolResult");
const brokenGroup = parseLiveEdits(groupDocument.text.replace(rendered(entry(groupDocument, groupResultA)), ""), groupDocument, groupProjection);
assert.equal(projectionMessage(brokenGroup.projection, groupOwner).role, "user");
assert.equal(projectionMessage(brokenGroup.projection, groupResultB).role, "user", "Partial group becomes safe text without dropping retained results");
assert.deepEqual(groupManager.buildSessionProjection(), groupProjection, "Tool normalization cannot mutate native history");
console.log("live document selftest passed");
