import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { parseMaskSpec, setupNetworkRun } from "./network-run";
import type { SandboxProfile } from "./profile";

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
