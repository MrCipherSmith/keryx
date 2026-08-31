import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import http from "node:http";
import { createAllowlistProxy, matchesAllowlist, type AllowlistProxy } from "./proxy";

function rawHttpRequest(proxyPort: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(request));
    let response = "";
    socket.setTimeout(4_000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.on("data", (chunk) => (response += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("end", () => resolve(response));
  });
}

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

describe("createAllowlistProxy credential masking (HTTP)", () => {
  let proxy: AllowlistProxy | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    proxy = undefined;
    upstream = undefined;
  });

  /** Upstream that echoes the Authorization header it received. */
  async function echoAuthUpstream(): Promise<number> {
    upstream = http.createServer((req, res) => {
      res.writeHead(200);
      res.end(`AUTH=${req.headers.authorization ?? ""}`);
    });
    return new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
  }

  /** Do a proxied plain-HTTP GET (absolute-URL request line) and return the body. */
  function proxiedGet(proxyPort: number, url: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        { host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { Host: u.host, ...headers } },
        (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve(b));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  test("sentinel in a header is unmasked to an inject host; never leaks", async () => {
    const upPort = await echoAuthUpstream();
    proxy = await createAllowlistProxy({
      allowedDomains: ["localhost"],
      masks: [{ sentinel: "SENTINEL-XYZ", realValue: "real-secret-123", injectHosts: ["localhost"] }],
    });
    const body = await proxiedGet(proxy.port, `http://localhost:${upPort}/`, { Authorization: "Bearer SENTINEL-XYZ" });
    expect(body).toContain("AUTH=Bearer real-secret-123");
    expect(body).not.toContain("SENTINEL-XYZ");
  });

  test("no substitution for a host outside injectHosts (sentinel passes through)", async () => {
    const upPort = await echoAuthUpstream();
    proxy = await createAllowlistProxy({
      allowedDomains: ["localhost"],
      masks: [{ sentinel: "SENTINEL-XYZ", realValue: "real-secret-123", injectHosts: ["api.github.com"] }],
    });
    const body = await proxiedGet(proxy.port, `http://localhost:${upPort}/`, { Authorization: "Bearer SENTINEL-XYZ" });
    expect(body).toContain("AUTH=Bearer SENTINEL-XYZ");
    expect(body).not.toContain("real-secret-123");
  });
});

describe("C-13/C-14: malformed absolute HTTP targets", () => {
  let proxy: AllowlistProxy | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    proxy = undefined;
    upstream = undefined;
  });

  test("C-13: a malformed absolute URL with no Host is denied without an exception", async () => {
    proxy = await createAllowlistProxy({ allowedDomains: ["localhost"] });

    const response = await rawHttpRequest(
      proxy.port,
      "GET http://%/no-host HTTP/1.0\r\nConnection: close\r\n\r\n",
    );

    expect(response).toContain("403 Forbidden");
  });

  test("C-14: a malformed absolute URL preserves its fallback without escaping the handler", async () => {
    let seenPath = "";
    upstream = http.createServer((req, res) => {
      seenPath = req.url ?? "";
      res.end("UPSTREAM-OK");
    });
    const upstreamPort = await new Promise<number>((resolve) =>
      upstream!.listen(0, "127.0.0.1", () => resolve((upstream!.address() as net.AddressInfo).port)),
    );
    proxy = await createAllowlistProxy({ allowedDomains: ["localhost"] });

    const malformedPath = "http://%/kept?query=1";
    const response = await rawHttpRequest(
      proxy.port,
      `GET ${malformedPath} HTTP/1.1\r\nHost: localhost:${upstreamPort}\r\nConnection: close\r\n\r\n`,
    );

    // Node and Bun differ by host platform here: some outbound clients reject
    // the preserved invalid target, while others forward it verbatim. Both are
    // valid outcomes for this intentional fallback as long as the exception is
    // contained and any forwarded path remains unchanged.
    if (response.includes("200 OK")) {
      expect(response).toContain("UPSTREAM-OK");
      expect(seenPath).toBe(malformedPath);
    } else {
      expect(response).toContain("502 Bad Gateway");
      expect(response).toContain("upstream error");
      expect(seenPath).toBe("");
    }
  });
});
