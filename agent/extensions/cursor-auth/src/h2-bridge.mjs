#!/usr/bin/env node
/**
 * Dumb HTTP/2 bidirectional pipe for Cursor gRPC.
 *
 * Bun's node:http2 is broken. This Node script acts as a transparent
 * HTTP/2 proxy: it opens a single bidirectional stream and ferries
 * raw bytes between the parent process (via stdin/stdout) and Cursor.
 *
 * Protocol (length-prefixed framing over stdin/stdout):
 *   [4 bytes big-endian length][payload]
 *
 * First message on stdin is JSON config:
 *   { "accessToken": "...", "url": "...", "path": "...", "unary": false }
 *
 * When unary=true, the bridge uses application/proto (raw protobuf) instead
 * of application/connect+proto (Connect streaming). The single stdin message
 * is written as the request body and the stream is ended immediately.
 * After config, subsequent stdin messages are raw bytes to write to the H2 stream.
 * H2 response data is written to stdout using the same length-prefixed framing.
 */
import http2 from "node:http2";
import crypto from "node:crypto";

const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

/** Write one length-prefixed message to stdout. */
function writeMessage(data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(data);
}

// --- Buffered stdin reader ---

let stdinBuf = Buffer.alloc(0);
let stdinResolve = null;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

function waitForData() {
  return new Promise((resolve) => { stdinResolve = resolve; });
}

async function readExact(n) {
  while (stdinBuf.length < n) {
    if (stdinEnded) return null;
    await waitForData();
  }
  const result = stdinBuf.subarray(0, n);
  stdinBuf = stdinBuf.subarray(n);
  return Buffer.from(result);
}

async function readMessage() {
  const lenBuf = await readExact(4);
  if (!lenBuf) return null;
  const len = lenBuf.readUInt32BE(0);
  if (len === 0) return Buffer.alloc(0);
  return readExact(len);
}

// --- Main ---

const configBuf = await readMessage();
if (!configBuf) process.exit(1);

const config = JSON.parse(configBuf.toString("utf8"));
const { accessToken, url, path: rpcPath, unary } = config;

const INITIAL_TIMEOUT_MS = parseInt(process.env.PI_CURSOR_BRIDGE_INITIAL_TIMEOUT_MS ?? "") || 120_000;
const ACTIVITY_TIMEOUT_MS = parseInt(process.env.PI_CURSOR_BRIDGE_ACTIVITY_TIMEOUT_MS ?? "") || 300_000;
const H2_PING_INTERVAL_MS = parseInt(process.env.PI_CURSOR_BRIDGE_PING_INTERVAL_MS ?? "") || 15_000;
const H2_PING_TIMEOUT_MS = parseInt(process.env.PI_CURSOR_BRIDGE_PING_TIMEOUT_MS ?? "") || 10_000;

const client = http2.connect(url || "https://api2.cursor.sh");
let pingInterval;
let pingTimeout;

function stopPings() {
  clearInterval(pingInterval);
  clearTimeout(pingTimeout);
  pingInterval = undefined;
  pingTimeout = undefined;
}

// Node does not implement pingInterval/pingTimeout connection options.
// Schedule actual HTTP/2 PING frames and require acknowledgement instead.
client.once("connect", () => {
  pingInterval = setInterval(() => {
    if (client.closed || client.destroyed || pingTimeout) return;
    pingTimeout = setTimeout(killBridge, H2_PING_TIMEOUT_MS);
    pingTimeout.unref();
    try {
      const accepted = client.ping((error) => {
        clearTimeout(pingTimeout);
        pingTimeout = undefined;
        if (error && !client.closed && !client.destroyed) killBridge();
      });
      if (!accepted) {
        clearTimeout(pingTimeout);
        pingTimeout = undefined;
      }
    } catch {
      killBridge();
    }
  }, H2_PING_INTERVAL_MS);
  pingInterval.unref();
});
client.once("close", stopPings);

let timeout = setTimeout(killBridge, INITIAL_TIMEOUT_MS);

function resetTimeout() {
  clearTimeout(timeout);
  timeout = setTimeout(killBridge, ACTIVITY_TIMEOUT_MS);
}

function killBridge() {
  stopPings();
  clearTimeout(timeout);
  process.stderr.write(JSON.stringify({ type: "exit_reason", reason: "timeout" }) + "\n");
  client.destroy();
  process.exit(2);
}

client.on("error", () => {
  stopPings();
  clearTimeout(timeout);
  process.stderr.write(JSON.stringify({ type: "exit_reason", reason: "connection_error" }) + "\n");
  process.exit(1);
});

const headers = {
  ":method": "POST",
  ":path": rpcPath || "/agent.v1.AgentService/Run",
  "content-type": unary ? "application/proto" : "application/connect+proto",
  te: "trailers",
  authorization: `Bearer ${accessToken}`,
  "x-ghost-mode": "true",
  "x-cursor-client-version": CURSOR_CLIENT_VERSION,
  "x-cursor-client-type": "cli",
  "x-request-id": crypto.randomUUID(),
};
if (!unary) {
  headers["connect-protocol-version"] = "1";
}
const h2Stream = client.request(headers);

// Read response headers: switch to activity timeout and forward status to stderr
h2Stream.on("response", (headers) => {
  resetTimeout();
  const status = headers[":status"] ?? null;
  const grpcStatus = headers["grpc-status"] ?? null;
  process.stderr.write(
    JSON.stringify({
      type: "response_headers",
      status: status !== null ? Number(status) : null,
      grpcStatus: grpcStatus !== null ? Number(grpcStatus) : null,
    }) + "\n",
  );
});

// Forward H2 response data → stdout (length-prefixed)
h2Stream.on("data", (chunk) => {
  resetTimeout();
  writeMessage(chunk);
});

h2Stream.on("end", () => {
  stopPings();
  clearTimeout(timeout);
  client.close();
  // Give stdout time to flush
  setTimeout(() => process.exit(0), 100);
});

h2Stream.on("error", () => {
  stopPings();
  clearTimeout(timeout);
  process.stderr.write(JSON.stringify({ type: "exit_reason", reason: "stream_error" }) + "\n");
  client.close();
  process.exit(1);
});

// Forward stdin → H2 stream (after config message)
if (unary) {
  // Unary mode: read a single body message, write it, and end the stream.
  const body = await readMessage();
  if (body && body.length > 0 && !h2Stream.closed && !h2Stream.destroyed) {
    h2Stream.end(body);
  } else {
    h2Stream.end();
  }
} else {
  // Streaming mode: forward all stdin messages as Connect frames.
  (async () => {
    while (true) {
      const msg = await readMessage();
      if (!msg || msg.length === 0) {
        // EOF or zero-length = done writing
        break;
      }
      if (!h2Stream.closed && !h2Stream.destroyed) {
        resetTimeout();
        h2Stream.write(msg);
      }
    }

    if (!h2Stream.closed && !h2Stream.destroyed) {
      h2Stream.end();
    }
  })();
}
