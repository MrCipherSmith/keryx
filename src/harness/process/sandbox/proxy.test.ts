import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { createAllowlistProxy, matchesAllowlist, type AllowlistProxy } from "./proxy";

describe("matchesAllowlist", () => {
  test("exact match", () => {
    expect(matchesAllowlist("api.example.com", ["api.example.com"])).toBe(true);
    expect(matchesAllowlist("evil.com", ["api.example.com"])).toBe(false);
  });

  test("wildcard covers apex and subdomains", () => {
    expect(matchesAllowlist("github.com", ["*.github.com"])).toBe(true);
    expect(matchesAllowlist("api.github.com", ["*.github.com"])).toBe(true);
    expect(matchesAllowlist("a.b.github.com", ["*.github.com"])).toBe(true);
    expect(matchesAllowlist("notgithub.com", ["*.github.com"])).toBe(false);
    expect(matchesAllowlist("github.com.evil.com", ["*.github.com"])).toBe(false);
  });

  test("case + trailing dot insensitive; empty host denied", () => {
    expect(matchesAllowlist("API.GitHub.com.", ["*.github.com"])).toBe(true);
    expect(matchesAllowlist("", ["*.github.com"])).toBe(false);
  });
});

describe("createAllowlistProxy (live loopback)", () => {
  let proxy: AllowlistProxy | undefined;
  let upstream: net.Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    proxy = undefined;
    upstream = undefined;
  });

  /** Send a raw CONNECT and resolve with the bytes the proxy/tunnel returns. */
  function doConnect(proxyHost: string, proxyPort: number, target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(proxyPort, proxyHost, () => {
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      let buf = "";
      sock.setTimeout(4000, () => { sock.destroy(); reject(new Error("timeout")); });
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        // Once we've seen the status line + (for allowed) the upstream marker, finish.
        if (buf.includes("403") || buf.includes("UPSTREAM-OK")) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on("error", reject);
      sock.on("end", () => resolve(buf));
    });
  }

  test("allowed host tunnels and relays upstream bytes", async () => {
    upstream = net.createServer((s) => s.end("UPSTREAM-OK"));
    const upPort: number = await new Promise((r) =>
      upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)),
    );
    proxy = await createAllowlistProxy({ allowedDomains: ["localhost"] });

    const res = await doConnect(proxy.host, proxy.port, `localhost:${upPort}`);
    expect(res).toContain("200 Connection Established");
    expect(res).toContain("UPSTREAM-OK");
  });

  test("disallowed host is refused with 403", async () => {
    proxy = await createAllowlistProxy({ allowedDomains: ["localhost"] });
    const res = await doConnect(proxy.host, proxy.port, "blocked.example.com:443");
    expect(res).toContain("403");
    expect(res).not.toContain("200 Connection Established");
  });

  test("onDecision audits allow + deny", async () => {
    const decisions: Array<{ host: string; allowed: boolean }> = [];
    proxy = await createAllowlistProxy({
      allowedDomains: ["localhost"],
      onDecision: (d) => decisions.push({ host: d.host, allowed: d.allowed }),
    });
    await doConnect(proxy.host, proxy.port, "blocked.example.com:443");
    expect(decisions.some((d) => d.host === "blocked.example.com" && !d.allowed)).toBe(true);
  });
});
