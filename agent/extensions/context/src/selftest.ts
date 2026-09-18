/**
 * Runnable check for the nontrivial pure logic: strict observer parsing,
 * bounded projection, and the contiguous oldest-first chunk cursor.
 * Run: node --experimental-strip-types src/selftest.ts
 */
import assert from "node:assert/strict";
import { type ChunkEntry, selectChunk } from "./chunk.ts";
import { applyConfig, DEFAULT_CONFIG } from "./config.ts";
import { maxDropCountForPool, selectDropCandidates } from "./dropper.ts";
import { MEMORY_END, MEMORY_START, type Observation, projectMemory, renderMemoryBlock, stripMemoryBlock, type Reflection } from "./memory.ts";
import { MAX_CONTENT_CHARS, parseDropIds, parseObservations, parseReflections } from "./parse.ts";
import { registerNewTopic } from "./new-topic.ts";
import { parseContextCommand } from "./view/command.ts";

// ── unified /context grammar ────────────────────────────────────────────────
assert.deepEqual(parseContextCommand(""), { type: "view", view: "usage" });
assert.deepEqual(parseContextCommand("injections"), { type: "view", view: "injections" });
assert.deepEqual(parseContextCommand("status"), { type: "om", action: "status" });
assert.deepEqual(parseContextCommand("settings"), { type: "om", action: "settings" });
assert.deepEqual(parseContextCommand("reload"), { type: "om", action: "reload" });
assert.deepEqual(parseContextCommand("config"), { type: "config" });
assert.equal(parseContextCommand("unknown").type, "invalid");

// ── parser ──────────────────────────────────────────────────────────────────
const labels = new Set(["e1", "e2"]);

const good = parseObservations(
  '```json\n{"observations":[{"content":"Chose SQLite over Postgres [e1][e9]","relevance":"high","sourceIds":["e1","e9"]}]}\n```',
  labels,
);
assert.equal(good.observations.length, 1);
assert.deepEqual(good.observations[0].sourceIds, ["e1"], "unknown source ids are filtered");
assert.equal(good.observations[0].relevance, "high");
assert.equal(good.observations[0].content, "Chose SQLite over Postgres", "citation labels stay in sourceIds only");

const rejected = parseObservations(
  JSON.stringify({
    observations: [
      { content: "no sources", relevance: "high", sourceIds: ["e7"] },
      { content: "", sourceIds: ["e1"] },
      { content: "dup", sourceIds: ["e1"] },
      { content: " DUP ", sourceIds: ["e2"] },
      { content: "bad relevance", relevance: "urgent", sourceIds: ["e2"] },
    ],
  }),
  labels,
);
assert.equal(rejected.observations.length, 2, "only the first dup and the salvageable one survive");
assert.equal(rejected.rejected, 3);
assert.equal(rejected.observations[1].relevance, "medium", "invalid relevance falls back to medium");

assert.deepEqual(parseObservations("I cannot comply.", labels), { observations: [], rejected: 0 });
assert.deepEqual(parseObservations('{"observations": [', labels), { observations: [], rejected: 0 });

const long = parseObservations(
  JSON.stringify({ observations: [{ content: "x".repeat(2_000), sourceIds: ["e1"] }] }),
  labels,
);
assert.equal(long.observations[0].content.length, MAX_CONTENT_CHARS + 1, "content is truncated with an ellipsis");

const reflected = parseReflections(JSON.stringify({ reflections: [
  { content: "User requires SQLite because deployment is single-node.", supportingObservationIds: ["o1"] },
  { content: "unsafe coverage", supportingObservationIds: ["o1", "unknown"] },
] }), new Set(["o1"]));
assert.equal(reflected.reflections.length, 1);
assert.equal(reflected.rejected, 1, "one unknown support id rejects the whole reflection");
assert.deepEqual(parseDropIds('{"ids":["o1","unknown","o1"]}', new Set(["o1"])), ["o1"]);

// ── projection ──────────────────────────────────────────────────────────────
const observation = (seq: number, relevance: Observation["relevance"]): Observation => ({
  id: String(seq).padStart(12, "0"),
  content: `${relevance}-${seq} ${"y".repeat(36)}`, // ~10 tokens each
  timestamp: new Date(seq * 1_000).toISOString(),
  relevance,
  sourceEntryIds: ["e1"],
  tokenCount: 10,
  seq,
  coversUpToId: "e1",
});
const ledger: Observation[] = [
  observation(0, "critical"),
  observation(1, "low"),
  observation(2, "high"),
  observation(3, "low"),
];

const projected = projectMemory(ledger, 55);
assert.deepEqual(
  projected.map((o) => o.seq),
  [0, 2],
  "relevance wins, output stays chronological, budget respected",
);
assert.deepEqual(projectMemory(ledger, 0), []);
assert.deepEqual(projectMemory([], 1_000), []);
assert.deepEqual(projectMemory(ledger, 10_000).map((o) => o.seq), [0, 1, 2, 3]);
// recency breaks a relevance tie
assert.deepEqual(
  projectMemory([observation(0, "low"), observation(1, "low")], 28).map((o) => o.seq),
  [1],
);

// ── dropper deterministic safety ────────────────────────────────────────────
const dropPool = [observation(1, "low"), observation(2, "medium"), observation(3, "critical")];
dropPool.forEach((item) => { item.tokenCount = 100; });
assert.equal(maxDropCountForPool(dropPool, 300, 10_000), 0, "small pools skip the model");
assert.equal(maxDropCountForPool(dropPool, 300, 1_000), 1, "fuller pools get a bounded drop count");
const reflection: Reflection = {
  id: "aaaaaaaaaaaa",
  content: "Covered low observation.",
  supportingObservationIds: [dropPool[0].id],
  tokenCount: 6,
  seq: 0,
};
assert.deepEqual(
  selectDropCandidates([dropPool[2].id, dropPool[1].id, dropPool[0].id], dropPool, 1, [reflection]),
  [dropPool[0].id],
  "reflection coverage outranks relevance, age, and proposal order",
);

