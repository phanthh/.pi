/** Run: node --experimental-strip-types src/compact/core/projected-compaction-selftest.ts */
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  estimateTokens,
  DEFAULT_COMPACTION_SETTINGS,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { COMPACT_MARKER, getLastCompactionStats, registerBeforeCompactHook } from "../hooks/before-compact.ts";
import { hasEnoughToCompact } from "../../idle-compact.ts";
import { CHECKPOINT_TYPE, createCheckpoint } from "../../live/projection.ts";
import { calibrateCharsPerToken, estimateMessageContentChars, estimateTokensFromChars } from "./token-estimate.ts";

type Handler = (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => SessionBeforeCompactResult | undefined;
let beforeCompact: Handler;
registerBeforeCompactHook({
  on(name: string, handler: Handler) {
    if (name === "session_before_compact") beforeCompact = handler;
  },
} as unknown as ExtensionAPI);

const assistant = (manager: SessionManager, text: string): string => manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
} satisfies AssistantMessage);
const user = (manager: SessionManager, content: string): string =>
  manager.appendMessage({ role: "user", content, timestamp: 0 });

const compact = (manager: SessionManager, instructions = "keep:1", hook: Handler = beforeCompact) => {
  const projection = manager.buildSessionProjection();
  const previous = manager.getBranch().findLast((entry) => entry.type === "compaction");
  const tokensBefore = projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const result = hook({
    type: "session_before_compact",
    branchEntries: manager.getBranch(),
    customInstructions: instructions,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
    preparation: {
      firstKeptEntryId: "",
      messagesToSummarize: projection.messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore,
      previousSummary: previous?.summary,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: DEFAULT_COMPACTION_SETTINGS,
    },
  }, { sessionManager: manager, ui: { notify() {} } } as unknown as ExtensionContext);
  assert.ok(result?.compaction, "the real hook must produce deterministic compaction");
  return result.compaction;
};
const save = (manager: SessionManager, result: ReturnType<typeof compact>) =>
  manager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);

const manager = SessionManager.inMemory();
const originalId = user(manager, "Build RAW_REPLACED_SENTINEL parser.");
assistant(manager, "Implement parser with strict validation.");
const omittedUser = user(manager, "Build RAW_OMITTED_SENTINEL exporter.");
const omittedAssistant = assistant(manager, "Implement RAW_OMITTED_ASSISTANT exporter.");
const tailId = user(manager, "RAW_LARGE_TAIL_SENTINEL ".repeat(30_000));
const tailAssistant = assistant(manager, "TAIL_ASSISTANT_SENTINEL ".repeat(30_000));
const originalLeaf = manager.getLeafId()!;
manager.appendContextEdit(originalId, { content: "Build STALE_REPLACEMENT_SENTINEL parser." });
manager.appendContextEdit(originalId, { content: "Build PROJECTED_REPLACEMENT_SENTINEL parser." });
manager.appendContextEdit(omittedUser, null);
manager.appendContextEdit(omittedAssistant, null);
manager.appendContextEdit(tailId, { content: "Verify projected parser." });
manager.appendContextEdit(tailAssistant, { content: "Parser passes tests." });
const editedLeaf = manager.getLeafId()!;

// Sibling navigation must not import edits from the abandoned branch.
manager.branch(originalLeaf);
const sibling = compact(manager);
assert.match(sibling.summary, /RAW_REPLACED_SENTINEL/);
assert.match(sibling.summary, /RAW_OMITTED_SENTINEL/);
assert.doesNotMatch(sibling.summary, /PROJECTED_REPLACEMENT_SENTINEL/);
manager.branch(editedLeaf);

const first = compact(manager);
assert.equal(first.firstKeptEntryId, tailId, "cut keeps the original source entry ID");
assert.match(first.summary, /PROJECTED_REPLACEMENT_SENTINEL/);
assert.doesNotMatch(first.summary, /RAW_REPLACED|STALE_REPLACEMENT|RAW_OMITTED|RAW_LARGE_TAIL|TAIL_ASSISTANT_SENTINEL/);
const firstStats = getLastCompactionStats()!;
assert.equal(firstStats.summarized, 2);
assert.equal(firstStats.totalUserTurns, 2, "omitted user turns cannot affect cut selection");
assert.equal(firstStats.kept, 2);
const projectedChars = manager.buildSessionProjection().messages.reduce((sum, message) =>
  sum + estimateMessageContentChars("content" in message ? message.content : undefined), 0);
const calibration = calibrateCharsPerToken(projectedChars, first.tokensBefore);
assert.equal(firstStats.keptTokensEst,
  estimateTokensFromChars("Verify projected parser.".length + "Parser passes tests.".length, calibration.charsPerToken),
  "kept tokens use replacements, not huge archival content");

