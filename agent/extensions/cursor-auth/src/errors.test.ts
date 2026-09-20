import { afterEach, describe, expect, test, vi } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { parseCursorError } from "./cursor-errors.ts";
import { getProxyAuthToken, setBridgeFactoryForTests, startProxy, stopProxy } from "./proxy.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const nativeTitle = "Model Blocked";
const nativeDetail = "Please ask your admin to enable access to Claude Fable 5.";
const nativeMessage = `${nativeTitle}\n\n${nativeDetail}`;
function detailsValue(fields: { title?: string; detail?: string; retryable?: boolean; info?: Array<[string, string]> } = {}) {
  const display = new BinaryWriter();
  if (fields.title !== undefined) display.tag(1, WireType.LengthDelimited).string(fields.title);
  if (fields.detail !== undefined) display.tag(2, WireType.LengthDelimited).string(fields.detail);
  if (fields.retryable !== undefined) display.tag(4, WireType.Varint).bool(fields.retryable);
  for (const [key, value] of fields.info ?? []) {
    const entry = new BinaryWriter().tag(1, WireType.LengthDelimited).string(key).tag(2, WireType.LengthDelimited).string(value).finish();
    display.tag(7, WireType.LengthDelimited).bytes(entry);
  }
  const bytes = new BinaryWriter().tag(2, WireType.LengthDelimited).bytes(display.finish()).finish();
  return Buffer.from(bytes).toString("base64");
}
const nativeError = {
  error: {
    code: "failed_precondition", message: "Error",
    details: [{ type: "aiserver.v1.ErrorDetails", value: detailsValue({ title: nativeTitle, detail: nativeDetail, retryable: false }), debug: {
      error: "ERROR_MODEL_BLOCKED", details: { title: "Debug is not authoritative", detail: "Diagnostic only", isRetryable: true },
    } }],
  },
};

afterEach(() => {
  stopProxy();
  setBridgeFactoryForTests();
  vi.restoreAllMocks();
});

