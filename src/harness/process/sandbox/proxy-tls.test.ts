// TLS-terminate (MITM) tests for the allowlist proxy (flow 102 slice 2).
//
// Proves the full opt-in MITM path with real TLS on loopback: the proxy answers
// CONNECT, terminates with a leaf issued by the run CA, and relays to the REAL
// TLS upstream. The client trusts only the run CA — exactly what the CA-trust
// env vars will deliver to a contained process.

import { afterEach, describe, expect, test } from "bun:test";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createAllowlistProxy, type AllowlistProxy } from "./proxy";
import { createRunCa, type RunCa } from "./tls-ca";

describe("createAllowlistProxy TLS terminate (live loopback)", () => {
  let proxy: AllowlistProxy | undefined;
  let upstream: https.Server | undefined;
  let ca: RunCa | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    if (ca) await ca.dispose();
    proxy = undefined;
    upstream = undefined;
    ca = undefined;
  });

  /**
   * Real HTTPS GET through the proxy's CONNECT tunnel, trusting only `caPem`.
   * The TLS handshake + HTTP/1.1 request are done by hand over the tunnel socket
   * (Bun's `https.request({socket})` falls back to fetch and cannot take a
   * pre-connected socket).
   */
  function httpsViaProxy(
    proxyHost: string,
    proxyPort: number,
    host: string,
    port: number,
    caPem: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Raw CONNECT over a plain socket — Bun's http client cannot issue CONNECT
      // (it builds a URL from `path` and rejects `host:port`).
      const sock = net.connect(proxyPort, proxyHost, () => {
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      });
      sock.on("error", reject);
      let preamble = "";
      const onData = (chunk: Buffer): void => {
        preamble += chunk.toString("utf8");
        if (!preamble.includes("\r\n\r\n")) return;
        sock.removeListener("data", onData);
        const statusLine = preamble.slice(0, preamble.indexOf("\r\n"));
        if (!statusLine.includes("200")) {
          sock.end();
          reject(new Error(`CONNECT refused: ${statusLine}`));
          return;
        }
        const tlsSock = tls.connect({ socket: sock, servername: host, ca: [caPem] }, () => {
          const extra = Object.entries(extraHeaders)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("");
          tlsSock.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\n${extra}Connection: close\r\n\r\n`);
        });
        let buf = "";
        tlsSock.on("data", (d) => (buf += d.toString("utf8")));
        tlsSock.on("end", () => resolve(buf));
        tlsSock.on("error", reject);
      };
      sock.on("data", onData);
    });
  }

  test("terminates TLS with a run-CA leaf and relays to the real upstream", async () => {
    ca = await createRunCa();
    // A real TLS upstream, also using a leaf from the run CA so the proxy can
    // verify it (production verifies against the system store instead).
    const upLeaf = await ca.issueLeaf("localhost");
    upstream = https.createServer({ key: upLeaf.keyPem, cert: upLeaf.certPem }, (_q, r) => {
      r.writeHead(200);
      r.end("OK-TLS-UPSTREAM");
    });
    const upPort: number = await new Promise((r) =>
      upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as { port: number }).port)),
    );

    proxy = await createAllowlistProxy({
      allowedDomains: ["localhost"],
      tlsTerminate: ca,
      upstreamCa: ca.caCertPem,
    });

    const body = await httpsViaProxy(proxy.host, proxy.port, "localhost", upPort, ca.caCertPem);
    expect(body).toContain("OK-TLS-UPSTREAM");
  });

  test("a non-allowlisted host is still refused before any TLS work", async () => {
    ca = await createRunCa();
    proxy = await createAllowlistProxy({ allowedDomains: ["allowed.test"], tlsTerminate: ca });
    await expect(
      httpsViaProxy(proxy.host, proxy.port, "blocked.test", 443, ca.caCertPem),
    ).rejects.toThrow();
  });
});
