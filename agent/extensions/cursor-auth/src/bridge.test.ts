import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createServer as createH2Server, type ServerHttp2Stream } from "node:http2";
import { createServer as createTcpServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

function runBridge(port: number) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./h2-bridge.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CURSOR_BRIDGE_INITIAL_TIMEOUT_MS: "3000",
      PI_CURSOR_BRIDGE_ACTIVITY_TIMEOUT_MS: "3000",
      PI_CURSOR_BRIDGE_PING_INTERVAL_MS: "25",
      PI_CURSOR_BRIDGE_PING_TIMEOUT_MS: "100",
    },
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const finished = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve({ code, stderr }));
  });
  const config = Buffer.from(JSON.stringify({ accessToken: "synthetic-fixture", url: `http://127.0.0.1:${port}`, unary: false }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(config.length);
  child.stdin.write(Buffer.concat([prefix, config]));
  return { child, finished };
}

function h2Frame(type: number, flags: number, stream: number, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header.writeUIntBE(body.length, 0, 3);
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(stream, 5);
  return Buffer.concat([header, body]);
}

describe("HTTP/2 keepalive bridge", () => {
  test("sends real PING frames and completes cleanly when acknowledged", async () => {
    const server = createH2Server();
    let stream: ServerHttp2Stream | undefined;
    let pings = 0;
    const sessions = new Set<import("node:http2").ServerHttp2Session>();
    server.on("session", session => {
      sessions.add(session);
      session.on("ping", () => {
        pings++;
        if (pings === 3) stream?.end("fixture");
      });
    });
    server.on("stream", next => {
      const incoming = next as ServerHttp2Stream;
      stream = incoming;
      incoming.respond({ ":status": 200 });
      incoming.resume();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const { child, finished } = runBridge(address.port);
    try {
      const result = await finished;
      expect(result.code).toBe(0);
      expect(pings).toBeGreaterThanOrEqual(3);
      expect(result.stderr).not.toContain('"reason":"timeout"');
    } finally {
      child.kill();
      for (const session of sessions) session.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 7000);

  test("terminates promptly when a peer never acknowledges PING", async () => {
    let pings = 0;
    const sockets = new Set<Socket>();
    const server = createTcpServer(socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.write(h2Frame(4, 0, 0)); // server SETTINGS
      let pending = Buffer.alloc(0);
      let preface = false;
      socket.on("data", chunk => {
        pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        if (!preface) {
          if (pending.length < 24) return;
          pending = pending.subarray(24);
          preface = true;
        }
        while (pending.length >= 9) {
          const length = pending.readUIntBE(0, 3);
          if (pending.length < 9 + length) return;
          const type = pending[3]!;
          const flags = pending[4]!;
          const stream = pending.readUInt32BE(5) & 0x7fffffff;
          pending = pending.subarray(9 + length);
          if (type === 4 && !(flags & 1)) socket.write(h2Frame(4, 1, 0));
          if (type === 1) socket.write(h2Frame(1, 4, stream, Buffer.from([0x88]))); // :status 200
          if (type === 6 && !(flags & 1)) pings++; // deliberately omit PING ACK
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const { child, finished } = runBridge(address.port);
    const started = Date.now();
    try {
      const result = await finished;
      expect(result.code).toBe(2);
      expect(pings).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.stderr).toContain('"reason":"timeout"');
    } finally {
      child.kill();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 7000);
});
