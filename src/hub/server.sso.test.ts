import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubApplication } from "./contracts";
import { createHubApplication, loadHubConfig, type HubServerConfig } from "./server";

const issuer = "https://team.cloudflareaccess.com";
const audience = "audience";
const origin = "https://hub.example";
const operatorToken = "operator-" + "o".repeat(64);
const agentToken = "agent-" + "a".repeat(64);
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
let directory: string;
let rolesFile: string;
let app: HubApplication;
let config: HubServerConfig;
let clock: number;
const roles = (entries: unknown) => writeFileSync(rolesFile, JSON.stringify(entries));
const token = (claims: Record<string, unknown> = {}) => {
  const unsigned = [JSON.stringify({ alg: "RS256", kid: "key" }), JSON.stringify({ iss: issuer, aud: [audience], sub: "human-1", email: "Owner@Example.com", exp: Math.floor(clock / 1000) + 3600, ...claims })].map((s) => Buffer.from(s).toString("base64url")).join(".");
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), signing.privateKey).toString("base64url")}`;
};
const call = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) => app.fetch(new Request(`${origin}/hub/v1${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
async function login(jwt = token()) {
  const response = await call("/session/cloudflare", "POST", { Origin: origin, "Cf-Access-Jwt-Assertion": jwt });
  expect(response.status).toBe(200);
  return { response, cookie: response.headers.get("set-cookie")!.split(";")[0]!, jwt };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-sso-")); rolesFile = join(directory, "roles.json"); clock = Date.now();
  roles([{ email: "owner@example.com", role: "operator" }]);
  config = {
    dataDir: join(directory, "data"), operatorToken, agentToken, publicOrigin: origin,
    cloudflareAccess: { issuer, audience, rolesFile },
    accessDependencies: { now: () => clock, fetch: async () => Response.json({ keys: [{ ...signing.publicKey.export({ format: "jwk" }), kid: "key", alg: "RS256" }] }) },
  };
  app = createHubApplication(config);
});
afterEach(() => { app?.close(); rmSync(directory, { recursive: true, force: true }); });

