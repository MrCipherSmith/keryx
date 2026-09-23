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
import { randomUUID } from "node:crypto";
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
});
