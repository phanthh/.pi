/**
 * Cursor Provider Extension for pi
 *
 * Provides access to Cursor models (Claude, GPT, Gemini, etc.) via:
 * 1. Browser-based PKCE OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 *
 * Usage:
 *   /login cursor    — authenticate via browser
 *   /model           — select any Cursor model
 */

import rawFallbackModels from "./cursor-models-raw.json" with { type: "json" };
import {
  buildEffortMap,
  canonicalModelId,
  parseModelId,
  setModelRouting,
  type EffortMap,
} from "./model-ids.ts";
export { buildEffortMap, parseModelId, type ParsedModelId } from "./model-ids.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { appendPrivateLog } from "./secure-log.ts";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth.ts";
import {
  CURSOR_NATIVE_TOOL_POLICY,
  cleanupSessionState,
  getCursorModels,
  getProxyAuthToken,
  inferContextWindow,
  loadCachedModels,
  startProxy,
  stopProxy,
  type CursorModel,
} from "./proxy.ts";

// ── Cost estimation ──

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

let extensionDebugLogFilePath: string | undefined;

function isExtensionDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function getExtensionDebugLogFilePath(): string {
  if (extensionDebugLogFilePath) return extensionDebugLogFilePath;
  const configured =
    process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE?.trim();
  if (configured) {
    extensionDebugLogFilePath = configured;
    return extensionDebugLogFilePath;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  extensionDebugLogFilePath = pathJoin(
    tmpdir(),
    `pi-cursor-auth-extension-debug-${stamp}-${process.pid}.log`,
  );
  return extensionDebugLogFilePath;
}

function truncateDebugValue(value: string, max = 240): string {
  return value.length > max
    ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>`
    : value;
}

function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") return truncateDebugValue(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as Record<string, unknown>;
    switch (typed.type) {
      case "text":
        return {
          type: "text",
          text: truncateDebugValue(String(typed.text ?? "")),
        };
      case "thinking":
        return {
          type: "thinking",
          thinking: truncateDebugValue(String(typed.thinking ?? "")),
        };
      case "toolCall":
        return {
          type: "toolCall",
          id: typed.id,
          name: typed.name,
          arguments: typed.arguments,
        };
      case "image":
        return {
          type: "image",
          mimeType: typed.mimeType,
          data: `<redacted base64 ${String(typed.data ?? "").length} chars>`,
        };
      default:
        return typed;
    }
  });
}

function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const typed = message as Record<string, unknown>;
  return {
    role: typed.role,
    stopReason: typed.stopReason,
    toolCallId: typed.toolCallId,
    toolName: typed.toolName,
    isError: typed.isError,
    errorMessage: typed.errorMessage,
    content: summarizeContent(typed.content),
  };
}

function summarizeBranchTail(
  ctx: {
    sessionManager?: {
      getBranch?: () => unknown[];
      getLeafId?: () => string | null;
      getSessionId?: () => string;
    };
  },
  limit = 6,
): unknown {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    return {
      sessionId: ctx.sessionManager?.getSessionId?.(),
      leafId: ctx.sessionManager?.getLeafId?.(),
      size: branch.length,
      tail: branch.slice(-limit).map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const typed = entry as Record<string, unknown>;
        return {
          type: typed.type,
          id: typed.id,
          parentId: typed.parentId,
          customType: typed.customType,
          message: summarizeMessage(typed.message),
        };
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeProviderPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const typed = payload as Record<string, unknown>;
  const messages = Array.isArray(typed.messages)
    ? typed.messages.map((message) => summarizeMessage(message)).slice(-8)
    : undefined;
  return {
    model: typed.model,
    stream: typed.stream,
    pi_session_id: typed.pi_session_id,
    messageCount: Array.isArray(typed.messages)
      ? typed.messages.length
      : undefined,
    messages,
    toolCount: Array.isArray(typed.tools) ? typed.tools.length : undefined,
  };
}

let cursorSessionInstructions: string | undefined;

function getCursorSessionInstructions(): string {
  if (cursorSessionInstructions) return cursorSessionInstructions;
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? pathJoin(homedir(), ".pi", "agent");
  const agentsInstructions = readFileSync(
    pathJoin(agentDir, "AGENTS.md"),
    "utf8",
  ).trim();
  cursorSessionInstructions = `${CURSOR_NATIVE_TOOL_POLICY}\n\n<pi_agents_md>\n${agentsInstructions}\n</pi_agents_md>`;
  return cursorSessionInstructions;
}

const CURSOR_SESSION_INSTRUCTIONS_TYPE = "cursor-session-instructions";
const INJECTED_CONTEXT_MESSAGE_EVENT = "pi:context-message-injected";

function hasCursorSessionInstructions(messages: readonly unknown[]): boolean {
  return messages.some(
    (message) =>
      !!message &&
      typeof message === "object" &&
      "role" in message &&
      message.role === "custom" &&
      "customType" in message &&
      message.customType === CURSOR_SESSION_INSTRUCTIONS_TYPE,
  );
}

function debugExtensionLog(
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!isExtensionDebugEnabled()) return;
  try {
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      scope: "extension",
      event,
      ...data,
    });
    appendPrivateLog(getExtensionDebugLogFilePath(), `${payload}\n`);
  } catch {
    console.error("[pi-cursor-auth] Cannot safely write extension debug log");
  }
}

const MODEL_COST_TABLE: Record<string, ModelCost> = {
  // Cursor public model cards, checked 2026-09-05. Base-tier estimates only;
  // usage scaling, long-context premiums, and account surcharges are separate.
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5-fast": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  "gpt-5.6-sol-fast": { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-terra-fast": { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "gpt-5.6-luna-fast": { input: 0.4, output: 2.4, cacheRead: 0.04, cacheWrite: 0.5 },
  "cursor-grok-4.6": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  "cursor-grok-4.6-fast": { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
  "composer-2.5": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "composer-2.5-fast": { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 },
  "gemini-3.8-flash": { input: 0.75, output: 3.5, cacheRead: 0.075, cacheWrite: 0 },
  "claude-4-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.5-haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-4.5-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.5-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-4.6-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.6-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-4.7-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.8-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "composer-1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "composer-1.5": { input: 3.5, output: 17.5, cacheRead: 0.35, cacheWrite: 0 },
  "composer-2": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-2.5-flash": {
    input: 0.3,
    output: 2.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-fast": { input: 2.5, output: 20, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "cursor-grok-4.5": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  "cursor-grok-4.5-fast": { input: 4, output: 18, cacheRead: 1, cacheWrite: 0 },
  "grok-4.20": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4-3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "grok-build-0.1": { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
};

const MODEL_COST_PATTERNS: Array<{
  match: (id: string) => boolean;
  cost: ModelCost;
}> = [
  {
    match: (id) => /claude.*opus.*fast/i.test(id),
    cost: { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 },
  },
  {
    match: (id) => /claude.*opus/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-opus"]!,
  },
  {
    match: (id) => /claude.*haiku/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.5-haiku"]!,
  },
  {
    match: (id) => /claude.*sonnet/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-sonnet"]!,
  },
  {
    match: (id) => /composer/i.test(id),
    cost: MODEL_COST_TABLE["composer-1"]!,
  },
  {
    match: (id) => /gpt-5\.5/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.5"]!,
  },
  {
    match: (id) => /gpt-5\.4.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-mini"]!,
  },
  {
    match: (id) => /gpt-5\.4.*nano/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-nano"]!,
  },
  { match: (id) => /gpt-5\.4/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4"]! },
  {
    match: (id) => /gpt-5\.3/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.3-codex"]!,
  },
  { match: (id) => /gpt-5\.2/i.test(id), cost: MODEL_COST_TABLE["gpt-5.2"]! },
  {
    match: (id) => /gpt-5.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5-mini"]!,
  },
  { match: (id) => /gpt-5/i.test(id), cost: MODEL_COST_TABLE["gpt-5"]! },
  {
    match: (id) => /gemini.*3\.1/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3.1-pro"]!,
  },
  {
    match: (id) => /gemini.*flash/i.test(id),
    cost: MODEL_COST_TABLE["gemini-2.5-flash"]!,
  },
  {
    match: (id) => /gemini/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3-pro"]!,
  },
  { match: (id) => /grok/i.test(id), cost: MODEL_COST_TABLE["grok-4.20"]! },
  { match: (id) => /kimi/i.test(id), cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 0,
};

export function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const parsed = parseModelId(normalized);
  // Thinking and effort do not change the public base-tier rate; Fast can.
  const priceId = `${parsed.base}${parsed.fast ? "-fast" : ""}`;
  const exact = MODEL_COST_TABLE[normalized] ?? MODEL_COST_TABLE[priceId];
  if (exact) return exact;
  const stripped = normalized.replace(
    /-(high|medium|low|preview|thinking|spark-preview|fast)$/g,
    "",
  );
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return (
    MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST
  );
}

// ── Effort-level dedup ──

interface ProcessedModel extends CursorModel {
  supportsEffort: boolean;
  effortMap?: EffortMap;
}

export function supportsReasoningModelId(id: string): boolean {
  const { base, effort, thinking } = parseModelId(id);
  if (effort || thinking) return true;
  // Cursor Auto picks the backend model itself; it has no reasoning-effort suffix.
  if (base === "default") return false;
  return /^(claude|composer|cursor-grok|gemini|gpt|grok|kimi)(-|$)/i.test(base);
}

/** Map pi thinking levels to advertised Cursor suffixes, hiding unsupported off/max. */
export function buildThinkingLevelMap(effortMap: EffortMap): EffortMap {
  const fallback = effortMap.medium ?? effortMap.low ?? effortMap.high ?? null;
  return {
    off: effortMap.off ?? null,
    minimal: effortMap.minimal ?? fallback,
    low: effortMap.low ?? fallback,
    medium: effortMap.medium ?? fallback,
    high: effortMap.high ?? fallback,
    xhigh: effortMap.xhigh ?? null,
    max: effortMap.max ?? null,
  };
}

/** Dedup raw models: collapse effort variants into one entry with supportsReasoningEffort. */
export function processModels(raw: CursorModel[]): ProcessedModel[] {
  // Group by (base, fast, thinking)
  const groups = new Map<
    string,
    {
      base: string;
      fast: boolean;
      thinking: boolean;
      efforts: Map<string, CursorModel>;
    }
  >();

  for (const model of raw) {
    const p = parseModelId(model.id);
    const key = `${p.base}|${p.fast}|${p.thinking}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        base: p.base,
        fast: p.fast,
        thinking: p.thinking,
        efforts: new Map(),
      };
      groups.set(key, g);
    }
    g.efforts.set(p.effort, model);
  }

  const result: ProcessedModel[] = [];

  for (const g of groups.values()) {
    // Dedup when there are multiple effort variants, OR a single variant
    // whose effort is non-empty (e.g. claude-4.5-opus-high — strip the
    // mandatory effort suffix so the model appears as claude-4.5-opus
    // with effort mapping).
    const hasOnlyEffortVariants = g.efforts.size === 1 && !g.efforts.has("");
    if (g.efforts.size >= 2 || hasOnlyEffortVariants) {
      // Pick representative: prefer "medium" or default ("") for name/metadata
      const rep =
        g.efforts.get("medium") ??
        g.efforts.get("") ??
        [...g.efforts.values()][0]!;

      // Build deduped model ID: base + thinking/fast suffix (no effort)
      const id = canonicalModelId({ ...g, effort: "" });

      const effortMap = buildEffortMap(new Set(g.efforts.keys()));

      result.push({ ...rep, id, supportsEffort: true, effortMap });
    } else {
      // Keep single entries as-is (base model without effort variants)
      for (const model of g.efforts.values()) {
        result.push({ ...model, supportsEffort: false });
      }
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function modelConfig(m: ProcessedModel) {
  const reasoning = m.supportsEffort || supportsReasoningModelId(m.id);
  const thinkingLevelMap =
    m.supportsEffort && m.effortMap
      ? buildThinkingLevelMap(m.effortMap)
      : undefined;

  return {
    id: m.id,
    name: m.name,
    reasoning,
    ...(thinkingLevelMap && { thinkingLevelMap }),
    input: ["text", "image"] as ("text" | "image")[],
    cost: estimateModelCost(m.id),
    contextWindow: inferContextWindow(m.id),
    maxTokens: m.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: m.supportsEffort,
      maxTokensField: "max_tokens" as const,
    },
  };
}

export const FALLBACK_MODELS: CursorModel[] = (
  rawFallbackModels as CursorModel[]
).map((model) => ({
  ...model,
  reasoning: supportsReasoningModelId(model.id),
}));

// ── Extension ──

export function registerSessionLifecycleCleanup(pi: ExtensionAPI): void {
  const cleanupCurrentSession = (
    _event: unknown,
    ctx: {
      sessionManager: { getSessionId(): string; getLeafId?: () => string | null };
    },
  ) => {
    debugExtensionLog("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    cleanupSessionState(ctx.sessionManager.getSessionId());
  };

  pi.on("session_before_switch", cleanupCurrentSession);
  pi.on("session_before_fork", cleanupCurrentSession);
  pi.on("session_before_tree", cleanupCurrentSession);
  pi.on("session_shutdown", cleanupCurrentSession);

  // After pi compacts its message list, keep the checkpoint intact.
  // The checkpoint is the only thing that gives Cursor memory of prior turns;
  // clearing it forces a rebuild from turns, which Cursor's server silently
  // ignores (it doesn't fetch turn blobs from a synthetic state).  The
  // checkpoint already reflects the full server-side conversation and remains
  // valid regardless of what pi compacted locally.
  pi.on("session_compact", (_event, ctx) => {
    debugExtensionLog("session.post_compact_noop", {
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });
}

function registerExtensionDebugHooks(pi: ExtensionAPI) {
  if (!isExtensionDebugEnabled()) return;

  pi.on("message_start", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.start", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
    });
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      message?: unknown;
      assistantMessageEvent?: Record<string, unknown>;
    };
    debugExtensionLog("message.update", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      assistantMessageEvent: typedEvent.assistantMessageEvent
        ? {
            type: typedEvent.assistantMessageEvent.type,
            delta: truncateDebugValue(
              String(
                (typedEvent.assistantMessageEvent as Record<string, unknown>)
                  .delta ??
                  (typedEvent.assistantMessageEvent as Record<string, unknown>)
                    .content ??
                  "",
              ),
            ),
          }
        : undefined,
      message: summarizeMessage(typedEvent.message),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { messages?: unknown[] };
    debugExtensionLog("context", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      messageCount: Array.isArray(typedEvent.messages)
        ? typedEvent.messages.length
        : undefined,
      messages: Array.isArray(typedEvent.messages)
        ? typedEvent.messages
            .slice(-8)
            .map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      turnIndex?: number;
      message?: unknown;
      toolResults?: unknown[];
    };
    debugExtensionLog("turn.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      turnIndex: typedEvent.turnIndex,
      message: summarizeMessage(typedEvent.message),
      toolResults: Array.isArray(typedEvent.toolResults)
        ? typedEvent.toolResults.map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  debugExtensionLog("extension.debug_hooks_registered", {
    logFile: getExtensionDebugLogFilePath(),
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Current access token, updated by login/refresh/getApiKey
  let currentToken = "";
  // Keep the live object: another extension may cap its context window after
  // this handler runs. Async model discovery must preserve that cap when it
  // replaces Cursor's provider catalog.
  let selectedCursorModel:
    | { id: string; contextWindow: number }
    | undefined;
  let stopped = false;
  function assertRunning(): void {
    if (stopped) throw new Error("Cursor provider has shut down");
  }

  // Start proxy eagerly — it just binds a port, no auth needed until a request arrives.
  // The getAccessToken callback reads currentToken at request time.
  const proxyReady = startProxy(async () => {
    if (!currentToken)
      throw new Error("Not logged in to Cursor. Run /login cursor");
    return currentToken;
  });

  const skipDedup = !!process.env.PI_CURSOR_RAW_MODELS;

  registerSessionLifecycleCleanup(pi);
  pi.on("session_start", (_event, ctx) => {
    selectedCursorModel =
      ctx.model?.provider === "cursor" ? ctx.model : undefined;
  });
  pi.on("model_select", (event) => {
    selectedCursorModel =
      event.model.provider === "cursor" ? event.model : undefined;
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    currentToken = "";
    selectedCursorModel = undefined;
    stopProxy();
  });
  registerExtensionDebugHooks(pi);
  debugExtensionLog("extension.start", {
    debugLogFile: isExtensionDebugEnabled()
      ? getExtensionDebugLogFilePath()
      : undefined,
  });

  // Cursor does not reliably honor Pi's root system-prompt blob. Repeat Pi's
  // AGENTS.md with the native-tool policy as a hidden extension message on
  // every Cursor conversation, including extension-generated continuations.
  pi.on("context", (event, ctx) => {
    if (
      ctx.model?.provider !== "cursor" ||
      hasCursorSessionInstructions(event.messages)
    ) {
      return;
    }
    const message = {
      role: "custom" as const,
      customType: CURSOR_SESSION_INSTRUCTIONS_TYPE,
      content: getCursorSessionInstructions(),
      display: false,
      timestamp: Date.now(),
    };
    pi.events.emit(INJECTED_CONTEXT_MESSAGE_EVENT, message);
    return { messages: [message, ...event.messages] };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && ctx.model?.provider === "cursor") {
      payload.pi_session_id = ctx.sessionManager.getSessionId();
      debugExtensionLog("before_provider_request", {
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId?.(),
        model: ctx.model?.id,
        payload: summarizeProviderPayload(payload),
        branch: summarizeBranchTail(ctx),
      });
    }
    return payload;
  });

  // Await proxy so models are registered before pi proceeds with model resolution.
  // Prefer the on-disk cache from the last successful discovery so a fresh
  // process registers current models (e.g. Opus 4.8) synchronously — before Pi
  // resolves enabledModels — instead of the stale bundled snapshot.
  const port = await proxyReady;
  register(pi, port, loadCachedModels() ?? FALLBACK_MODELS);

  // Discovery only happens on OAuth login/refresh, which may not fire when a
  // stored token is still valid. Trigger it once as soon as we have a token so
  // the model list refreshes every session, not just on auth changes.
  let startupDiscoveryDone = false;
  async function ensureStartupDiscovery(token: string): Promise<void> {
    if (stopped || startupDiscoveryDone || !token) return;
    startupDiscoveryDone = true;
    try {
      const discovered = await getCursorModels(token);
      if (discovered.length > 0) register(pi, await proxyReady, discovered);
    } catch {
      startupDiscoveryDone = false;
    }
  }

  function register(pi: ExtensionAPI, port: number, rawModels: CursorModel[]) {
    if (stopped) return;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const processed = skipDedup
      ? rawModels.map(
          (m) => ({ ...m, supportsEffort: false }) as ProcessedModel,
        )
      : processModels(rawModels);

    setModelRouting(rawModels);
    pi.registerProvider("cursor", {
      baseUrl,
      api: "openai-completions",
      models: processed.map((model) => {
        const config = modelConfig(model);
        if (selectedCursorModel?.id !== config.id) return config;
        return {
          ...config,
          contextWindow: Math.min(
            config.contextWindow,
            selectedCursorModel.contextWindow,
          ),
        };
      }),
      oauth: {
        name: "Cursor",

        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          assertRunning();
          const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
          assertRunning();
          callbacks.onAuth({ url: loginUrl });
          const { accessToken, refreshToken } = await pollCursorAuth(
            uuid,
            verifier,
          );
          assertRunning();
          currentToken = accessToken;

          // Discover real models and re-register
          const realPort = await proxyReady;
          assertRunning();
          const discovered = await getCursorModels(accessToken);
          assertRunning();
          if (discovered.length > 0) register(pi, realPort, discovered);

          return {
            refresh: refreshToken,
            access: accessToken,
            expires: getTokenExpiry(accessToken),
          };
        },

        async refreshToken(
          credentials: OAuthCredentials,
        ): Promise<OAuthCredentials> {
          assertRunning();
          const refreshed = await refreshCursorToken(credentials.refresh);
          assertRunning();
          currentToken = refreshed.access;

          // Discover real models on refresh too
          const realPort = await proxyReady;
          assertRunning();
          const discovered = await getCursorModels(refreshed.access);
          assertRunning();
          if (discovered.length > 0) register(pi, realPort, discovered);

          return refreshed;
        },

        getApiKey(credentials: OAuthCredentials): string {
          assertRunning();
          currentToken = credentials.access;
          void ensureStartupDiscovery(credentials.access);
          return getProxyAuthToken();
        },
      },
    });
  }
}