describe("Cursor supplied error wording", () => {
  test("accepts new upstream wording without any model specific mapping", () => {
    const title = "A future Cursor feature requires confirmation";
    const detail = "Follow the instructions supplied by the service.";
    const result = parseCursorError(encode({ error: { code: "failed_precondition", message: "Error", details: [{
      type: "aiserver.v1.ErrorDetails", value: detailsValue({ title, detail, info: [["Action", "Open the account dashboard"]] }),
    }] } }));
    expect(result?.message).toBe(`${title}\n\n${detail}\n\nAction: Open the account dashboard`);
  });

  test.each(["Model Blocked", "Access changed", "Please sign in again"])("preserves title-only text %s", (title) => {
    expect(parseCursorError(encode({ error: { message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: detailsValue({ title }) }] } }))?.message).toBe(title);
  });

  test("preserves detail-only text", () => {
    expect(parseCursorError(encode({ error: { message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: detailsValue({ detail: "Native text only" }) }] } }))?.message).toBe("Native text only");
  });

  test("uses optional native retryability without changing the displayed text", () => {
    for (const [code, retryable] of [["unavailable", false], ["failed_precondition", true]] as const) {
      expect(parseCursorError(encode({ error: { code, message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: detailsValue({ title: "Native", retryable }) }] } }))).toEqual({ code, message: "Native", retryable });
    }
    expect(parseCursorError(encode({ error: { code: "unavailable", message: "Native" } }))?.retryable).toBe(true);
  });

  test("ignores malformed details and uses the first successfully decoded record", () => {
    const good = { type: "type.googleapis.com/aiserver.v1.ErrorDetails", value: detailsValue({ title: "First" }).replace(/=+$/, "") };
    const later = { type: "aiserver.v1.ErrorDetails", value: detailsValue({ title: "Later" }) };
    const unknown = { type: "another.ErrorDetails", value: later.value };
    expect(parseCursorError(encode({ error: { message: "Raw", details: [unknown, { type: "aiserver.v1.ErrorDetails", value: "%%%" }, good, later] } }))?.message).toBe("First");
  });

  test.each(["", "Ag==", "EoCAgIA=", "Iw==", "A==="])("malformed or empty protobuf details %s retain raw wording", (value) => {
    expect(parseCursorError(encode({ error: { message: "Raw Cursor message", details: [{ type: "aiserver.v1.ErrorDetails", value }] } }))?.message).toBe("Raw Cursor message");
  });

  test("skips new protobuf fields without interpreting analytics or buttons as messages", () => {
    const custom = new BinaryWriter().tag(12, WireType.LengthDelimited).string("Private diagnostics").tag(1, WireType.LengthDelimited).string("Native title").finish();
    const bytes = new BinaryWriter().tag(15, WireType.LengthDelimited).string("Private diagnostics").tag(2, WireType.LengthDelimited).bytes(custom).finish();
    expect(parseCursorError(encode({ error: { message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: Buffer.from(bytes).toString("base64") }] } }))?.message).toBe("Native title");
  });

  test("does not substitute debug for missing or undecodable binary details", () => {
    const payload = structuredClone(nativeError);
    payload.error.details[0]!.value = "not base64!";
    expect(parseCursorError(encode(payload))?.message).toBe("Error");
  });

  test("oversized detail payloads safely fall back to the raw Cursor message", () => {
    const value = Buffer.alloc(64 * 1024 + 1).toString("base64");
    expect(parseCursorError(encode({ error: { message: "Raw", details: [{ type: "aiserver.v1.ErrorDetails", value }] } }))?.message).toBe("Raw");
  });

  test.each([Buffer.alloc(0), Buffer.from("not JSON"), encode({}), encode({ error: null })])("retains existing success terminator handling", (bytes) => {
    expect(parseCursorError(bytes)).toBeNull();
  });
  test("uses Cursor's title and detail rather than the generic Connect message", () => {
    expect(parseCursorError(encode(nativeError))).toEqual({ code: "failed_precondition", message: nativeMessage, retryable: false });
  });

  test.each(["unauthenticated", "resource_exhausted", "deadline_exceeded", "unavailable", "internal", "invalid_argument", "future_code"])(
    "does not rewrite upstream wording for %s", (code) => {
      const message = "A new message supplied by Cursor, not a local message catalog.";
      expect(parseCursorError(encode({ error: { code, message } }))?.message).toBe(message);
    },
  );

  test("does not relabel a rate limit as a context overflow", () => {
    expect(parseCursorError(encode({ error: { code: "resource_exhausted", message: "Rate limit reached" } }))?.message).toBe("Rate limit reached");
  });

  test("ignores unrelated debug fields and metadata", () => {
    const payload = structuredClone(nativeError);
    Object.assign(payload.error.details[0]!.debug, { privateDiagnostic: "not for display" });
    const result = parseCursorError(encode({ ...payload, metadata: { privateDiagnostic: "not for display" } }));
    expect(result?.message).toBe(nativeMessage);
    expect(JSON.stringify(result)).not.toContain("privateDiagnostic");
  });
});

function emitErrorFromBridge(error: unknown): () => number {
  let starts = 0;
  setBridgeFactoryForTests(() => {
    starts++;
    let alive = true;
    let onClose: ((code: number) => void) | undefined;
    const finish = () => {
      if (!alive) return;
      alive = false;
      queueMicrotask(() => onClose?.(0));
    };
    const bytes = encode(error);
    const frame = Buffer.alloc(5 + bytes.length);
    frame[0] = 2;
    frame.writeUInt32BE(bytes.length, 1);
    frame.set(bytes, 5);
    return {
      get alive() { return alive; },
      proc: { kill() { finish(); return true; } },
      write() {}, end: finish, unref() {}, getStderr: () => ({}),
      onClose(callback) { onClose = callback; },
      onData(callback) { queueMicrotask(() => { callback(frame.subarray(0, 3)); callback(frame.subarray(3)); }); },
    };
  });
  return () => starts;
}

function model(port: number): Model<"openai-completions"> {
  return {
    id: "default", name: "Fixture", provider: "cursor", api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000,
  };
}

describe("native error propagation through Pi", () => {
  test("real Pi transport displays Cursor's message instead of a generic finish reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const starts = emitErrorFromBridge(nativeError);
    const port = await startProxy(async () => "test");
    const result = await streamSimple(model(port), {
      messages: [{ role: "user", content: "synthetic test", timestamp: 0 }],
    }, { apiKey: getProxyAuthToken() }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(nativeMessage);
    expect(result.content).toEqual([]);
    expect(starts()).toBe(1);
  });

  test("nonstreaming responses contain the same Cursor wording and Connect code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    emitErrorFromBridge(nativeError);
    const port = await startProxy(async () => "test");
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${getProxyAuthToken()}` },
      body: JSON.stringify({ model: "default", stream: false, messages: [{ role: "user", content: "synthetic test" }] }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: nativeMessage, type: "upstream_error", code: "failed_precondition" } });
  });
});
