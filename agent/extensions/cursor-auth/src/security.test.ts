import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  McpArgsSchema,
  SetBlobArgsSchema,
  TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema,
  type AgentServerMessage,
} from "./proto/agent_pb.ts";
import { connect } from "node:net";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testInternals,
  cleanupAllSessionState,
  cleanupSessionState,
  deriveBridgeKeyFromSessionId,
  deriveConversationKeyFromSessionId,
  getProxyAuthToken,
  getProxyPort,
  MAX_PROXY_BODY_BYTES,
  setBridgeFactoryForTests,
  startProxy,
  stopProxy,
  writeSSEStreamForTests,
  type BridgeFactory,
} from "./proxy.ts";
import { appendPrivateLog } from "./secure-log.ts";
import { refreshCursorToken } from "./auth.ts";

const validBody = JSON.stringify({ model: "default", messages: [{ role: "user", content: "synthetic test" }] });
let credentialCalls = 0;
let bridgeCalls = 0;
let temp: string | undefined;

beforeEach(() => {
  credentialCalls = 0;
  bridgeCalls = 0;
  vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "0");
  setBridgeFactoryForTests(() => {
    bridgeCalls++;
    let alive = true;
    return {
      get alive() { return alive; },
      proc: { kill: () => { alive = false; return true; } },
      write() {}, end() { alive = false; }, unref() {}, onData() {},
      onClose(callback) { queueMicrotask(() => { alive = false; callback(0); }); },
      getStderr: () => ({}),
    };
  });
});

afterEach(() => {
  stopProxy();
  setBridgeFactoryForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (temp) {
    for (const name of readdirSync(temp)) unlinkSync(join(temp, name));
    rmdirSync(temp);
    temp = undefined;
  }
});

async function start(): Promise<number> {
  return startProxy(async () => { credentialCalls++; return "synthetic-upstream-token"; });
}

function headers(extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  return { "Content-Type": "application/json", Authorization: `Bearer ${getProxyAuthToken()}`, ...extra };
}

function send(port: number, options: {
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer;
  chunks?: Buffer[];
  path?: string;
  method?: string;
} = {}): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const req = request({
      hostname: "127.0.0.1", port,
      path: options.path ?? "/v1/chat/completions", method: options.method ?? "POST",
      headers: options.headers ?? headers(),
    }, (res) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", (error) => { if (!responseStarted) reject(error); });
    if (options.chunks) {
      for (const chunk of options.chunks) req.write(chunk);
      req.end();
    } else req.end(options.body ?? validBody);
  });
}

function sendRaw(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(raw));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error("Test request timed out")));
  });
}

function expectNoUpstream(): void {
  expect(credentialCalls).toBe(0);
  expect(bridgeCalls).toBe(0);
  expect(__testInternals.conversationStates.size).toBe(0);
}

