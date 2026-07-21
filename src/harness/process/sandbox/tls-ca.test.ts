import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { createRunCa, type RunCa } from "./tls-ca";

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
});
