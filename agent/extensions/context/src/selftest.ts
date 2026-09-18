/**
 * Runnable check for the nontrivial pure logic: strict observer parsing,
 * bounded projection, and the contiguous oldest-first chunk cursor.
 * Run: node --experimental-strip-types src/selftest.ts
 */
import assert from "node:assert/strict";
import { type ChunkEntry, selectChunk } from "./chunk.ts";
import { applyConfig, DEFAULT_CONFIG } from "./config.ts";
import { maxDropCountForPool, runDropper, selectDropCandidates } from "./dropper.ts";
import { estimateTokens, hashId, MEMORY_END, MEMORY_START, OM_OBSERVATIONS_DROPPED, OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED, type Observation, projectMemory, renderMemoryBlock, stripMemoryBlock, type Reflection } from "./memory.ts";
import { registerNewTopic } from "./new-topic.ts";
import { registerOm } from "./om.ts";
import { MAX_CONTENT_CHARS, parseDropIds, parseObservations, parseReflections } from "./parse.ts";
import { sectionBudgets, selectWithinBudget } from "./prompt-budget.ts";
import { runReflector } from "./reflector.ts";
import { buildTranscript } from "./transcript.ts";
import { parseContextCommand } from "./view/command.ts";
import { gaugeFillWidth } from "./view/ui/usage-view.ts";

// ── unified /context grammar ────────────────────────────────────────────────
assert.deepEqual(parseContextCommand(""), { type: "view", view: "usage" });
assert.deepEqual(parseContextCommand("injections"), { type: "view", view: "injections" });
assert.equal(parseContextCommand("status").type, "invalid");
assert.deepEqual(parseContextCommand("settings"), { type: "om", action: "settings" });
assert.deepEqual(parseContextCommand("reload"), { type: "om", action: "reload" });
assert.deepEqual(parseContextCommand("config"), { type: "config" });
assert.equal(parseContextCommand("unknown").type, "invalid");
assert.equal(gaugeFillWidth(5, 10, 20), 10);
assert.equal(gaugeFillWidth(15, 10, 20), 20, "overflow saturates gauge fill");
assert.equal(gaugeFillWidth(1, 0, 20), 0);

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
assert.equal(
  buildTranscript([{ id: "summary", type: "branch_summary", summary: "Retained abandoned work" }])[0]?.text,
  "[branch_summary] Retained abandoned work",
  "branch summaries remain observable after tree navigation",
);

// ── prompt budgets ─────────────────────────────────────────────────────────
assert.deepEqual(selectWithinBudget(["aa", "bbbbbbbb", "cc"], 2, (item) => item), ["aa", "cc"]);
assert.deepEqual(selectWithinBudget(["aa", "bbbbbbbb", "cc"], 2, (item) => item, true), ["aa", "cc"]);
const budgets = sectionBudgets(1_000, "x".repeat(400));
assert.ok(budgets.candidates + 2 * budgets.existing < 900, "prompt sections leave framing headroom");
{
  const many = Array.from({ length: 30 }, (_, index) => ({
    ...observation(index, "low"),
    content: `candidate-${index} ${"x".repeat(500)}`,
    tokenCount: 130,
  }));
  let prompt = "";
  const registry = {
    complete: async (_model: unknown, request: any) => {
      prompt = `${request.systemPrompt}\n${request.messages[0].content[0].text}`;
      const body = request.systemPrompt.includes("dropper agent") ? '{"ids":[]}' : '{"reflections":[]}';
      return { content: [{ type: "text", text: body }] };
    },
  };
  const boundedConfig = { ...DEFAULT_CONFIG, reflectorInputMaxTokens: 4_000, dropperInputMaxTokens: 4_000, observationsPoolMaxTokens: 200 };
  await runReflector(registry as any, {} as any, boundedConfig, { observations: many, activeObservations: many, reflections: [] });
  assert.ok(estimateTokens(prompt) <= boundedConfig.reflectorInputMaxTokens, "reflector prompt respects input cap");
  await runDropper(registry as any, {} as any, boundedConfig, { candidates: many, activeObservations: many, reflections: [] });
  assert.ok(estimateTokens(prompt) <= boundedConfig.dropperInputMaxTokens, "dropper prompt respects input cap");

  const duplicateContent = "Existing durable fact.";
  const duplicate = await runReflector({
    complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ reflections: [{ content: duplicateContent, supportingObservationIds: [many[0].id] }] }) }] }),
  } as any, {} as any, boundedConfig, {
    observations: [many[0]],
    activeObservations: many,
    reflections: [{ id: hashId(duplicateContent), content: duplicateContent, supportingObservationIds: [many[1].id], tokenCount: 5, seq: 0 }],
  });
  assert.equal(duplicate.length, 1, "duplicate reflection prose can add coverage for a new observation");
}

