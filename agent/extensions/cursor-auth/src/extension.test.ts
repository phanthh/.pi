import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  tokenReader: undefined as undefined | (() => Promise<string>),
  stop: vi.fn(),
  discovery: vi.fn(),
  params: vi.fn(),
  poll: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./auth.ts", async () => ({
  ...await vi.importActual<typeof import("./auth.ts")>("./auth.ts"),
  generateCursorAuthParams: state.params,
  pollCursorAuth: state.poll,
  refreshCursorToken: state.refresh,
}));
vi.mock("./proxy.ts", async () => {
  const original = await vi.importActual<typeof import("./proxy.ts")>("./proxy.ts");
  return {
    ...original,
    startProxy: vi.fn(async (reader: () => Promise<string>) => { state.tokenReader = reader; return 12345; }),
    stopProxy: state.stop,
    getProxyAuthToken: () => "synthetic-local-bearer",
    loadCachedModels: () => null,
    getCursorModels: state.discovery,
    cleanupSessionState: vi.fn(),
  };
});
import extension, { estimateModelCost } from "./index.ts";
import { CURSOR_NATIVE_TOOL_POLICY } from "./proxy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("verified Cursor price estimates", () => {
  test.each([
    ["claude-fable-5-1-thinking-max", 10, 50, 0.25, 12.5],
    ["claude-opus-5-thinking-high-fast", 10, 50, 1, 12.5],
    ["claude-sonnet-5-high", 2, 10, 0.2, 2.5],
    ["gpt-5.6-sol-medium-fast", 8, 40, 0.8, 10],
    ["gpt-5.6-terra-high", 2, 12, 0.2, 2.5],
    ["gpt-5.6-luna-xhigh", 0.2, 1.2, 0.02, 0.25],
    ["cursor-grok-4.5-high-fast", 4, 18, 1, 0],
    ["cursor-grok-4.6-xhigh-fast", 4, 12, 1, 0],
    ["composer-2.5-fast", 3, 15, 0.5, 0],
    ["gemini-3.8-flash-high", 0.75, 3.5, 0.075, 0],
  ] as const)("uses documented base rates for %s", (id, input, output, cacheRead, cacheWrite) => {
    expect(estimateModelCost(id)).toEqual({ input, output, cacheRead, cacheWrite });
  });
});

