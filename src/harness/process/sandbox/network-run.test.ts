import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import net from "node:net";
import { parseMaskSpec, setupNetworkRun, summarizeDecisions } from "./network-run";
import type { SandboxProfile } from "./profile";
import type { ProxyDecision } from "./proxy";

const base: SandboxProfile = {
  mode: "workspace-write",
  network: "off",
  writableRoots: ["/w"],
  readDenyList: [],
  allowedDomains: [],
  required: false,
};

describe("parseMaskSpec", () => {
  test("parses NAME@host and NAME@host1,host2", () => {
    expect(parseMaskSpec("GH_TOKEN@api.github.com")).toEqual({
      name: "GH_TOKEN",
      injectHosts: ["api.github.com"],
    });
    expect(parseMaskSpec("T@a.com, *.b.com ")).toEqual({
      name: "T",
      injectHosts: ["a.com", "*.b.com"],
    });
  });

  test("rejects malformed specs", () => {
    expect(parseMaskSpec("NOHOST")).toBeUndefined();
    expect(parseMaskSpec("@only.host")).toBeUndefined();
    expect(parseMaskSpec("NAME@")).toBeUndefined();
    expect(parseMaskSpec("")).toBeUndefined();
  });
});

/**
 * Issue a raw CONNECT through the proxy and resolve once the socket settles.
 * Raw `net` rather than an http client: Bun's http client cannot issue CONNECT.
 */
function connectThroughProxy(proxyPort: number, target: string): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect(proxyPort, "127.0.0.1", () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    const done = (): void => {
      sock.destroy();
      resolve();
    };
    sock.setTimeout(4000, done);
    sock.on("data", done);
    sock.on("error", done);
    sock.on("end", done);
  });
}

/** Poll until `check` holds, or give up after ~2s (decisions arrive async). */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("summarizeDecisions", () => {
  const d = (host: string, allowed: boolean): ProxyDecision => ({ host, allowed, kind: "connect" });

  test("groups by host+verdict, counts repeats, lists denials first", () => {
    const summary = summarizeDecisions([
      d("api.github.com", true),
      d("evil.com", false),
      d("api.github.com", true),
      d("evil.com", false),
      d("evil.com", false),
    ]);
    expect(summary).toEqual([
      { host: "evil.com", allowed: false, count: 3 },
      { host: "api.github.com", allowed: true, count: 2 },
    ]);
  });

  test("the same host allowed and denied stays two separate entries", () => {
    expect(summarizeDecisions([d("x.com", true), d("x.com", false)])).toEqual([
      { host: "x.com", allowed: false, count: 1 },
      { host: "x.com", allowed: true, count: 1 },
    ]);
  });

  test("empty in, empty out", () => {
    expect(summarizeDecisions([])).toEqual([]);
  });
});