// Default smart-keep and budget rescue must also see the small projected tail.
const smart = compact(manager, COMPACT_MARKER);
assert.equal(smart.firstKeptEntryId, tailId);
assert.equal(getLastCompactionStats()!.budgetCut, undefined);
save(manager, first);
assert.doesNotMatch(JSON.stringify(manager.buildSessionProjection().messages), /RAW_REPLACED|RAW_OMITTED|RAW_LARGE_TAIL/);

// Omit the previous cut's anchor, then replace its retained assistant and compact again.
manager.appendContextEdit(tailId, null);
manager.appendContextEdit(tailAssistant, { content: "PROJECTED_SECOND_PASS deployment is blocked pending validation." });
const nextId = user(manager, "Check deployment compatibility.");
assistant(manager, "Deployment checks pass.");
const second = compact(manager);
assert.equal(second.firstKeptEntryId, nextId);
assert.match(second.summary, /PROJECTED_SECOND_PASS/);
assert.doesNotMatch(second.summary, /Verify projected parser|RAW_REPLACED|STALE_REPLACEMENT|RAW_OMITTED|RAW_LARGE_TAIL|TAIL_ASSISTANT_SENTINEL/);
assert.equal(getLastCompactionStats()!.summarized, 1);
save(manager, second);

user(manager, "Build final release.");
assistant(manager, "Release checks pass.");
const all = compact(manager, `${COMPACT_MARKER} keep:0`);
assert.equal(all.firstKeptEntryId, "", "compact-all sentinel stays intact");
save(manager, all);
user(manager, "Validate new checkpoint.");
assistant(manager, "Checkpoint checks pass.");
const newestId = user(manager, "Ship new checkpoint.");
assistant(manager, "Checkpoint ready to ship.");
const repeated = compact(manager);
assert.equal(repeated.firstKeptEntryId, newestId);
assert.equal(getLastCompactionStats()!.summarized, 2, "compact-all must not resurrect old live messages");
assert.doesNotMatch(repeated.summary, /RAW_REPLACED|STALE_REPLACEMENT|RAW_OMITTED|RAW_LARGE_TAIL|TAIL_ASSISTANT_SENTINEL/);

let liveCompact: Handler | undefined;
registerBeforeCompactHook({
  on(name: string, handler: Handler) {
    if (name === "session_before_compact") liveCompact = handler;
  },
} as unknown as ExtensionAPI, { liveEnabled: () => true });
const liveManager = SessionManager.inMemory();
const priorId = user(liveManager, "Prior request.");
assistant(liveManager, "Prior answer.");
liveManager.appendCompaction("RAW_PREVIOUS_SUMMARY_SECRET", priorId, 100);
user(liveManager, "RAW_IDLE_SECRET ".repeat(3_000));
assistant(liveManager, "Old raw assistant reply.");
user(liveManager, "RAW_OLD_REQUEST should not survive.");
assistant(liveManager, "Old raw implementation.");
const raw = liveManager.buildSessionProjection();
const edited = structuredClone(raw);
edited.entries = [{ ...raw.entries[0]!, messages: [{ role: "user", content: "PROJECTED_IDLE_NOTE verifies new state.", timestamp: 0 }] }];
edited.messages = edited.entries.flatMap((entry) => entry.messages);
liveManager.appendCustomEntry(CHECKPOINT_TYPE, createCheckpoint(raw, edited, raw));
user(liveManager, "Check projected state before idle compaction.");
assistant(liveManager, "Projected state verified.");
const liveBranch = liveManager.getBranch();
assert.equal(hasEnoughToCompact(liveBranch, 500), true, "Raw history would trigger idle compaction");
assert.equal(hasEnoughToCompact(liveBranch, 500, true), false, "Small projected history must skip idle compaction");
assert.equal(hasEnoughToCompact(liveBranch, 1, true), true, "Large projected history remains eligible");
assert.ok(liveCompact);
const idle = compact(liveManager, COMPACT_MARKER, liveCompact);
assert.equal(idle.firstKeptEntryId, "", "Native compaction must retain no raw pre-checkpoint tail");
assert.match(idle.summary, /PROJECTED_IDLE_NOTE/);
assert.doesNotMatch(idle.summary, /RAW_IDLE_SECRET|RAW_OLD_REQUEST|RAW_PREVIOUS_SUMMARY_SECRET/);
save(liveManager, idle);
assert.doesNotMatch(JSON.stringify(liveManager.buildSessionProjection().messages), /RAW_IDLE_SECRET|RAW_OLD_REQUEST|RAW_PREVIOUS_SUMMARY_SECRET/);
console.log("projected compaction selftest passed");