describe("extension shutdown authentication lifecycle", () => {
  async function setup() {
    const callbacks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const registrations: any[] = [];
    const emitted: Array<{ channel: string; data: unknown }> = [];
    await extension({
      on(name: string, callback: (event: unknown, ctx: unknown) => unknown) {
        callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
      },
      registerProvider(_name: string, config: unknown) { registrations.push(config); },
      events: {
        emit(channel: string, data: unknown) { emitted.push({ channel, data }); },
      },
    } as unknown as ExtensionAPI);
    return {
      callbacks,
      emitted,
      oauth: registrations[0].oauth,
      registrations,
      async shutdown() {
        for (const callback of callbacks.get("session_shutdown") ?? []) {
          await callback({}, { sessionManager: { getSessionId: () => "synthetic-session" } });
        }
      },
    };
  }

  test("injects Pi AGENTS.md and native-tool policy as a hidden extension message only for Cursor", async () => {
    const { callbacks, emitted } = await setup();
    expect(callbacks.has("before_agent_start")).toBe(false);
    const context = callbacks.get("context")![0]!;
    const messages = [
      { role: "user", content: "Do the task", timestamp: 1 },
    ];

    const result = await context(
      { messages },
      { model: { provider: "cursor" } },
    ) as {
      messages: Array<{
        role: string;
        customType?: string;
        content: string;
        display?: boolean;
      }>;
    };
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      role: "custom",
      customType: "cursor-session-instructions",
      display: false,
    });
    expect(result.messages[0]?.content).toContain(CURSOR_NATIVE_TOOL_POLICY);
    expect(result.messages[0]?.content).toContain("<pi_agents_md>");
    expect(result.messages[0]?.content).toContain("Caveman speech");
    expect(result.messages[0]?.content).toContain("Ponytail mindset");
    expect(result.messages[1]).toEqual(messages[0]);
    expect(emitted).toEqual([{
      channel: "pi:context-message-injected",
      data: result.messages[0],
    }]);
    expect(
      await context(
        { messages: result.messages },
        { model: { provider: "cursor" } },
      ),
    ).toBeUndefined();
    expect(
      await context(
        { messages },
        { model: { provider: "anthropic" } },
      ),
    ).toBeUndefined();
  });

  test.each(["login", "refresh"])("pending %s cannot restore credentials after shutdown", async (method) => {
    let finish!: (credentials: unknown) => void;
    const pendingAuth = new Promise(resolve => { finish = resolve; });
    (method === "login" ? state.poll : state.refresh).mockReturnValue(pendingAuth);
    const { oauth, shutdown, registrations } = await setup();
    const pending = method === "login"
      ? oauth.login({ onAuth: vi.fn() })
      : oauth.refreshToken({ refresh: "synthetic-refresh" });
    const rejected = expect(pending).rejects.toThrow("shut down");
    await new Promise(resolve => setImmediate(resolve));
    await shutdown();
    finish({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 60000 });
    await rejected;
    await expect(state.tokenReader!()).rejects.toThrow("Not logged in");
    expect(state.discovery).not.toHaveBeenCalled();
    expect(registrations).toHaveLength(1);
  });

  test.each(["login", "refresh"])("%s cannot return successful auth after shutdown during discovery", async (method) => {
    state.poll.mockResolvedValue({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" });
    state.refresh.mockResolvedValue({ access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 60000 });
    let finish!: (models: unknown[]) => void;
    state.discovery.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { oauth, shutdown, registrations } = await setup();
    const pending = method === "login"
      ? oauth.login({ onAuth: vi.fn() })
      : oauth.refreshToken({ refresh: "synthetic-refresh" });
    const rejected = expect(pending).rejects.toThrow("shut down");
    await new Promise(resolve => setImmediate(resolve));
    expect(state.discovery).toHaveBeenCalledOnce();
    await shutdown();
    finish([]);
    await rejected;
    await expect(state.tokenReader!()).rejects.toThrow("Not logged in");
    expect(registrations).toHaveLength(1);
  });

  test("rejects new login and refresh operations after shutdown", async () => {
    const { oauth, shutdown } = await setup();
    await shutdown();
    await expect(oauth.login({ onAuth: vi.fn() })).rejects.toThrow("shut down");
    await expect(oauth.refreshToken({ refresh: "synthetic-refresh" })).rejects.toThrow("shut down");
    expect(state.params).not.toHaveBeenCalled();
    expect(state.poll).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.discovery).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    state.stop.mockReset();
    state.discovery.mockReset();
    state.params.mockReset().mockResolvedValue({ verifier: "fixture", uuid: "fixture", loginUrl: "https://fixture.invalid/login" });
    state.poll.mockReset();
    state.refresh.mockReset();
    state.tokenReader = undefined;
  });

  test("preserves the selected model's runtime context cap during discovery", async () => {
    let finishDiscovery!: (models: unknown[]) => void;
    state.discovery.mockReturnValue(new Promise(resolve => { finishDiscovery = resolve; }));
    const { callbacks, oauth, registrations } = await setup();
    const selectedModel = {
      provider: "cursor",
      id: "gemini-fixture",
      contextWindow: 1_048_576,
    };

    for (const callback of callbacks.get("session_start") ?? []) {
      await callback({}, { model: selectedModel });
    }
    selectedModel.contextWindow = 250_000;
    expect(oauth.getApiKey({ access: "synthetic-upstream-credential" })).toBe("synthetic-local-bearer");
    finishDiscovery([{
      id: "gemini-fixture",
      name: "Gemini Fixture",
      reasoning: false,
      contextWindow: 1_048_576,
      maxTokens: 64_000,
    }]);
    await new Promise(resolve => setImmediate(resolve));

    expect(registrations).toHaveLength(2);
    expect(registrations[1].models).toContainEqual(
      expect.objectContaining({ id: "gemini-fixture", contextWindow: 250_000 }),
    );
  });

  test("clears the token, stops the proxy, and suppresses late discovery registration", async () => {
    let finishDiscovery!: (models: unknown[]) => void;
    state.discovery.mockReturnValue(new Promise(resolve => { finishDiscovery = resolve; }));
    const callbacks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const registrations: any[] = [];
    await extension({
      on(name: string, callback: (event: unknown, ctx: unknown) => unknown) {
        callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
      },
      registerProvider(_name: string, config: unknown) { registrations.push(config); },
    } as unknown as ExtensionAPI);
    const oauth = registrations[0].oauth;
    await expect(state.tokenReader!()).rejects.toThrow("Not logged in");
    expect(oauth.getApiKey({ access: "synthetic-upstream-credential" })).toBe("synthetic-local-bearer");
    expect(await state.tokenReader!()).toBe("synthetic-upstream-credential");
    for (const callback of callbacks.get("session_shutdown") ?? []) {
      await callback({}, { sessionManager: { getSessionId: () => "synthetic-session" } });
    }
    expect(state.stop).toHaveBeenCalledOnce();
    await expect(state.tokenReader!()).rejects.toThrow("Not logged in");
    expect(() => oauth.getApiKey({ access: "synthetic-late-credential" })).toThrow("shut down");
    finishDiscovery([{ id: "late-model", name: "Late", reasoning: false, contextWindow: 200000, maxTokens: 64000 }]);
    await new Promise(resolve => setImmediate(resolve));
    expect(registrations).toHaveLength(1);
  });
});
