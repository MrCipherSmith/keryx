// Flow 301 (AC5): the in-sandbox TCP<->unix forwarder. A real, reproduced bug found
// during flow 301's feasibility research: a first version dropped the client's first
// TCP chunk when it arrived before the async `Bun.connect` to the unix socket
// resolved — curl (and every other HTTP client) writes its request the instant
// `connect()` returns, which reliably races ahead of the unix leg's own connect. The
// symptom was a proxied request hanging until timeout with zero bytes ever reaching
// the upstream. This suite pins the fix: bytes written immediately on TCP connect
// must still reach the unix peer.
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runForwarder, type RunningForwarder } from "./forwarder";

describe("runForwarder", () => {
  let forwarder: RunningForwarder | undefined;
  let unixServer: net.Server | undefined;
  let sockPath = "";

  afterEach(() => {
    forwarder?.stop();
    unixServer?.close();
    forwarder = undefined;
    unixServer = undefined;
    if (sockPath.length > 0) rmSync(sockPath, { force: true });
    sockPath = "";
  });

  test("AC5: bytes written the instant the TCP client connects are not lost (pre-connect buffering)", async () => {
    sockPath = path.join(tmpdir(), `keryx-fwd-test-${randomUUID()}.sock`);
    const received = await new Promise<string>((resolve, reject) => {
      unixServer = net.createServer((sock) => {
        let buf = "";
        sock.on("data", (d) => {
          buf += d.toString("utf8");
          if (buf.includes("\n")) {
            sock.end();
            resolve(buf);
          }
        });
      });
      unixServer.on("error", reject);
      unixServer.listen(sockPath, () => {
        // `testDelayUnixConnectMs` makes the pre-connect-buffering race deterministic:
        // same-process event-loop timing does not reliably reproduce it on its own
        // (see the seam's own doc comment in forwarder.ts).
        forwarder = runForwarder({ port: 0, unixSocketPath: sockPath, testDelayUnixConnectMs: 50 });
        // Real forwarders always listen on a fixed port (flow 301's forwarderPort
        // constant); `port: 0` here just picks a free one for the test.
        const tcp = net.connect(forwarder.port, "127.0.0.1", () => {
          // Written the SAME tick `connect` fires — exactly how curl behaves, and
          // exactly what raced ahead of the unix leg before the fix.
          tcp.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n\n");
        });
        tcp.on("error", reject);
      });
    });
    expect(received).toContain("GET / HTTP/1.1");
  }, 10_000);

  const TOTAL = 48 * 1024 * 1024; // far past any socket buffer
  const CHUNK = 256 * 1024;

  /** Deterministic non-repeating payload chunks, so a dropped or reordered chunk changes the hash. */
  function* payload(): Generator<Buffer> {
    for (let offset = 0; offset < TOTAL; offset += CHUNK) {
      const chunk = Buffer.alloc(CHUNK);
      for (let i = 0; i < CHUNK; i += 4) chunk.writeUInt32LE(((offset + i) / 4) >>> 0, i);
      yield chunk;
    }
  }
  const expectedHash = (): string => {
    const h = createHash("sha256");
    for (const c of payload()) h.update(c);
    return h.digest("hex");
  };

  /** Write every chunk to `sock`, honouring its backpressure, then end it. */
  async function writeAll(sock: net.Socket): Promise<void> {
    for (const chunk of payload()) {
      if (!sock.write(chunk)) await new Promise<void>((r) => sock.once("drain", () => r()));
    }
    sock.end();
  }

  test("backpressure: a payload far larger than the socket buffers reaches a SLOW unix reader byte-for-byte (TCP -> unix)", async () => {
    sockPath = path.join(tmpdir(), `keryx-fwd-test-${randomUUID()}.sock`);
    const result = await new Promise<{ bytes: number; hash: string }>((resolve, reject) => {
      unixServer = net.createServer((sock) => {
        const hash = createHash("sha256");
        let bytes = 0;
        sock.pause(); // a deliberately slow reader: nothing is consumed for a while
        setTimeout(() => sock.resume(), 400);
        sock.on("data", (d) => {
          bytes += d.length;
          hash.update(d);
        });
        sock.on("end", () => resolve({ bytes, hash: hash.digest("hex") }));
        sock.on("error", reject);
      });
      unixServer.on("error", reject);
      unixServer.listen(sockPath, () => {
        forwarder = runForwarder({ port: 0, unixSocketPath: sockPath });
        const tcp = net.connect(forwarder.port, "127.0.0.1", () => void writeAll(tcp));
        tcp.on("error", reject);
      });
    });
    expect(result.bytes).toBe(TOTAL);
    expect(result.hash).toBe(expectedHash());
  }, 60_000);

  test("backpressure: a large unix -> TCP response reaches a SLOW TCP reader byte-for-byte", async () => {
    sockPath = path.join(tmpdir(), `keryx-fwd-test-${randomUUID()}.sock`);
    const result = await new Promise<{ bytes: number; hash: string }>((resolve, reject) => {
      unixServer = net.createServer((sock) => {
        sock.on("error", () => {});
        void writeAll(sock);
      });
      unixServer.on("error", reject);
      unixServer.listen(sockPath, () => {
        forwarder = runForwarder({ port: 0, unixSocketPath: sockPath });
        const tcp = net.connect(forwarder.port, "127.0.0.1");
        const hash = createHash("sha256");
        let bytes = 0;
        tcp.pause();
        setTimeout(() => tcp.resume(), 400);
        tcp.on("data", (d) => {
          bytes += d.length;
          hash.update(d);
        });
        tcp.on("end", () => resolve({ bytes, hash: hash.digest("hex") }));
        tcp.on("error", reject);
      });
    });
    expect(result.bytes).toBe(TOTAL);
    expect(result.hash).toBe(expectedHash());
  }, 60_000);
});
