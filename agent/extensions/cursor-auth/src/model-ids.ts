import rawFallbackModels from "./cursor-models-raw.json" with { type: "json" };

export interface ParsedModelId {
  base: string;
  effort: string;
  fast: boolean;
  thinking: boolean;
}

// Match extra-high atomically, not as a base ending in extra plus high effort.
const EFFORT_SUFFIX = /-(extra-high|minimal|none|low|medium|high|xhigh|max)$/;

/** Parse both effort-thinking and thinking-effort, with optional fast last. */
export function parseModelId(id: string): ParsedModelId {
  let base = id;
  const fast = base.endsWith("-fast");
  if (fast) base = base.slice(0, -5);
  let thinking = base.endsWith("-thinking");
  if (thinking) base = base.slice(0, -9);

  // codex-max is a model family, not a max effort variant of codex.
  const match = base.endsWith("-codex-max") ? null : EFFORT_SUFFIX.exec(base);
  const effort = match?.[1] ?? "";
  if (match) base = base.slice(0, -match[0].length);
  if (!thinking && base.endsWith("-thinking")) {
    thinking = true;
    base = base.slice(0, -9);
  }
  return { base, effort, fast, thinking };
}

/** The picker has a stable order even when Cursor's raw suffix order differs. */
export function canonicalModelId(model: ParsedModelId): string {
  return `${model.base}${model.thinking ? "-thinking" : ""}${model.fast ? "-fast" : ""}`;
}

export type EffortMap = Record<string, string | null>;

const EFFORT_ORDER = [
  "none", "minimal", "low", "", "medium", "high", "xhigh", "extra-high", "max",
] as const;

/** Values are advertised suffixes. Null means the UI must hide that level. */
export function buildEffortMap(efforts: ReadonlySet<string>): EffortMap {
  const lowest = EFFORT_ORDER.find((effort) => efforts.has(effort));
  if (lowest === undefined) return {};
  const pick = (...targets: string[]): string =>
    targets.find((target) => efforts.has(target)) ?? lowest;

  return {
    off: efforts.has("none") ? "none" : efforts.has("") ? "" : null,
    minimal: pick("minimal", "none", "low", ""),
    low: pick("low", "minimal", "none", ""),
    medium: pick("medium", "", "low"),
    high: pick("high", "medium", ""),
    xhigh: pick("xhigh", "extra-high", "max", "high"),
    max: efforts.has("max") ? "max" : null,
  };
}

interface ModelRoute {
  variants: Map<string, string>;
  effortMap: EffortMap;
}

let rawModelIds = new Set<string>();
let modelRoutes = new Map<string, ModelRoute>();

/** Replace the registry on discovery; never keep stale variants from a prior catalog. */
export function setModelRouting(models: readonly (string | { id: string })[]): void {
  const ids = new Set<string>();
  const routes = new Map<string, ModelRoute>();
  for (const model of models) {
    const id = typeof model === "string" ? model : model.id;
    const parsed = parseModelId(id);
    const canonical = canonicalModelId(parsed);
    ids.add(id);
    let route = routes.get(canonical);
    if (!route) {
      route = { variants: new Map(), effortMap: {} };
      routes.set(canonical, route);
    }
    // Preserve the first advertised spelling if Cursor supplies equivalent orders.
    if (!route.variants.has(parsed.effort)) route.variants.set(parsed.effort, id);
  }
  for (const route of routes.values()) {
    route.effortMap = buildEffortMap(new Set(route.variants.keys()));
  }
  rawModelIds = ids;
  modelRoutes = routes;
}

/** Resolve known models to exact advertised IDs, never synthesized variants. */
export function resolveModelId(model: string, reasoningEffort?: string): string {
  if (model === "default") return model;
  // Raw mode must preserve even mandatory effort tiers without appending medium.
  if (!reasoningEffort && rawModelIds.has(model)) return model;

  const parsed = parseModelId(model);
  const route = modelRoutes.get(model) ?? modelRoutes.get(canonicalModelId(parsed));
  if (route) {
    if (reasoningEffort !== undefined && route.variants.has(reasoningEffort)) {
      return route.variants.get(reasoningEffort)!;
    }
    let mapped = reasoningEffort ? route.effortMap[reasoningEffort] : undefined;
    if (reasoningEffort === "none") mapped = route.effortMap.off;
    if (reasoningEffort === "extra-high") mapped = route.effortMap.xhigh;
    if (reasoningEffort === "max") mapped = route.effortMap.max ?? route.effortMap.xhigh;
    if (typeof mapped === "string" && route.variants.has(mapped)) {
      return route.variants.get(mapped)!;
    }
    // Missing/off transport values still need an actual tier on always-thinking
    // models. This fallback is deliberately separate from the UI's off:null.
    return route.variants.get("")
      ?? route.variants.get("medium")
      ?? route.variants.get(route.effortMap.medium ?? "")
      ?? route.variants.values().next().value!;
  }

  // Keep legacy synthesis for externally supplied IDs absent from the catalog.
  if (parsed.base === "default") return model;
  if (!reasoningEffort) {
    if (parsed.effort || !/^cursor-grok/i.test(parsed.base)) return model;
    reasoningEffort = "medium";
  }
  return `${parsed.base}-${reasoningEffort}${parsed.thinking ? "-thinking" : ""}${parsed.fast ? "-fast" : ""}`;
}

setModelRouting(rawFallbackModels);
