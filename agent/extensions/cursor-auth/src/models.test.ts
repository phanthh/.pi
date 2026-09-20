import { afterEach, describe, expect, test } from "vitest";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import bundledModels from "./cursor-models-raw.json" with { type: "json" };
import {
  buildThinkingLevelMap,
  FALLBACK_MODELS,
  modelConfig,
  parseModelId as publicParseModelId,
  processModels,
} from "./index.ts";
import {
  buildEffortMap,
  canonicalModelId,
  parseModelId,
  resolveModelId,
  setModelRouting,
} from "./model-ids.ts";
import { inferContextWindow, type CursorModel } from "./proxy.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const rawIds = new Set(bundledModels.map((model) => model.id));
const processed = processModels(bundledModels);

function fixture(id: string): CursorModel {
  return { id, name: id, reasoning: false, contextWindow: 200_000, maxTokens: 64_000 };
}

function configured(model: ReturnType<typeof processModels>[number]): Model<"openai-completions"> {
  return {
    ...modelConfig(model),
    provider: "cursor",
    api: "openai-completions",
    baseUrl: "https://cursor-fixture.invalid/v1",
  };
}

afterEach(() => setModelRouting(bundledModels));

describe("model ID parsing", () => {
  test("retains the public parser export", () => {
    expect(publicParseModelId).toBe(parseModelId);
  });

  test.each([
    ["claude-example-high-thinking", "claude-example", "high", true, false],
    ["claude-example-thinking-high", "claude-example", "high", true, false],
    ["claude-example-high-thinking-fast", "claude-example", "high", true, true],
    ["claude-example-thinking-high-fast", "claude-example", "high", true, true],
    ["gpt-5.5-extra-high", "gpt-5.5", "extra-high", false, false],
    ["gpt-example-extra-high-thinking-fast", "gpt-example", "extra-high", true, true],
    ["gpt-example-thinking-extra-high-fast", "gpt-example", "extra-high", true, true],
    ["gemini-3.6-flash-minimal", "gemini-3.6-flash", "minimal", false, false],
    ["gpt-5.1-codex-max", "gpt-5.1-codex-max", "", false, false],
    ["gpt-5.1-codex-max-high-fast", "gpt-5.1-codex-max", "high", false, true],
  ] as const)("parses %s", (id, base, effort, thinking, fast) => {
    expect(parseModelId(id)).toEqual({ base, effort, thinking, fast });
    expect(canonicalModelId(parseModelId(id))).toBe(
      `${base}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`,
    );
  });
});

