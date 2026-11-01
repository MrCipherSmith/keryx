import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessVerifier, readAccessRoles, validateAccessConfig } from "./cloudflare-access";

const issuer = "https://test-team.cloudflareaccess.com";
const audience = "test-application-audience";
const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
const second = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (key = first, kid = "first") => ({ ...key.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" });
const jwt = (claims: Record<string, unknown> = {}, key = first, header: Record<string, unknown> = {}) => {
  const encoded = [JSON.stringify({ alg: "RS256", kid: "first", ...header }), JSON.stringify({ iss: issuer, aud: [audience], sub: "person-1", email: "Owner@Example.com", exp: 2000, ...claims })].map((s) => Buffer.from(s).toString("base64url")).join(".");
  return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), key.privateKey).toString("base64url")}`;
};
function fixture() {
  let clock = 1000_000;
  let keys = [jwk()];
  let fetches = 0;
  let unavailable = false;
  const verifier = createAccessVerifier({ issuer, audience, rolesFile: "/unused" }, {
    now: () => clock,
    fetch: async (url, options) => {
      expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`);
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeDefined();
      fetches++;
      if (unavailable) throw new Error("network unavailable");
      return Response.json({ keys });
    },
  });
  return { verifier, fetches: () => fetches, rotate: () => { keys = [jwk(second, "second")]; clock += 11_000; }, expireCache: () => { clock += 301_000; }, unavailable: () => { unavailable = true; } };
}

describe("Cloudflare Access JWT trust boundary", () => {
  test("accepts a signed application token and caches trusted keys", async () => {
    const f = fixture();
    expect(await f.verifier.verify(jwt())).toEqual({ issuer, subject: "person-1", email: "owner@example.com", expiresAt: 2000_000 });
    await f.verifier.verify(jwt());
    expect(f.fetches()).toBe(1);
  });
  test("accepts a signed bare-string audience for the configured application", async () => {
    const f = fixture();
    expect(await f.verifier.verify(jwt({ aud: audience }))).toEqual({
      issuer, subject: "person-1", email: "owner@example.com", expiresAt: 2000_000,
    });
  });
  test("rejects wrong claims, signature, algorithm, malformed and unsigned tokens", async () => {
    const f = fixture();
    for (const token of [
      jwt({ iss: "https://evil.example" }), jwt({ aud: ["other-app"] }), jwt({ exp: 1000 }),
      jwt({ exp: undefined }), jwt({ exp: 2000.5 }), jwt({ sub: "s".repeat(513) }), jwt({ exp: "2000" }), jwt({ nbf: 1001 }), jwt({ nbf: "900" }), jwt({ sub: "" }),
      jwt({ email: "" }), jwt({ email: "not-an-email" }), jwt({ aud: [audience, 1] }),
      jwt({}, second), jwt({}, first, { alg: "none" }), jwt({}, first, { alg: "HS256" }),
      jwt({}, first, { kid: "missing" }), "unsigned.payload.", "garbage",
    ]) await expect(f.verifier.verify(token)).rejects.toThrow();
  });
  test("refreshes rotated keys and fails closed when expired keys cannot refresh", async () => {
    const f = fixture(); await f.verifier.verify(jwt()); f.rotate();
    await f.verifier.verify(jwt({}, second, { kid: "second" }));
    expect(f.fetches()).toBe(2);
    f.unavailable(); f.expireCache();
    await expect(f.verifier.verify(jwt({}, second, { kid: "second" }))).rejects.toThrow();
  });
  test("bounds failed unknown-key refreshes", async () => {
    const f = fixture(); await f.verifier.verify(jwt());
    for (let i = 0; i < 5; i++) await expect(f.verifier.verify(jwt({}, first, { kid: `unknown-${i}` }))).rejects.toThrow();
    expect(f.fetches()).toBe(1);
  });
});

test("role mapping is explicit, reloadable, bounded and rejects ambiguous normalized identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "access-roles-")); const file = join(dir, "roles.json");
  try {
    writeFileSync(file, JSON.stringify([{ email: " Owner@Example.com ", role: "operator" }]));
    expect(readAccessRoles(file).get("owner@example.com")).toBe("operator");
    writeFileSync(file, JSON.stringify([{ email: "owner@example.com", role: "reviewer" }]));
    expect(readAccessRoles(file).get("owner@example.com")).toBe("reviewer");
    writeFileSync(file, "[]"); expect(readAccessRoles(file).size).toBe(0);
    for (const body of ["invalid", '{}', JSON.stringify([{ email: "owner@example.com", role: "agent" }]), JSON.stringify([{ email: "owner@example.com", role: "operator" }, { email: "OWNER@example.com", role: "reviewer" }]), " ".repeat(65_537)]) {
      writeFileSync(file, body); expect(() => readAccessRoles(file)).toThrow();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configuration requires a fixed HTTPS Cloudflare issuer, audience and absolute role file", () => {
  for (const config of [
    { issuer: "http://test-team.cloudflareaccess.com", audience, rolesFile: "/roles" },
    { issuer: "https://evil.example", audience, rolesFile: "/roles" },
    { issuer: `${issuer}/path`, audience, rolesFile: "/roles" },
    { issuer, audience: "", rolesFile: "/roles" },
    { issuer, audience, rolesFile: "roles.json" },
  ]) expect(() => validateAccessConfig(config)).toThrow();
  expect(() => validateAccessConfig({ issuer, audience, rolesFile: "/roles" })).not.toThrow();
});