// ── summary block round-trip ────────────────────────────────────────────────
const block = renderMemoryBlock(projected);
assert.ok(block.startsWith(MEMORY_START) && block.endsWith(MEMORY_END));
const summary = `[BRIEF]\nwork so far\n\n${block}`;
assert.equal(stripMemoryBlock(summary), "[BRIEF]\nwork so far");
assert.equal(stripMemoryBlock("[BRIEF]\nno memory"), "[BRIEF]\nno memory");
assert.equal(stripMemoryBlock(`${summary}\n\n${block}`), "[BRIEF]\nwork so far", "re-injection stays idempotent");
assert.equal(
  stripMemoryBlock("[BRIEF]\nold summary\n\n[OBSERVED MEMORY]\n- legacy\n[/OBSERVED MEMORY]"),
  "[BRIEF]\nold summary",
  "legacy marker is removed during next compaction",
);

// ── chunk cursor ────────────────────────────────────────────────────────────
const entries: ChunkEntry[] = ["a", "b", "c", "d"].map((id) => ({ id, text: "z".repeat(40) })); // 10 tok each

const first = selectChunk(entries, undefined, 25);
assert.deepEqual(first?.entries.map((e) => e.id), ["a", "b"], "oldest-first, capped");
assert.equal(first?.pendingTokens, 40, "pending counts everything after the cursor");
assert.equal(first?.throughEntryId, "b");

const next = selectChunk(entries, "b", 25);
assert.deepEqual(next?.entries.map((e) => e.id), ["c", "d"], "resumes contiguously after the cursor");
assert.equal(selectChunk(entries, "d", 25), null, "cursor at the tail means nothing to do");
assert.deepEqual(
  selectChunk(entries, "zz", 25)?.entries.map((e) => e.id),
  ["a", "b"],
  "unknown cursor restarts from the beginning instead of skipping history",
);
assert.deepEqual(
  selectChunk(entries, undefined, 1)?.entries.map((e) => e.id),
  ["a"],
  "an oversized entry is still taken so the cursor cannot stall",
);

// ── config validation ───────────────────────────────────────────────────────
assert.deepEqual(applyConfig(DEFAULT_CONFIG, { enabled: "yes", model: { provider: "x" } }), DEFAULT_CONFIG);
const configured = applyConfig(DEFAULT_CONFIG, {
  enabled: false,
  model: { provider: "openai", id: "gpt-5-mini" },
  observeAfterTokens: 1,
  observationsPoolMaxTokens: 999_999,
});
assert.equal(configured.enabled, false);
assert.deepEqual(configured.model, { provider: "openai", id: "gpt-5-mini" });
assert.equal(configured.observeAfterTokens, 2_000, "clamped to the minimum");
assert.equal(configured.observationsPoolMaxTokens, 100_000, "clamped to the maximum");
assert.ok(
  applyConfig(DEFAULT_CONFIG, { observeAfterTokens: 80_000, chunkMaxTokens: 4_000 }).chunkMaxTokens >= 80_000,
  "chunk never smaller than the trigger",
);

// ── new_topic orchestration ─────────────────────────────────────────────────
const newTopicHarness = () => {
  const eventHandlers = new Map<string, (...args: any[]) => unknown>();
  let tool: any;
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => eventHandlers.set(name, handler),
    registerTool: (definition: unknown) => { tool = definition; },
    sendMessage: (message: unknown, options: unknown) => { sentMessages.push({ message, options }); },
  };
  registerNewTopic(pi as any, {
    compactMarker: "__algo_compact__",
    triggerInvisibleContinue: (extensionPi) => {
      extensionPi.sendMessage(
        { customType: "auto-continue", content: [], display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });
  return { eventHandlers, getTool: () => tool, sentMessages };
};

{
  const harness = newTopicHarness();
  const tool = harness.getTool();
  const first = await tool.execute();
  assert.equal(first.terminate, true, "new_topic terminates active run before compaction");
  const duplicate = await tool.execute();
  assert.equal(duplicate.terminate, true, "duplicate cutovers remain guarded");

  let compactOptions: any;
  const ctx = {
    compact: (options: unknown) => { compactOptions = options; },
    ui: { notify: () => {} },
  };
  await harness.eventHandlers.get("agent_end")?.({}, ctx);
  assert.equal(compactOptions.customInstructions, "__algo_compact__ keep:1");
  compactOptions.onComplete();
  assert.equal(harness.sentMessages.length, 1, "successful compaction queues invisible continuation");
  assert.equal((await tool.execute()).terminate, true, "completion clears duplicate guard");
}

{
  const harness = newTopicHarness();
  const tool = harness.getTool();
  await tool.execute();
  let compactOptions: any;
  await harness.eventHandlers.get("agent_end")?.({}, {
    compact: (options: unknown) => { compactOptions = options; },
    ui: { notify: () => {} },
  });
  compactOptions.onError(new Error("boom"));
  assert.equal((await tool.execute()).terminate, true, "compaction failure clears duplicate guard");

  await harness.eventHandlers.get("session_shutdown")?.({}, {});
  assert.equal((await tool.execute()).terminate, true, "shutdown clears duplicate guard");
}

console.log("context selftest ok");