describe("setupNetworkRun", () => {
  test("non-restricted ⇒ no proxy, no env, noop close", async () => {
    const setup = await setupNetworkRun(base);
    expect(setup.profile.proxy).toBeUndefined();
    expect(setup.envAdditions).toEqual({});
    await setup.close(); // no throw
  });

  test("restricted ⇒ starts loopback proxy, fills addr + HTTP(S)_PROXY env", async () => {
    const setup = await setupNetworkRun({ ...base, network: "restricted", allowedDomains: ["localhost"] });
    try {
      expect(setup.profile.proxy?.host).toBe("127.0.0.1");
      expect(setup.profile.proxy?.port).toBeGreaterThan(0);
      const url = `http://localhost:${setup.profile.proxy?.port}`;
      expect(setup.envAdditions.HTTPS_PROXY).toBe(url);
      expect(setup.envAdditions.HTTP_PROXY).toBe(url);
      expect(setup.envAdditions.ALL_PROXY).toBe(url);
    } finally {
      await setup.close();
    }
  });

  test("masked credential ⇒ env gets a sentinel, never the real value", async () => {
    const setup = await setupNetworkRun(
      { ...base, network: "restricted", allowedDomains: ["api.github.com"] },
      { masks: [{ name: "GH_TOKEN", realValue: "ghp_realsecret", injectHosts: ["api.github.com"] }] },
    );
    try {
      expect(setup.envAdditions.GH_TOKEN).toBeDefined();
      expect(setup.envAdditions.GH_TOKEN).toStartWith("keryx-sentinel-");
      expect(setup.envAdditions.GH_TOKEN).not.toBe("ghp_realsecret");
      expect(JSON.stringify(setup.envAdditions)).not.toContain("ghp_realsecret");
    } finally {
      await setup.close();
    }
  });

  test("tlsTerminate ⇒ writes the run CA PEM and sets CA-trust env; close removes it", async () => {
    const setup = await setupNetworkRun(
      { ...base, network: "restricted", allowedDomains: ["example.test"] },
      { tlsTerminate: true },
    );
    const caPath = setup.envAdditions.SSL_CERT_FILE as string;
    try {
      expect(caPath).toBeDefined();
      // Every standard CA-trust var points at the same PEM.
      expect(setup.envAdditions.CURL_CA_BUNDLE).toBe(caPath);
      expect(setup.envAdditions.NODE_EXTRA_CA_CERTS).toBe(caPath);
      expect(setup.envAdditions.REQUESTS_CA_BUNDLE).toBe(caPath);
      expect(setup.envAdditions.GIT_SSL_CAINFO).toBe(caPath);

      const pem = readFileSync(caPath, "utf8");
      expect(pem).toContain("BEGIN CERTIFICATE");
      expect(new X509Certificate(pem).ca).toBe(true); // a real CA cert
    } finally {
      await setup.close();
    }
    expect(existsSync(caPath)).toBe(false); // cleaned up on close
  });

  test("without tlsTerminate no CA-trust env is set", async () => {
    const setup = await setupNetworkRun({
      ...base,
      network: "restricted",
      allowedDomains: ["example.test"],
    });
    try {
      expect(setup.envAdditions.SSL_CERT_FILE).toBeUndefined();
      expect(setup.envAdditions.NODE_EXTRA_CA_CERTS).toBeUndefined();
    } finally {
      await setup.close();
    }
  });

  test("proxy decisions cross the worker boundary (allow AND deny)", async () => {
    // A live upstream so the allowed leg has something real to reach — a deny-only
    // assertion would pass even if allow decisions never crossed the boundary.
    const upstream = net.createServer((s) => s.end("UPSTREAM-OK"));
    const upPort: number = await new Promise((r) =>
      upstream.listen(0, "127.0.0.1", () => r((upstream.address() as net.AddressInfo).port)),
    );
    const setup = await setupNetworkRun({
      ...base,
      network: "restricted",
      allowedDomains: ["localhost"],
    });
    try {
      const proxyPort = setup.profile.proxy?.port as number;
      await connectThroughProxy(proxyPort, `localhost:${upPort}`); // allowed
      await connectThroughProxy(proxyPort, "blocked.example.com:443"); // denied
      await waitFor(() => setup.decisions.length >= 2);

      expect(setup.decisions.some((d) => d.host === "localhost" && d.allowed)).toBe(true);
      expect(setup.decisions.some((d) => d.host === "blocked.example.com" && !d.allowed)).toBe(true);
    } finally {
      await setup.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  test("non-restricted setup exposes an empty decision list", async () => {
    const setup = await setupNetworkRun(base);
    expect(setup.decisions).toEqual([]);
    await setup.close();
  });

  test("empty-value masked credential is skipped", async () => {
    const setup = await setupNetworkRun(
      { ...base, network: "restricted", allowedDomains: ["x.com"] },
      { masks: [{ name: "EMPTY", realValue: "", injectHosts: ["x.com"] }] },
    );
    try {
      expect(setup.envAdditions.EMPTY).toBeUndefined();
    } finally {
      await setup.close();
    }
  });
});
