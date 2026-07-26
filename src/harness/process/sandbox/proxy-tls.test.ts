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
import { createAllowlistProxy, type AllowlistProxy, type ProxyDecision } from "./proxy";
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
    /** In-tunnel `Host` header, when it must differ from the CONNECT target. */
    hostHeaderOverride?: string,
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
          const hostHeader = hostHeaderOverride ?? `${host}:${port}`;
          tlsSock.write(`GET / HTTP/1.1\r\nHost: ${hostHeader}\r\n${extra}Connection: close\r\n\r\n`);
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

  /** Start an HTTPS upstream (leaf from the run CA) that echoes Authorization. */
  async function echoAuthUpstream(runCa: RunCa): Promise<number> {
    const leaf = await runCa.issueLeaf("localhost");
    upstream = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (q, r) => {
      r.writeHead(200);
      r.end(`AUTH=${q.headers.authorization ?? ""}`);
    });
    return new Promise((res) =>
      upstream!.listen(0, "127.0.0.1", () => res((upstream!.address() as { port: number }).port)),
    );
  }

  test("credential masking over HTTPS: sentinel is unmasked upstream and never leaks", async () => {
    ca = await createRunCa();
    const upPort = await echoAuthUpstream(ca);
    proxy = await createAllowlistProxy({
      allowedDomains: ["localhost"],
      tlsTerminate: ca,
      upstreamCa: ca.caCertPem,
      masks: [
        { sentinel: "SENTINEL-HTTPS", realValue: "real-https-secret", injectHosts: ["localhost"] },
      ],
    });

    const body = await httpsViaProxy(proxy.host, proxy.port, "localhost", upPort, ca.caCertPem, {
      Authorization: "Bearer SENTINEL-HTTPS",
    });
    // The upstream saw the REAL credential…
    expect(body).toContain("AUTH=Bearer real-https-secret");
    // …and the sentinel never reached it.
    expect(body).not.toContain("SENTINEL-HTTPS");
  });

  test("no HTTPS substitution for a host outside injectHosts", async () => {
    ca = await createRunCa();
    const upPort = await echoAuthUpstream(ca);
    proxy = await createAllowlistProxy({
      allowedDomains: ["localhost"],
      tlsTerminate: ca,
      upstreamCa: ca.caCertPem,
      masks: [
        {
          sentinel: "SENTINEL-HTTPS",
          realValue: "real-https-secret",
          injectHosts: ["api.github.com"],
        },
      ],
    });

    const body = await httpsViaProxy(proxy.host, proxy.port, "localhost", upPort, ca.caCertPem, {
      Authorization: "Bearer SENTINEL-HTTPS",
    });
    expect(body).toContain("AUTH=Bearer SENTINEL-HTTPS");
    expect(body).not.toContain("real-https-secret");
  });

  test("a non-allowlisted host is still refused before any TLS work", async () => {
    ca = await createRunCa();
    proxy = await createAllowlistProxy({ allowedDomains: ["allowed.test"], tlsTerminate: ca });
    await expect(
      httpsViaProxy(proxy.host, proxy.port, "blocked.test", 443, ca.caCertPem),
    ).rejects.toThrow();
  });

  // Regression: the terminated tunnel used to forward to whatever the in-tunnel
  // `Host` header named, so an allowlisted CONNECT was a usable route to ANY
  // destination — and the decision log recorded only the allowed CONNECT host.
  test("in-tunnel Host header cannot reach a NON-allowlisted upstream", async () => {
    ca = await createRunCa();
    // A live upstream on loopback (`localhost` is NOT on the allowlist) that
    // records anything reaching it — so a regression fails loudly, rather than
    // the assertion passing because the host merely failed to resolve.
    const evilLeaf = await ca.issueLeaf("localhost");
    const hits: string[] = [];
    upstream = https.createServer({ key: evilLeaf.keyPem, cert: evilLeaf.certPem }, (q, r) => {
      hits.push(q.url ?? "");
      r.writeHead(200);
      r.end("EXFIL-RECEIVED");
    });
    const evilPort: number = await new Promise((r) =>
      upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as { port: number }).port)),
    );

    const decisions: ProxyDecision[] = [];
    proxy = await createAllowlistProxy({
      allowedDomains: ["allowed.test"],
      tlsTerminate: ca,
      upstreamCa: ca.caCertPem,
      onDecision: (d) => decisions.push(d),
    });

    const body = await httpsViaProxy(
      proxy.host,
      proxy.port,
      "allowed.test",
      443,
      ca.caCertPem,
      {},
      `localhost:${evilPort}`,
    );

    expect(body).toContain("403");
    expect(body).toContain("blocked by keryx sandbox network allowlist");
    expect(body).not.toContain("EXFIL-RECEIVED");
    expect(hits).toEqual([]);
    // The refusal is auditable: the host actually addressed is in the log, not
    // just the tunnel that carried it.
    expect(
      decisions.some((d) => d.host === "localhost" && !d.allowed && d.kind === "http"),
    ).toBe(true);
  });

  test("a terminator is pinned to its CONNECT target, not reusable for another allowlisted host", async () => {
    ca = await createRunCa();
    const decisions: ProxyDecision[] = [];
    proxy = await createAllowlistProxy({
      allowedDomains: ["allowed.test", "other.test"],
      tlsTerminate: ca,
      onDecision: (d) => decisions.push(d),
    });

    // Both hosts pass the allowlist, but this tunnel was opened for allowed.test.
    const body = await httpsViaProxy(
      proxy.host,
      proxy.port,
      "allowed.test",
      443,
      ca.caCertPem,
      {},
      "other.test:443",
    );

    expect(body).toContain("403");
    expect(decisions.some((d) => d.host === "other.test" && !d.allowed && d.kind === "http")).toBe(
      true,
    );
  });
});