test("SSO establishes a persistent secure session with verified identity and stable principal", async () => {
  expect(await (await call("/auth/config")).json()).toEqual({ cloudflareAccessEnabled: true });
  const session = await login();
  expect(session.response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect(session.response.headers.get("set-cookie")).toContain("Secure");
  const principal = (await session.response.json()).principal;
  expect(principal).toMatchObject({ kind: "human", role: "operator", email: "owner@example.com", issuer, subject: "human-1" });
  expect(principal.id).toStartWith("cloudflare:");
  app.close(); app = createHubApplication(config);
  const restored = await call("/session", "GET", { Cookie: session.cookie, "Cf-Access-Jwt-Assertion": session.jwt });
  expect(restored.status).toBe(200); expect((await restored.json()).principal).toEqual(principal);
  const project = await call("/projects", "POST", { Cookie: session.cookie, "Cf-Access-Jwt-Assertion": session.jwt, Origin: origin, "Idempotency-Key": randomUUID() }, { name: "SSO audit" });
  expect(project.status).toBe(200);
  const projectId = (await project.json()).id;
  const events = await (await call(`/projects/${projectId}/events`, "GET", { Authorization: `Bearer ${agentToken}` })).json();
  expect(events.events[0]).toMatchObject({ actorId: principal.id, actorRole: "operator" });
  expect(JSON.stringify(events)).not.toContain(session.jwt);
});

test("rejects spoofed headers, wrong application, unmapped email, and cross-origin login", async () => {
  expect((await call("/session/cloudflare", "POST", { Origin: origin, "Cf-Access-Authenticated-User-Email": "owner@example.com" })).status).toBe(401);
  expect((await call("/session/cloudflare", "POST", { Origin: origin, "Cf-Access-Jwt-Assertion": "forged" })).status).toBe(401);
  expect((await call("/session/cloudflare", "POST", { Origin: origin, "Cf-Access-Jwt-Assertion": token({ aud: ["other"] }) })).status).toBe(401);
  expect((await call("/session/cloudflare", "POST", { Origin: origin, "Cf-Access-Jwt-Assertion": token({ email: "unknown@example.com" }) })).status).toBe(403);
  expect((await call("/session/cloudflare", "POST", { Origin: "https://evil.example", "Cf-Access-Jwt-Assertion": token() })).status).toBe(403);
  expect((await call("/session/cloudflare", "POST", { "Cf-Access-Jwt-Assertion": token() })).status).toBe(403);
  expect((await call("/projects")).status).toBe(401);
});

test("role edits and revocation apply on the next request and invalid file fails closed", async () => {
  const s = await login(); const headers = { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": s.jwt };
  roles([{ email: "owner@example.com", role: "reviewer" }]);
  expect((await (await call("/session", "GET", headers)).json()).principal.role).toBe("reviewer");
  roles([]); expect((await call("/session", "GET", headers)).status).toBe(403);
  writeFileSync(rolesFile, "broken"); expect((await call("/session", "GET", headers)).status).toBe(503);
  roles([{ email: "owner@example.com", role: "operator" }]);
  expect((await call("/session", "GET", headers)).status).toBe(200);
});

test("SSO session cannot outlive original JWT and rejects a substituted identity", async () => {
  const s = await login(token({ exp: Math.floor(clock / 1000) + 30 }));
  expect((await call("/session", "GET", { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": token({ sub: "someone-else" }) })).status).toBe(401);
  expect((await call("/session", "GET", { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": "forged" })).status).toBe(401);
  clock += 31_000;
  expect((await call("/session", "GET", { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": token() })).status).toBe(401);
  const long = await login(token({ exp: Math.floor(clock / 1000) + 24 * 3600 }));
  expect(long.response.headers.get("set-cookie")).toContain("Max-Age=43200");
  clock += 12 * 3600_000 + 1;
  expect((await call("/session", "GET", { Cookie: long.cookie, "Cf-Access-Jwt-Assertion": long.jwt })).status).toBe(401);
});

test("Authorization presence always selects Bearer and cannot fall back or create a human SSO session", async () => {
  const s = await login();
  for (const authorization of ["", "Basic invalid", "Bearer invalid"]) {
    const headers = { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": s.jwt, Authorization: authorization, Origin: origin };
    const result = await call("/session", "GET", headers); expect(result.status).toBe(401);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(result.headers.has("location")).toBe(false);
    expect((await call("/session/cloudflare", "POST", headers)).status).toBe(401);
    expect((await call("/session", "POST", headers, { token: operatorToken })).status).toBe(401);
  }
  const agent = await call("/session", "GET", { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": s.jwt, Authorization: `Bearer ${agentToken}` });
  expect((await agent.json()).principal).toMatchObject({ kind: "agent", role: "agent" });
  expect((await call("/session/cloudflare", "POST", { Origin: origin, Authorization: `Bearer ${agentToken}`, "Cf-Access-Jwt-Assertion": s.jwt })).status).toBe(403);
  expect((await call("/session", "POST", { Authorization: `Bearer ${agentToken}` }, { token: operatorToken })).status).toBe(403);
  expect((await call("/session", "DELETE", { Cookie: s.cookie, Authorization: `Bearer ${agentToken}` })).headers.has("set-cookie")).toBe(false);
  expect((await call("/session", "GET", { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": s.jwt })).status).toBe(200);
});

test("logout clears the session and returns only a fixed Access logout destination", async () => {
  const s = await login(); const headers = { Cookie: s.cookie, "Cf-Access-Jwt-Assertion": s.jwt, Origin: origin };
  expect((await call("/session", "DELETE", { ...headers, Origin: "https://evil.example" })).status).toBe(403);
  const response = await call("/session", "DELETE", headers);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, logoutUrl: `${origin}/cdn-cgi/access/logout` });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await call("/session", "GET", headers)).status).toBe(401);
});

test("expired or revoked SSO sessions can still be logged out safely", async () => {
  const s = await login(); roles([]); clock += 4_000_000;
  const response = await call("/session", "DELETE", { Cookie: s.cookie, Origin: origin });
  expect(response.status).toBe(200); expect((await response.json()).logoutUrl).toBe(`${origin}/cdn-cgi/access/logout`);
});

test("local token recovery survives SSO and disabled mode preserves legacy behavior", async () => {
  const response = await call("/session", "POST", {}, { token: operatorToken });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect((await call("/session", "GET", { Cookie: cookie })).status).toBe(200);
  expect((await call("/session", "GET", { Cookie: cookie, "Cf-Access-Jwt-Assertion": token() })).status).toBe(401);
  expect((await call("/session", "POST", { "Cf-Access-Jwt-Assertion": token(), Origin: origin }, { token: operatorToken })).status).toBe(403);
  expect((await call("/session", "POST", { "Cf-Access-Jwt-Assertion": "", Origin: origin }, { token: operatorToken })).status).toBe(403);
  app.close(); const { cloudflareAccess: _access, ...disabledConfig } = config; app = createHubApplication(disabledConfig);
  expect(await (await call("/auth/config")).json()).toEqual({ cloudflareAccessEnabled: false });
  expect((await call("/session", "GET", { Cookie: cookie })).status).toBe(200);
  expect((await call("/session/cloudflare", "POST", { Origin: origin, "Cf-Access-Jwt-Assertion": token() })).status).toBe(404);
});

test("environment configuration fails startup on incomplete SSO and missing rolefile", () => {
  const env = { KERYX_HUB_OPERATOR_TOKEN: operatorToken, KERYX_HUB_AGENT_TOKEN: agentToken, KERYX_HUB_ACCESS_ENABLED: "true", KERYX_HUB_PUBLIC_ORIGIN: origin };
  expect(() => loadHubConfig(env)).toThrow();
  expect(() => createHubApplication({ ...config, publicOrigin: "http://hub.example" })).toThrow("HTTPS");
  expect(() => createHubApplication({ ...config, cloudflareAccess: { issuer, audience, rolesFile: join(directory, "missing") } })).toThrow("role mapping");
  expect(() => loadHubConfig({ ...env, KERYX_HUB_ACCESS_ENABLED: "yes" })).toThrow();
});