// ── config validation ───────────────────────────────────────────────────────
assert.deepEqual(applyConfig(DEFAULT_CONFIG, { enabled: false, model: { provider: "x" } }), DEFAULT_CONFIG);
const configured = applyConfig(DEFAULT_CONFIG, {
  model: { provider: "openai", id: "gpt-5-mini" },
  observeAfterTokens: 1,
  observationsPoolMaxTokens: 999_999,
});
assert.deepEqual(configured.model, { provider: "openai", id: "gpt-5-mini" });
assert.equal(configured.observeAfterTokens, 2_000, "clamped to the minimum");
assert.equal(configured.observationsPoolMaxTokens, 100_000, "clamped to the maximum");
assert.ok(
  applyConfig(DEFAULT_CONFIG, { observeAfterTokens: 80_000, chunkMaxTokens: 4_000 }).chunkMaxTokens >= 80_000,
  "chunk never smaller than the trigger",
);
assert.equal(applyConfig(DEFAULT_CONFIG, { reflectorInputMaxTokens: 1 }).reflectorInputMaxTokens, 4_000);

// ── OM branch restore ───────────────────────────────────────────────────────
{
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    appendEntry: () => {},
  };
  const om = registerOm(pi as any);
  let branch: any[] = [
    { id: "m1", type: "message", message: { role: "user", content: "first branch", timestamp: 1 } },
    {
      id: "o1",
      type: "custom",
      customType: OM_OBSERVATIONS_RECORDED,
      data: {
        coversUpToId: "m1",
        observations: [{ id: "aaaaaaaaaaaa", content: "branch A", timestamp: new Date(1).toISOString(), relevance: "high", sourceEntryIds: ["m1"], tokenCount: 2 }],
      },
    },
    { id: "r1", type: "custom", customType: OM_REFLECTIONS_RECORDED, data: { coversUpToId: "m1", reflections: [] } },
    { id: "d1", type: "custom", customType: OM_OBSERVATIONS_DROPPED, data: { coversUpToId: "m1", observationIds: [] } },
  ];
  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => branch },
  };
  handlers.get("session_start")?.({}, ctx);
  assert.equal(om.metrics(ctx as any).activeObservations, 1);
  assert.match(om.recall("[aaaaaaaaaaaa]", ctx as any) ?? "", /branch A/, "stored IDs alias to canonical content hashes");
  assert.equal(om.metrics(ctx as any).reflector.current, 0, "empty reflection batch restores progress");
  branch = [{ id: "m2", type: "message", message: { role: "user", content: "second branch", timestamp: 2 } }];
  handlers.get("session_tree")?.({}, ctx);
  assert.equal(om.metrics(ctx as any).activeObservations, 0, "tree navigation cannot retain old-branch OM state");
  assert.ok(om.metrics(ctx as any).observer.current > 0, "new branch transcript is pending observation");
}

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

{
  const harness = newTopicHarness();
  await harness.getTool().execute();
  let compactOptions: any;
  await harness.eventHandlers.get("agent_end")?.({}, {
    compact: (options: unknown) => { compactOptions = options; },
    ui: { notify: () => {} },
  });
  await harness.eventHandlers.get("session_shutdown")?.({}, {});
  compactOptions.onComplete();
  assert.equal(harness.sentMessages.length, 0, "late compaction callback cannot continue a closed session");
}

console.log("context selftest ok");
