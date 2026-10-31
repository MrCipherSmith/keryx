import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubApplication } from "./contracts";
import { createHubApplication, loadHubConfig, startHub } from "./server";
let app: HubApplication;
let dir: string;
const operatorToken = randomBytes(32).toString("hex");
const agentToken = randomBytes(32).toString("hex");
const config = () => ({ dataDir: dir, operatorToken, agentToken });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hub-security-")); app = createHubApplication(config()); });
afterEach(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });
function call(path: string, body?: unknown, extra: Record<string, string> = {}) {
  return app.fetch(new Request(`http://hub.test/hub/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${operatorToken}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
test("requires strong distinct bootstrap credentials and validates environment ports", () => {
  expect(() => createHubApplication({ ...config(), agentToken: operatorToken })).toThrow("distinct");
  expect(() => createHubApplication({ ...config(), operatorToken: "weak" })).toThrow("32");
  expect(() => loadHubConfig({ KERYX_HUB_OPERATOR_TOKEN: operatorToken, KERYX_HUB_AGENT_TOKEN: agentToken, KERYX_HUB_PORT: "not-a-port" })).toThrow("PORT");
});
test("cookie session survives restart, is revoked by logout, and login refuses an agent browser session", async () => {
  const login = await call("/session", { token: operatorToken });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  app.close(); app = createHubApplication(config());
  const session = () => app.fetch(new Request("http://hub.test/hub/v1/session", { headers: { Cookie: cookie } }));
  expect((await session()).status).toBe(200);
  const logout = await app.fetch(new Request("http://hub.test/hub/v1/session", { method: "DELETE", headers: { Cookie: cookie, Origin: "http://hub.test" } }));
  expect(logout.status).toBe(200); expect((await session()).status).toBe(401);
  expect((await call("/session", { token: agentToken })).status).toBe(403);
});
test("failed multi-document import rolls back earlier documents and events", async () => {
  const project = await (await call("/projects", { name: "Atomic" })).json() as { id: string; version: number };
  const before = await (await call(`/projects/${project.id}/events`)).json();
  const response = await call(`/projects/${project.id}/import`, { expectedVersion: project.version, sourceRevision: "source", documents: [{ path: "wiki/valid.md", kind: "wiki", content: "Valid" }, { path: "../escape.md", kind: "wiki", content: "Invalid" }] });
  expect(response.status).toBe(400);
  expect(await (await call(`/projects/${project.id}/documents`)).json()).toEqual({ documents: [] });
  expect(await (await call(`/projects/${project.id}/events`)).json()).toEqual(before);
});
test("HTTP quota is enforced while streaming without trusting Content-Length", async () => {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 33) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); } });
  const response = await app.fetch(new Request("http://hub.test/hub/v1/projects", { method: "POST", headers: { Authorization: `Bearer ${operatorToken}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: stream }));
  expect(response.status).toBe(413);
  expect(await (await call("/projects")).json()).toEqual({ projects: [] });
});
test("explicit HTTPS public origin sets Secure and rejects a spoofed forwarding header", async () => {
  app.close(); app = createHubApplication({ ...config(), publicOrigin: "https://hub.example" });
  const login = await call("/session", { token: operatorToken }, { Origin: "https://hub.example" });
  expect(login.headers.get("set-cookie")).toContain("Secure");
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const response = await app.fetch(new Request("http://hub.test/hub/v1/projects", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example", "X-Forwarded-Host": "evil.example", "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ name: "forged" }) }));
  expect(response.status).toBe(403);
});

test("real HTTP listener binds an ephemeral port and releases persistence on shutdown", async () => {
  const server = startHub({ ...config(), port: 0 });
  try {
    const response = await fetch(new URL("/healthz", server.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  } finally { await server.stop(true); }
  const reopened = createHubApplication(config());
  reopened.close();
});