describe("advertised effort maps", () => {
  test("off prefers none, then bare default, otherwise is hidden", () => {
    expect(buildEffortMap(new Set(["none", "", "medium"])).off).toBe("none");
    expect(buildEffortMap(new Set(["", "medium"])).off).toBe("");
    expect(buildEffortMap(new Set(["low", "medium", "high"])).off).toBeNull();
    expect(buildThinkingLevelMap(buildEffortMap(new Set(["high"])))).toMatchObject({
      off: null, minimal: "high", high: "high", max: null,
    });
  });

  test("minimal is a real tier, not a suffix in the model family", () => {
    expect(buildEffortMap(new Set(["minimal", "low", "medium", "high"])).minimal).toBe("minimal");
    expect(resolveModelId("gemini-3.6-flash", "minimal")).toBe("gemini-3.6-flash-minimal");
  });

  test("xhigh prefers xhigh and extra-high before max; max requires actual max", () => {
    expect(buildEffortMap(new Set(["high", "xhigh", "extra-high", "max"]))).toMatchObject({
      xhigh: "xhigh", max: "max",
    });
    expect(buildEffortMap(new Set(["high", "extra-high", "max"]))).toMatchObject({
      xhigh: "extra-high", max: "max",
    });
    expect(buildEffortMap(new Set(["high", "max"]))).toMatchObject({ xhigh: "max", max: "max" });
    expect(buildEffortMap(new Set(["high", "xhigh"]))).toMatchObject({ xhigh: "xhigh", max: null });
    expect(buildEffortMap(new Set())).toEqual({});
  });

  test("real Pi hides off/max and preserves distinct Fable xhigh/max", () => {
    const fable = configured(processed.find((model) => model.id === "claude-fable-5-1-thinking")!);
    expect(getSupportedThinkingLevels(fable)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(fable.thinkingLevelMap).toMatchObject({ off: null, xhigh: "xhigh", max: "max" });
    const grok = configured(processed.find((model) => model.id === "cursor-grok-4.6")!);
    expect(getSupportedThinkingLevels(grok)).not.toContain("off");
    expect(getSupportedThinkingLevels(grok)).not.toContain("max");
  });
});

describe("exact catalog routing", () => {
  test.each(bundledModels)("preserves original raw ID $id", (raw) => {
    for (const effort of [undefined, ""]) expect(resolveModelId(raw.id, effort)).toBe(raw.id);
    const parsed = parseModelId(raw.id);
    expect(resolveModelId(canonicalModelId(parsed), parsed.effort)).toBe(raw.id);
    const rawConfig = modelConfig({ ...raw, supportsEffort: false });
    expect(rawConfig.id).toBe(raw.id);
    expect(rawConfig.compat.supportsReasoningEffort).toBe(false);
  });

  test.each(processed)("routes every canonical config and level for $id", (model) => {
    const config = configured(model);
    expect(rawIds.has(resolveModelId(config.id))).toBe(true);
    for (const level of LEVELS) {
      const resolved = resolveModelId(config.id, level);
      expect(rawIds.has(resolved), `${config.id}:${level} -> ${resolved}`).toBe(true);
      expect(canonicalModelId(parseModelId(resolved))).toBe(config.id);
      const mapped = config.thinkingLevelMap?.[level];
      if (typeof mapped === "string") {
        const exact = resolveModelId(config.id, mapped);
        expect(rawIds.has(exact)).toBe(true);
        expect(parseModelId(exact).effort).toBe(mapped);
      }
    }
  });

  test("retains both Cursor thinking orders and fast last", () => {
    expect(resolveModelId("claude-4.6-opus-thinking", "max")).toBe("claude-4.6-opus-max-thinking");
    expect(resolveModelId("claude-fable-5-1-thinking", "max")).toBe("claude-fable-5-1-thinking-max");
    expect(resolveModelId("claude-opus-4-8-thinking-fast", "xhigh")).toBe("claude-opus-4-8-thinking-xhigh-fast");
    expect(resolveModelId("gpt-5.5", "xhigh")).toBe("gpt-5.5-extra-high");
  });

  test("off transport fallback never invents IDs on mandatory effort models", () => {
    expect(resolveModelId("cursor-grok-4.6")).toBe("cursor-grok-4.6-medium");
    expect(resolveModelId("cursor-grok-4.6", "off")).toBe("cursor-grok-4.6-medium");
    expect(resolveModelId("claude-4.5-opus")).toBe("claude-4.5-opus-high");
    expect(resolveModelId("claude-4.5-opus", "none")).toBe("claude-4.5-opus-high");
    expect(resolveModelId("gpt-5.5", "off")).toBe("gpt-5.5-none");
    expect(resolveModelId("gpt-5.2", "off")).toBe("gpt-5.2");
  });

  test("an unsupported requested tier resolves only to an actual variant", () => {
    expect(resolveModelId("cursor-grok-4.6", "max")).toBe("cursor-grok-4.6-xhigh");
    expect(resolveModelId("claude-4.6-sonnet-thinking", "low")).toBe("claude-4.6-sonnet-medium-thinking");
    expect(resolveModelId("gpt-5.5", "not-an-effort")).toBe("gpt-5.5-medium");
  });

  test("old Grok 4.5 raw fixture is never changed to high-medium", () => {
    const ids = ["low", "medium", "high"].flatMap((effort) => [
      `cursor-grok-4.5-${effort}`, `cursor-grok-4.5-${effort}-fast`,
    ]);
    setModelRouting(ids);
    for (const id of ids) expect(resolveModelId(id)).toBe(id);
    expect(resolveModelId("cursor-grok-4.5-high", "low")).toBe("cursor-grok-4.5-low");
    expect(resolveModelId("cursor-grok-4.5-fast")).toBe("cursor-grok-4.5-medium-fast");
    expect(resolveModelId("cursor-grok-4.5", "xhigh")).toBe("cursor-grok-4.5-high");
  });

  test("replacing the catalog does not retain stale tiers", () => {
    setModelRouting(["test-model-low", "test-model-high"]);
    expect(resolveModelId("test-model", "high")).toBe("test-model-high");
    setModelRouting([{ id: "test-model-low" }]);
    expect(resolveModelId("test-model", "high")).toBe("test-model-low");
  });

  test("equivalent raw thinking orders preserve first advertised spelling", () => {
    const ids = ["test-model-thinking-high-fast", "test-model-high-thinking-fast"];
    setModelRouting(ids);
    const models = processModels(ids.map(fixture));
    expect(models.map((model) => model.id)).toEqual(["test-model-thinking-fast"]);
    expect(resolveModelId("test-model-thinking-fast", "high")).toBe(ids[0]);
    for (const id of ids) expect(resolveModelId(id)).toBe(id);
  });

  test("legacy external IDs still synthesize and Auto always ignores effort", () => {
    setModelRouting([]);
    expect(resolveModelId("gpt-5.1-codex-max", "high")).toBe("gpt-5.1-codex-max-high");
    expect(resolveModelId("gpt-5.1-codex-max-fast", "high")).toBe("gpt-5.1-codex-max-high-fast");
    expect(resolveModelId("cursor-grok-4.5")).toBe("cursor-grok-4.5-medium");
    expect(resolveModelId("cursor-grok-4.5-high")).toBe("cursor-grok-4.5-high");
    expect(resolveModelId("composer-2")).toBe("composer-2");
    for (const effort of [...LEVELS, undefined, ""]) expect(resolveModelId("default", effort)).toBe("default");
  });
});

describe("verified bundled catalog", () => {
  test.each(["sol", "terra", "luna"])("GPT 5.6 %s uses Cursor's documented default context", (variant) => {
    expect(inferContextWindow(`gpt-5.6-${variant}`)).toBe(272_000);
    expect(inferContextWindow(`gpt-5.6-${variant}-max-fast`)).toBe(272_000);
  });
  test("is the refreshed 183 variant catalog without invented Astra", () => {
    expect(bundledModels).toHaveLength(183);
    expect(rawIds.size).toBe(183);
    expect(FALLBACK_MODELS.map(({ id, name }) => ({ id, name }))).toEqual(
      bundledModels.map(({ id, name }) => ({ id, name })),
    );
    expect([...rawIds].some((id) => /astra/i.test(id))).toBe(false);
    expect(rawIds.has("cursor-grok-4.6-high")).toBe(true);
    expect(rawIds.has("cursor-grok-4.5-high")).toBe(false);
  });

  test("preserves Fable NO ZDR names without stripping the warning", () => {
    const raw = bundledModels.filter((model) => model.id.startsWith("claude-fable-5-1"));
    const deduped = processed.filter((model) => model.id.startsWith("claude-fable-5-1"));
    expect(raw).toHaveLength(10);
    expect(deduped).toHaveLength(2);
    for (const model of [...raw, ...deduped]) expect(model.name).toContain("(NO ZDR)");
    for (const model of deduped) {
      expect(raw.some((entry) => entry.name === modelConfig(model).name)).toBe(true);
    }
  });

  test("GLM derives reasoning from its advertised effort variants", () => {
    const glm = processed.find((model) => model.id === "glm-5.2")!;
    expect(glm.supportsEffort).toBe(true);
    expect(modelConfig(glm).reasoning).toBe(true);
    expect(modelConfig(glm).thinkingLevelMap).toMatchObject({ off: null, high: "high", max: "max" });
  });
});

describe("Pi serialization with offline fixture transport", () => {
  test.each(processed)("serialized levels resolve to real variants for $id", async (model) => {
    const config = configured(model);
    // Include omitted effort: older Pi/SDK callers may not serialize an off value.
    for (const level of [undefined, ...getSupportedThinkingLevels(config)]) {
      let payload: Record<string, unknown> | undefined;
      const result = await streamSimple(config, {
        messages: [{ role: "user", content: "fixture", timestamp: 0 }],
      }, {
        apiKey: "test",
        reasoning: level === "off" ? undefined : level,
        maxTokens: 16,
        onPayload(value) { payload = value as Record<string, unknown>; },
        fetch: async () => new Response(
          `data: ${JSON.stringify({
            id: "fixture", object: "chat.completion.chunk", created: 0, model: config.id,
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      }).result();
      expect(result.stopReason).toBe("stop");
      expect(payload).toBeDefined();
      const resolved = resolveModelId(String(payload!.model), payload!.reasoning_effort as string | undefined);
      expect(rawIds.has(resolved), `${config.id}:${level} -> ${resolved}`).toBe(true);
      expect(canonicalModelId(parseModelId(resolved))).toBe(config.id);
      const mapped = level === undefined ? undefined : config.thinkingLevelMap?.[level];
      if (typeof mapped === "string") expect(parseModelId(resolved).effort).toBe(mapped);
    }
  });
});
