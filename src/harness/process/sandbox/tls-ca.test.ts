import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_CACHED_LEAVES, MAX_CONCURRENT_ISSUANCES, createRunCa, type RunCa } from "./tls-ca";

describe("createRunCa (system openssl)", () => {
  let ca: RunCa | undefined;

  afterEach(async () => {
    if (ca) await ca.dispose();
    ca = undefined;
  });

  test("produces a CA certificate that is a CA", async () => {
    ca = await createRunCa();
    expect(ca.caCertPem).toContain("BEGIN CERTIFICATE");
    const cert = new X509Certificate(ca.caCertPem);
    expect(cert.subject).toContain("keryx sandbox run CA");
    expect(cert.ca).toBe(true);
  });

  test("issues a leaf bound to the host, signed by the run CA", async () => {
    ca = await createRunCa();
    const leaf = await ca.issueLeaf("api.example.test");

    expect(leaf.keyPem).toContain("PRIVATE KEY");
    const cert = new X509Certificate(leaf.certPem);
    expect(cert.subject).toContain("api.example.test");
    expect(cert.subjectAltName).toContain("api.example.test");
    expect(cert.ca).toBe(false);

    // Chains to our CA: issuer matches and the signature verifies against the
    // CA public key. (Bun's `checkIssued` returns the issuer cert, not a boolean,
    // so `verify` is the portable cryptographic assertion.)
    const caCert = new X509Certificate(ca.caCertPem);
    expect(cert.issuer).toBe(caCert.subject);
    expect(cert.verify(caCert.publicKey)).toBe(true);
  });

  test("leaf issuance is cached per host (same material returned)", async () => {
    ca = await createRunCa();
    const a = await ca.issueLeaf("cache.example.test");
    const b = await ca.issueLeaf("CACHE.example.test"); // case-insensitive
    expect(b.certPem).toBe(a.certPem);
    expect(b.keyPem).toBe(a.keyPem);
  });

  test("an IP host gets an IP SAN", async () => {
    ca = await createRunCa();
    const leaf = await ca.issueLeaf("127.0.0.1");
    const cert = new X509Certificate(leaf.certPem);
    expect(cert.subjectAltName).toContain("127.0.0.1");
  });

  test("dispose removes on-disk key material (issuance then fails)", async () => {
    const local = await createRunCa();
    await local.issueLeaf("x.example.test");
    await local.dispose();
    // The CA workspace is gone, so a further issuance cannot succeed.
    await expect(local.issueLeaf("y.example.test")).rejects.toThrow();
  });

  test("concurrent issuance for one host shares one key/cert pair that matches", async () => {
    ca = await createRunCa();
    const leaves = await Promise.all([1, 2, 3, 4, 5].map(() => ca!.issueLeaf("race.example.test")));
    for (const leaf of leaves) {
      expect(leaf.certPem).toBe(leaves[0]!.certPem);
      expect(leaf.keyPem).toBe(leaves[0]!.keyPem);
    }
    const cert = new X509Certificate(leaves[0]!.certPem);
    expect(cert.checkPrivateKey(createPrivateKey(leaves[0]!.keyPem))).toBe(true);
  }, 30_000);

  test("concurrent issuance for different hosts: every cert matches its own key and serials differ", async () => {
    ca = await createRunCa();
    const hosts = ["a.example.test", "b.example.test", "c.example.test", "d.example.test"];
    const leaves = await Promise.all(hosts.map((h) => ca!.issueLeaf(h)));
    const serials = new Set<string>();
    leaves.forEach((leaf, i) => {
      const cert = new X509Certificate(leaf.certPem);
      expect(cert.subjectAltName).toContain(hosts[i]!);
      expect(cert.checkPrivateKey(createPrivateKey(leaf.keyPem))).toBe(true);
      expect(cert.verify(new X509Certificate(ca!.caCertPem).publicKey)).toBe(true);
      serials.add(cert.serialNumber);
    });
    expect(serials.size).toBe(hosts.length);
  }, 30_000);

  test("a failed issuance is not cached: the next call retries", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "keryx-ca-test-"));
    try {
      const shim = path.join(parent, "openssl-shim");
      const flag = path.join(parent, "fail-once");
      // Real openssl, except `x509` fails once while the flag file exists.
      await writeFile(shim, `#!/bin/sh\nif [ "$1" = "x509" ] && [ -f "${flag}" ]; then rm -f "${flag}"; echo boom >&2; exit 1; fi\nexec openssl "$@"\n`, { mode: 0o755 });
      ca = await createRunCa({ openssl: shim, tmpDir: parent });
      await writeFile(flag, "");
      await expect(ca.issueLeaf("retry.example.test")).rejects.toThrow();
      const leaf = await ca.issueLeaf("retry.example.test");
      expect(leaf.certPem).toContain("BEGIN CERTIFICATE");
    } finally {
      if (ca) await ca.dispose();
      ca = undefined;
      await rm(parent, { recursive: true, force: true });
    }
  }, 30_000);

  // review-highload-w2:F-001. 100 distinct hosts at once started 58 concurrent
  // openssl processes, and every leaf then stayed cached for the whole run.
  test("issuance runs at most MAX_CONCURRENT_ISSUANCES openssl processes at once, and every host still gets its leaf", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "keryx-ca-conc-"));
    try {
      const shim = path.join(parent, "openssl-shim");
      const running = path.join(parent, "running");
      const log = path.join(parent, "peak.log");
      await writeFile(
        shim,
        `#!/bin/sh\nmkdir -p "${running}"\ntouch "${running}/$$"\nls "${running}" | wc -l >> "${log}"\nopenssl "$@"\nrc=$?\nrm -f "${running}/$$"\nexit $rc\n`,
        { mode: 0o755 },
      );
      ca = await createRunCa({ openssl: shim, tmpDir: parent });
      await writeFile(log, "");
      const hosts = Array.from({ length: 16 }, (_, i) => `conc${i}.example.test`);
      const leaves = await Promise.all(hosts.map((h) => ca!.issueLeaf(h)));
      for (const [i, leaf] of leaves.entries()) {
        expect(new X509Certificate(leaf.certPem).subjectAltName).toContain(hosts[i]!);
      }
      const peak = Math.max(...(await readFile(log, "utf8")).split("\n").filter(Boolean).map((l) => Number(l.trim())));
      expect(peak).toBeGreaterThan(1); // it does run in parallel...
      expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_ISSUANCES); // ...but capped
    } finally {
      if (ca) await ca.dispose();
      ca = undefined;
      await rm(parent, { recursive: true, force: true });
    }
  }, 60_000);

  test("the leaf cache is bounded and least-recently-used: the oldest host is issued again, a recently used one is not", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "keryx-ca-lru-"));
    try {
      const shim = path.join(parent, "openssl-shim");
      const log = path.join(parent, "reqs.log");
      await writeFile(shim, `#!/bin/sh\n[ "$1" = "req" ] && [ "$2" = "-new" ] && echo x >> "${log}"\nexec openssl "$@"\n`, { mode: 0o755 });
      ca = await createRunCa({ openssl: shim, tmpDir: parent });
      await writeFile(log, "");
      const issued = async (host: string) => (await ca!.issueLeaf(host)).certPem;
      const spawns = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).length;

      const first = await issued("lru-keep.example.test");
      const second = await issued("lru-old.example.test");
      for (let i = 0; i < MAX_CACHED_LEAVES - 2; i += 1) await issued(`lru-fill${i}.example.test`);
      expect(await spawns()).toBe(MAX_CACHED_LEAVES);
      // Touch the first host so it is no longer the oldest, then overflow by one.
      expect(await issued("lru-keep.example.test")).toBe(first);
      await issued("lru-overflow.example.test");
      expect(await spawns()).toBe(MAX_CACHED_LEAVES + 1);

      expect(await issued("lru-keep.example.test")).toBe(first); // still cached
      expect(await spawns()).toBe(MAX_CACHED_LEAVES + 1);
      expect(await issued("lru-old.example.test")).not.toBe(second); // evicted, issued again
      expect(await spawns()).toBe(MAX_CACHED_LEAVES + 2);
    } finally {
      if (ca) await ca.dispose();
      ca = undefined;
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