describe("proxy ingress security", () => {
  test("generates one 256 bit secret per instance and rotates after stop", async () => {
    expect(() => getProxyAuthToken()).toThrow("not running");
    const [port, samePort] = await Promise.all([start(), start()]);
    expect(port).toBe(samePort);
    const old = getProxyAuthToken();
    expect(old).toMatch(/^[0-9a-f]{64}$/);
    expect(await start()).toBe(port);
    expect(getProxyAuthToken()).toBe(old);
    stopProxy();
    expect(getProxyPort()).toBeUndefined();
    expect(() => getProxyAuthToken()).toThrow("not running");
    const next = await start();
    expect(getProxyAuthToken()).not.toBe(old);
    expect((await send(next, { headers: headers({ Authorization: `Bearer ${old}` }) })).status).toBe(401);
    expectNoUpstream();
  });

  test.each([undefined, "Bearer wrong", `Bearer ${"0".repeat(64)}`, "cursor-proxy"])("rejects missing or wrong bearer %s before JSON parsing", async (authorization) => {
    const port = await start();
    const result = await send(port, { body: "not json", headers: {
      "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}),
    } });
    expect(result.status).toBe(401);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(result.body).not.toContain(getProxyAuthToken());
    expectNoUpstream();
  });

  test("rejects duplicate authorization headers", async () => {
    const port = await start();
    const auth = `Authorization: Bearer ${getProxyAuthToken()}\r\n`;
    const response = await sendRaw(port, `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${auth}${auth}Content-Type: application/json\r\nContent-Length: 0\r\n\r\n`);
    expect(response).toContain("401 Unauthorized");
    expectNoUpstream();
  });

  test.each(["https://example.com", "null", ""])("rejects every Origin header including %s", async (Origin) => {
    const port = await start();
    expect((await send(port, { headers: headers({ Origin }) })).status).toBe(403);
    expectNoUpstream();
  });

  test.each(["localhost", "example.com", "127.0.0.1:1"])("rejects unexpected Host %s", async (Host) => {
    const port = await start();
    expect((await send(port, { headers: headers({ Host }) })).status).toBe(403);
    expectNoUpstream();
  });

  test("rejects duplicate Host headers", async () => {
    const port = await start();
    const response = await sendRaw(port, `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: example.com\r\nAuthorization: Bearer ${getProxyAuthToken()}\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n`);
    expect(response).toContain("403 Forbidden");
    expectNoUpstream();
  });

  test.each(["text/plain", "application/x-www-form-urlencoded", "application/json; charset=latin1"])("rejects media type %s", async (contentType) => {
    const port = await start();
    expect((await send(port, { headers: headers({ "Content-Type": contentType }) })).status).toBe(415);
    expectNoUpstream();
  });

  test("requires a media type and rejects unsupported content encoding", async () => {
    const port = await start();
    expect((await send(port, { headers: { Authorization: `Bearer ${getProxyAuthToken()}` } })).status).toBe(415);
    expect((await send(port, { headers: headers({ "Content-Encoding": "gzip" }) })).status).toBe(415);
    expectNoUpstream();
  });

  test.each(["{", "null", "[]", "{}", JSON.stringify({ model: 42, messages: [] }), JSON.stringify({ model: "default", messages: {} }), JSON.stringify({ model: "default", messages: [null] }), JSON.stringify({ model: "default", messages: [{ role: "user", content: 42 }] }), JSON.stringify({ model: "default", messages: [{ role: "user", content: [null] }] }), JSON.stringify({ model: "default", messages: [{ role: "user", content: "hello" }], reasoning_effort: {} }), JSON.stringify({ model: "default", messages: [{ role: "user", content: "hello" }], tools: {} })])("rejects malformed JSON or obvious shape errors: %s", async (body) => {
    const port = await start();
    expect((await send(port, { body })).status).toBe(400);
    expectNoUpstream();
  });

  test.each([
    { messages: [{ role: "developer", content: "synthetic" }] },
    { messages: [{ role: "system", content: "synthetic" }] },
    { messages: [{ role: "user", content: "" }] },
  ])("rejects unsupported roles or missing user input before resolving credentials: %j", async ({ messages }) => {
    const port = await start();
    expect((await send(port, { body: JSON.stringify({ model: "default", messages }) })).status).toBe(400);
    expectNoUpstream();
  });

  test("a client aborted mid-body never resolves credentials and leaves the proxy usable", async () => {
    const port = await start();
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${getProxyAuthToken()}\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{`, () => socket.destroy());
      });
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    expect((await send(port, { method: "GET", path: "/v1/models", body: "" })).status).toBe(200);
    expectNoUpstream();
  });

  test("rejects an oversized declared body without waiting for content", async () => {
    const port = await start();
    const response = await sendRaw(port, `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${getProxyAuthToken()}\r\nContent-Type: application/json\r\nContent-Length: ${MAX_PROXY_BODY_BYTES + 1}\r\n\r\n`);
    expect(response).toContain("413 Payload Too Large");
    expectNoUpstream();
  });

  test("bounds chunked bodies by bytes rather than trusting Content-Length", async () => {
    const port = await start();
    const chunk = Buffer.alloc(1024 * 1024, "x");
    const response = await send(port, { headers: headers({ "Transfer-Encoding": "chunked" }), chunks: [...Array.from({ length: 32 }, () => chunk), Buffer.from("x")] });
    expect(response.status).toBe(413);
    expectNoUpstream();
  });

  test("malformed Content-Length is rejected by the HTTP parser", async () => {
    const port = await start();
    const response = await sendRaw(port, `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${getProxyAuthToken()}\r\nContent-Length: nope\r\n\r\n`);
    expect(response).toContain("400 Bad Request");
    expectNoUpstream();
  });

  test("models route also requires authentication but never resolves upstream credentials", async () => {
    const port = await start();
    expect((await send(port, { method: "GET", path: "/v1/models", headers: {}, body: "" })).status).toBe(401);
    expect((await send(port, { method: "GET", path: "/v1/models", body: "" })).status).toBe(200);
    expectNoUpstream();
  });

  test("valid authenticated chat still streams through a mocked bridge", async () => {
    const port = await start();
    const response = await send(port, { headers: headers({ "Content-Type": "application/json; charset=utf-8" }) });
    expect(response.status).toBe(200);
    expect(response.headers.connection).toBe("close");
    expect(response.body).toContain("[DONE]");
    expect(credentialCalls).toBe(1);
    expect(bridgeCalls).toBe(1);
  });

  test("upstream credential exceptions never reach the client or debug log", async () => {
    temp = mkdtempSync(join(tmpdir(), "cursor-security-"));
    const path = join(temp, "debug.log");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "1");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", path);
    const secret = "synthetic-private-failure-content";
    const port = await startProxy(async () => { throw new Error(secret); });
    const response = await send(port);
    expect(response.status).toBe(500);
    expect(response.body).not.toContain(secret);
    expect(readFileSync(path, "utf8")).not.toContain(secret);
    expect(readFileSync(path, "utf8")).not.toContain(getProxyAuthToken());
    expect(bridgeCalls).toBe(0);
  });

  test("shutdown while credentials are pending cannot spawn a bridge or retain state", async () => {
    let resolveToken!: (token: string) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const port = await startProxy(() => { notifyStarted(); return new Promise((resolve) => { resolveToken = resolve; }); });
    const result = send(port).catch(() => undefined);
    await started;
    stopProxy();
    resolveToken("synthetic-token");
    await result;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bridgeCalls).toBe(0);
    expect(() => getProxyAuthToken()).toThrow();
    expect(__testInternals.conversationStates.size).toBe(0);
  });
});

function fakeBodyRequest(): IncomingMessage {
  return Object.assign(new EventEmitter(), { headers: {}, destroyed: false, complete: false, pause: vi.fn() }) as unknown as IncomingMessage;
}

describe("bounded body cleanup", () => {
  test("aborted body rejects and removes its listeners", async () => {
    const req = fakeBodyRequest();
    const result = expect(__testInternals.readBody(req)).rejects.toMatchObject({ status: 400 });
    req.emit("data", Buffer.from("partial"));
    req.emit("aborted");
    await result;
    expect(req.eventNames()).toEqual([]);
  });

  test("body timeout is finite and clears buffered data and listeners", async () => {
    vi.useFakeTimers();
    const req = fakeBodyRequest();
    const result = expect(__testInternals.readBody(req)).rejects.toMatchObject({ status: 408 });
    req.emit("data", Buffer.from("partial"));
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(req.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("oversized body removes listeners immediately", async () => {
    const req = fakeBodyRequest();
    const result = expect(__testInternals.readBody(req)).rejects.toMatchObject({ status: 413 });
    req.emit("data", Buffer.alloc(MAX_PROXY_BODY_BYTES + 1));
    await result;
    expect(req.eventNames()).toEqual([]);
  });

  test("an in-flight bridge found only in sessionBridges is killed during cleanup", () => {
    const bridge = {
      alive: true, proc: { kill: vi.fn(() => true) }, write: vi.fn(), end: vi.fn(),
      unref: vi.fn(), onData: vi.fn(), onClose: vi.fn(), getStderr: () => ({}),
    } satisfies ReturnType<BridgeFactory>;
    __testInternals.sessionBridges.set("synthetic-session", bridge);
    __testInternals.conversationStates.set("synthetic-session", { conversationId: "synthetic", checkpoint: new Uint8Array([1]), blobStore: new Map() });
    cleanupAllSessionState();
    cleanupAllSessionState();
    expect(bridge.proc.kill).toHaveBeenCalledTimes(1);
    expect(__testInternals.sessionBridges.size).toBe(0);
    expect(__testInternals.conversationStates.size).toBe(0);
  });
});

function frameServerMessage(message: AgentServerMessage): Buffer {
  const bytes = toBinary(AgentServerMessageSchema, message);
  const frame = Buffer.alloc(5 + bytes.length);
  frame.writeUInt32BE(bytes.length, 1);
  frame.set(bytes, 5);
  return frame;
}

class ControlledBridge implements ReturnType<BridgeFactory> {
  alive = true;
  readonly write = vi.fn();
  readonly end = vi.fn();
  readonly unref = vi.fn();
  readonly proc = { kill: vi.fn(() => { this.alive = false; return true; }) };
  private dataCallback?: (chunk: Buffer) => void;
  private closeCallback?: (code: number) => void;
  onData(callback: (chunk: Buffer) => void): void { this.dataCallback = callback; }
  onClose(callback: (code: number) => void): void { this.closeCallback = callback; }
  getStderr(): { responseHeaders: { status: number; grpcStatus: null } } {
    return { responseHeaders: { status: 200, grpcStatus: null } };
  }
  emit(message: AgentServerMessage): void { this.dataCallback?.(frameServerMessage(message)); }
  emitRetryableError(): void {
    const bytes = Buffer.from(JSON.stringify({ error: { code: "unavailable", message: "synthetic" } }));
    const frame = Buffer.alloc(5 + bytes.length);
    frame[0] = 2;
    frame.writeUInt32BE(bytes.length, 1);
    frame.set(bytes, 5);
    this.dataCallback?.(frame);
  }
  emitClose(code: number): void { this.alive = false; this.closeCallback?.(code); }
}

function checkpointMessage(label: string): AgentServerMessage {
  return create(AgentServerMessageSchema, { message: {
    case: "conversationCheckpointUpdate",
    value: create(ConversationStateStructureSchema, { clientName: label }),
  } });
}

function deltaMessage(kind: "text" | "reasoning", text: string): AgentServerMessage {
  return create(AgentServerMessageSchema, { message: {
    case: "interactionUpdate",
    value: create(InteractionUpdateSchema, { message: kind === "text"
      ? { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) }
      : { case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text }) },
    }),
  } });
}

function streamHarness() {
  const sessionId = "synthetic-lifecycle";
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  const bridge = new ControlledBridge();
  const retries: ControlledBridge[] = [];
  setBridgeFactoryForTests(() => {
    const next = new ControlledBridge();
    retries.push(next);
    return next;
  });
  const state = {
    conversationId: "old-conversation",
    checkpoint: toBinary(ConversationStateStructureSchema, create(ConversationStateStructureSchema, { clientName: "initial" })),
    blobStore: new Map<string, Uint8Array>(),
  };
  __testInternals.conversationStates.set(convKey, state);
  __testInternals.sessionBridges.set(bridgeKey, bridge);
  const req = new EventEmitter();
  const output: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn(() => { res.headersSent = true; }),
    write: vi.fn((chunk: string) => { output.push(chunk); return true; }),
    end: vi.fn(() => { res.writableEnded = true; }),
  });
  const heartbeatTimer = setInterval(() => bridge.write(new Uint8Array()), 5000);
  const currentTurn = { userText: "synthetic", images: [], steps: [] };
  writeSSEStreamForTests({
    bridge, heartbeatTimer, modelId: "default", bridgeKey, convKey,
    completedTurns: [], currentTurn, accessToken: "synthetic-token",
    req: req as IncomingMessage, res: res as unknown as ServerResponse,
    blobStore: new Map([["old-blob", new Uint8Array([1])]]),
  });
  return { sessionId, bridgeKey, convKey, bridge, retries, state, req, res, output, heartbeatTimer, currentTurn };
}

describe("shutdown stream lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("shutdown terminates an active stream and clears timers and listeners", () => {
    const h = streamHarness();
    h.bridge.emit(deltaMessage("text", "visible-once"));
    expect(__testInternals.activeBridges.size).toBe(0); // Running, not paused for a tool.
    stopProxy();
    const killsAtShutdown = h.bridge.proc.kill.mock.calls.length;
    h.bridge.emitClose(143);
    stopProxy();
    expect(killsAtShutdown).toBe(1);
    expect(h.bridge.proc.kill).toHaveBeenCalledTimes(1);
    expect(h.res.end).toHaveBeenCalledTimes(1);
    expect(h.req.listenerCount("close")).toBe(0);
    expect(h.res.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.retries).toHaveLength(0);
    expect(__testInternals.conversationStates.size).toBe(0);
  });

  test("late checkpoint and failing close cannot corrupt replacement state or retry", () => {
    const h = streamHarness();
    stopProxy();
    const replacement = { conversationId: "replacement", checkpoint: null, blobStore: new Map<string, Uint8Array>() };
    __testInternals.conversationStates.set(h.convKey, replacement);
    h.bridge.emit(checkpointMessage("stale-checkpoint"));
    h.bridge.emit(create(AgentServerMessageSchema, { message: {
      case: "kvServerMessage", value: create(KvServerMessageSchema, { id: 1, message: {
        case: "setBlobArgs", value: create(SetBlobArgsSchema, { blobId: new Uint8Array([2]), blobData: new Uint8Array([3]) }),
      } }),
    } }));
    h.bridge.emitClose(1);
    expect(replacement.checkpoint).toBeNull();
    expect(replacement.blobStore.size).toBe(0);
    expect(h.retries).toHaveLength(0);
    expect(__testInternals.sessionBridges.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("late tool callback cannot repopulate active bridges after shutdown", () => {
    const h = streamHarness();
    stopProxy();
    h.bridge.emit(create(AgentServerMessageSchema, { message: {
      case: "execServerMessage", value: create(ExecServerMessageSchema, { id: 1, execId: "late-exec", message: {
        case: "mcpArgs", value: create(McpArgsSchema, { toolCallId: "late-tool", name: "read", toolName: "read", args: {} }),
      } }),
    } }));
    const activeAfterLateTool = __testInternals.activeBridges.size;
    h.bridge.emitClose(1);
    expect(activeAfterLateTool).toBe(0);
    expect(h.output.join("")).not.toContain("late-tool");
    expect(__testInternals.conversationStates.size).toBe(0);
    expect(h.retries).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("late retryable error cannot restart a stopped stream", () => {
    const h = streamHarness();
    stopProxy();
    __testInternals.conversationStates.set(h.convKey, { ...h.state, conversationId: "replacement", blobStore: new Map() });
    h.bridge.emitRetryableError();
    h.bridge.emitClose(143);
    expect(h.retries).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("shutdown clears pending graceful termination timers and kills only once", async () => {
    const h = streamHarness();
    __testInternals.activeBridges.set(h.bridgeKey, {
      bridge: h.bridge, heartbeatTimer: h.heartbeatTimer, blobStore: new Map(), mcpTools: [],
      pendingExecs: [], currentTurn: h.currentTurn, lastTotalTokens: 0,
    });
    cleanupSessionState(h.sessionId); // end() need not mean that the child exited.
    stopProxy();
    const killsAtShutdown = h.bridge.proc.kill.mock.calls.length;
    h.bridge.emitClose(143);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(killsAtShutdown).toBe(1);
    expect(h.bridge.proc.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.retries).toHaveLength(0);
  });
});

describe("stream replay safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test.each(["text", "reasoning"] as const)("crash after %s output fails without replay or duplicate output", (kind) => {
    const h = streamHarness();
    h.bridge.emit(deltaMessage(kind, "visible-once"));
    h.bridge.emitClose(1);
    expect(h.retries).toHaveLength(0);
    expect(h.output.join("").match(/visible-once/g)).toHaveLength(1);
    expect(h.output.join("")).toContain('"code":"bridge_terminated"');
    expect(h.output.join("")).not.toContain('"finish_reason":"error"');
    expect(h.res.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("crash before any output still retries from the checkpoint", () => {
    const h = streamHarness();
    h.bridge.emitClose(1);
    expect(h.retries).toHaveLength(1);
    stopProxy();
    h.retries[0]!.emitClose(143);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function mockChildProcess() {
  const pipe = () => Object.assign(new EventEmitter(), {
    write: vi.fn(() => true), end: vi.fn(), destroy: vi.fn(),
  });
  const proc = Object.assign(new EventEmitter(), {
    stdin: pipe(), stdout: pipe(), stderr: pipe(), kill: vi.fn(() => true), unref: vi.fn(),
  });
  const launch = vi.fn((_command: string, _args?: unknown, _options?: unknown) => proc as unknown as ChildProcess);
  return { proc, launch, spawn: launch as unknown as typeof spawn };
}

describe("bridge process failures", () => {
  const options = { accessToken: "synthetic-token", rpcPath: "/synthetic" };

  test("uses the current Node executable rather than PATH; Bun retains named Node", () => {
    const child = mockChildProcess();
    const bridge = __testInternals.spawnBridge(options, child.spawn);
    expect(child.launch.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(__testInternals.bridgeNodeExecutable({ ...process.versions, bun: "synthetic" }, "/bun")).toBe("node");
    child.proc.emit("exit", 0);
    expect(bridge.alive).toBe(false);
  });

  test.each(["process", "stdin"])("asynchronous %s errors close exactly once without uncaught exceptions", async (source) => {
    const child = mockChildProcess();
    const bridge = __testInternals.spawnBridge(options, child.spawn);
    const closed = vi.fn();
    bridge.onClose(closed);
    const emitter = source === "process" ? child.proc : child.proc.stdin;
    expect(() => emitter.emit("error", new Error("synthetic-sensitive-error"))).not.toThrow();
    child.proc.stdin.emit("error", new Error("late pipe error"));
    child.proc.emit("error", new Error("late spawn error"));
    child.proc.emit("exit", 1);
    child.proc.emit("close", 1);
    await Promise.resolve();
    expect(closed).toHaveBeenCalledExactlyOnceWith(1);
    expect(child.proc.kill).toHaveBeenCalledTimes(1);
    expect(bridge.alive).toBe(false);
    expect(JSON.stringify(bridge.getStderr())).not.toContain("synthetic-sensitive-error");
    const writes = child.proc.stdin.write.mock.calls.length;
    bridge.write(new Uint8Array([1]));
    bridge.end();
    expect(child.proc.stdin.write.mock.calls.length).toBe(writes);
  });

  test("an error before close registration is delivered exactly once", async () => {
    const child = mockChildProcess();
    const bridge = __testInternals.spawnBridge(options, child.spawn);
    child.proc.emit("error", new Error("synthetic"));
    await Promise.resolve();
    const closed = vi.fn();
    bridge.onClose(closed);
    child.proc.emit("close", -2);
    await Promise.resolve();
    expect(closed).toHaveBeenCalledExactlyOnceWith(1);
  });

  test("synchronous initial stdin failure is routed through close handling", async () => {
    const child = mockChildProcess();
    child.proc.stdin.write.mockImplementation(() => { throw new Error("synthetic"); });
    const bridge = __testInternals.spawnBridge(options, child.spawn);
    const closed = vi.fn();
    bridge.onClose(closed);
    await Promise.resolve();
    expect(closed).toHaveBeenCalledExactlyOnceWith(1);
    expect(child.proc.kill).toHaveBeenCalledTimes(1);
  });

  test("normal child exit and close produce one successful notification", async () => {
    const child = mockChildProcess();
    const bridge = __testInternals.spawnBridge(options, child.spawn);
    const closed = vi.fn();
    bridge.onClose(closed);
    child.proc.emit("exit", 0);
    child.proc.emit("close", 0);
    child.proc.stdin.emit("error", new Error("late pipe shutdown"));
    await Promise.resolve();
    expect(closed).toHaveBeenCalledExactlyOnceWith(0);
    expect(child.proc.kill).not.toHaveBeenCalled();
  });
});

describe("private opt-in debug logs", () => {
  beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "cursor-security-log-")); });

  test("creates a 0600 regular file and appends", () => {
    const path = join(temp!, "private.log");
    appendPrivateLog(path, "one\n");
    appendPrivateLog(path, "two\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });

  test("makes an existing file private before appending", () => {
    const path = join(temp!, "existing.log");
    writeFileSync(path, "old\n");
    chmodSync(path, 0o644);
    appendPrivateLog(path, "new\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("refuses a final symlink without changing its target", () => {
    const path = join(temp!, "target");
    writeFileSync(path, "do not touch");
    symlinkSync(path, join(temp!, "linked.log"));
    expect(() => appendPrivateLog(join(temp!, "linked.log"), "secret")).toThrow("Cannot safely append debug log");
    expect(readFileSync(path, "utf8")).toBe("do not touch");
  });

  test("refuses hardlinked destinations", () => {
    const path = join(temp!, "target");
    writeFileSync(path, "do not touch");
    linkSync(path, join(temp!, "linked.log"));
    expect(() => appendPrivateLog(join(temp!, "linked.log"), "secret")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("do not touch");
  });

  test("debug logging stays disabled by default", async () => {
    const path = join(temp!, "disabled.log");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", path);
    const port = await start();
    expect((await send(port)).status).toBe(200);
    expect(existsSync(path)).toBe(false);
  });

  test("a failed log write never falls back to printing the payload or path", async () => {
    const path = join(temp!, "target");
    writeFileSync(path, "unchanged");
    const link = join(temp!, "linked.log");
    symlinkSync(path, link);
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "1");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", link);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await start();
    const body = validBody.replace("synthetic test", "synthetic-secret-prompt");
    expect((await send(port, { body })).status).toBe(200);
    expect(stderr).toHaveBeenCalled();
    const output = JSON.stringify(stderr.mock.calls);
    expect(output).not.toContain("synthetic-secret-prompt");
    expect(output).not.toContain(link);
    expect(output).not.toContain(getProxyAuthToken());
    expect(readFileSync(path, "utf8")).toBe("unchanged");
  });

  test("token refresh errors include status only, never upstream response content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("synthetic-secret-token", { status: 401 })));
    await expect(refreshCursorToken("synthetic-refresh-token")).rejects.toThrow("Cursor token refresh failed (HTTP 401)");
  });
});
