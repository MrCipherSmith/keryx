// Flow 301 (AC2-AC4): the allowlist proxy's HARDENED posture —
// `refuseReservedAddresses: true` — used only by the unattended `agent-task`
// path. The pre-existing `network: "restricted"` posture (flow 098/142) never
// sets this flag and is proven unchanged by `proxy.test.ts`.
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAllowlistProxy, type AllowlistProxy, type ProxyDecision } from "./proxy";

function doConnect(proxyHost: string, proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost, () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    sock.setTimeout(4000, () => {
      sock.destroy();
      reject(new Error("timeout"));
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("403") || buf.includes("UPSTREAM-OK")) {
        sock.end();
        resolve(buf);
      }
    });
    sock.on("error", reject);
    sock.on("end", () => resolve(buf));
  });
}

describe("createAllowlistProxy — refuseReservedAddresses (flow 301)", () => {
  let proxy: AllowlistProxy | undefined;
  let upstream: net.Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    proxy = undefined;
    upstream = undefined;
  });

  test("AC3: a name that resolves to a loopback address is refused even though it is on the allowlist", async () => {
    upstream = net.createServer((s) => s.end("UPSTREAM-OK"));
    const upPort: number = await new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
    const decisions: ProxyDecision[] = [];
    proxy = await createAllowlistProxy({
      allowedDomains: ["evil-internal.test"],
      refuseReservedAddresses: true,
      resolveHost: async (h) => (h === "evil-internal.test" ? "127.0.0.1" : undefined),
      onDecision: (d) => decisions.push(d),
    });
    const res = await doConnect(proxy.host, proxy.port, `evil-internal.test:${upPort}`);
    expect(res).toContain("403");
    expect(res).not.toContain("UPSTREAM-OK");
    const denial = decisions.find((d) => d.host === "evil-internal.test");
    expect(denial?.allowed).toBe(false);
    expect(denial?.reason).toContain("127.0.0.1");
  });

  test("AC3: a bare IP-literal CONNECT target is refused without ever resolving", async () => {
    let resolveCalled = false;
    proxy = await createAllowlistProxy({
      allowedDomains: ["93.184.216.34"], // even if literally allowlisted by mistake, an IP target is refused
      refuseReservedAddresses: true,
      resolveHost: async () => {
        resolveCalled = true;
        return "93.184.216.34";
      },
    });
    const res = await doConnect(proxy.host, proxy.port, "93.184.216.34:443");
    expect(res).toContain("403");
    expect(resolveCalled).toBe(false);
  });

  test("AC4: connects to the address CHECKED, not a fresh lookup — a second (rebound) lookup never runs", async () => {
    upstream = net.createServer((s) => s.end("UPSTREAM-OK"));
    const upPort: number = await new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
    let lookups = 0;
    proxy = await createAllowlistProxy({
      allowedDomains: ["rebinder.test"],
      refuseReservedAddresses: true,
      // First (and only) lookup returns the real, PUBLIC-shaped upstream loopback test
      // address; if the proxy re-resolved at connect time it would see the private
      // address on lookup #2 and this test's fixture would prove the bug by connecting
      // successfully anyway (since the real upstream IS loopback) — the count is the
      // signal that only ONE lookup ever happened.
      resolveHost: async () => {
        lookups += 1;
        return "127.0.0.1";
      },
    });
    // This target legitimately resolves to loopback, so `refuseReservedAddresses`
    // refuses it too (loopback is always refused) — the point of this test is the
    // LOOKUP COUNT, proving no second resolution happens between check and connect.
    await doConnect(proxy.host, proxy.port, `rebinder.test:${upPort}`);
    expect(lookups).toBe(1);
  });

  test("AC3: plain HTTP through the proxy is refused the same way when the resolved address is private", async () => {
    upstream = http.createServer((_req, res) => res.end("UPSTREAM-OK"));
    const upPort: number = await new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
    proxy = await createAllowlistProxy({
      allowedDomains: ["metadata.test"],
      refuseReservedAddresses: true,
      resolveHost: async () => "169.254.169.254",
    });
    const res = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(proxy!.port, proxy!.host, () => {
        sock.write(`GET http://metadata.test:${upPort}/ HTTP/1.1\r\nHost: metadata.test:${upPort}\r\nConnection: close\r\n\r\n`);
      });
      let buf = "";
      sock.setTimeout(4000, () => {
        sock.destroy();
        reject(new Error("timeout"));
      });
      sock.on("data", (d) => (buf += d.toString("utf8")));
      sock.on("error", reject);
      sock.on("end", () => resolve(buf));
    });
    expect(res).toContain("403");
    expect(res).not.toContain("UPSTREAM-OK");
  });

  test("without refuseReservedAddresses, the pre-flow-301 posture is unchanged (localhost upstream still allowed)", async () => {
    upstream = net.createServer((s) => s.end("UPSTREAM-OK"));
    const upPort: number = await new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
    proxy = await createAllowlistProxy({ allowedDomains: ["localhost"] }); // no refuseReservedAddresses
    const res = await doConnect(proxy.host, proxy.port, `localhost:${upPort}`);
    expect(res).toContain("200 Connection Established");
    expect(res).toContain("UPSTREAM-OK");
  });

  test("flow 301: binds a UNIX socket instead of TCP when unixSocketPath is set", async () => {
    upstream = net.createServer((s) => s.end("UPSTREAM-OK"));
    const upPort: number = await new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
    const sockPath = path.join(tmpdir(), `keryx-proxy-test-${randomUUID()}.sock`);
    proxy = await createAllowlistProxy({ allowedDomains: ["localhost"], unixSocketPath: sockPath });
    expect(proxy.unixSocketPath).toBe(sockPath);
    const body = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(sockPath, () => {
        sock.write(`CONNECT localhost:${upPort} HTTP/1.1\r\nHost: localhost:${upPort}\r\n\r\n`);
      });
      let buf = "";
      sock.setTimeout(4000, () => {
        sock.destroy();
        reject(new Error("timeout"));
      });
      sock.on("data", (d) => (buf += d.toString("utf8")));
      sock.on("error", reject);
      sock.on("end", () => resolve(buf));
    });
    expect(body).toContain("200 Connection Established");
    expect(body).toContain("UPSTREAM-OK");
    rmSync(sockPath, { force: true });
  });
});
