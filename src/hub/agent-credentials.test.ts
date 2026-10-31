import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeRevision, Evidence, HubApplication, HubDocument, HubFlow, Project } from "./contracts";
import { createHubApplication, loadHubConfig } from "./server";

const operatorToken = randomBytes(32).toString("hex");
const agentToken = randomBytes(32).toString("hex");
const namedToken = randomBytes(32).toString("hex");
const secondToken = randomBytes(32).toString("hex");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
let root: string;
let file: string;
let app: HubApplication;
const config = () => ({ dataDir: join(root, "data"), operatorToken, agentToken, agentCredentialsFile: file });
function credentials(projectIds: string[], readOnly = false, token = namedToken) {
  return { agents: [{ id: "codex-mac", tokenDigest: hash(token), projectIds, readOnly }] };
}
function save(value: unknown) { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); chmodSync(file, 0o600); }
async function request(path: string, token = namedToken, body?: unknown, key: string = randomUUID()) {
  return app.fetch(new Request(`http://hub.test/hub/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
async function ok<T>(r: Response): Promise<T> { expect(r.status).toBe(200); return r.json() as Promise<T>; }
async function projects() {
  return Promise.all([ok<Project>(await request("/projects", operatorToken, { name: "Allowed" })), ok<Project>(await request("/projects", operatorToken, { name: "Outside" }))]);
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "hub-agents-")); file = join(root, "agents.json"); save({ agents: [] }); app = createHubApplication(config()); });
afterEach(() => { app?.close(); rmSync(root, { recursive: true, force: true }); });

test("named identities filter projects and deny direct REST project scope escapes and creation", async () => {
  const [a, b] = await projects(); save(credentials([a!.id]));
  expect(await ok<{ projects: Project[] }>(await request("/projects"))).toEqual({ projects: [a] });
  expect((await request(`/projects/${a!.id}`)).status).toBe(200);
  expect((await request(`/projects/${b!.id}`)).status).toBe(403);
  expect((await request(`/projects/${b!.id}/documents`)).status).toBe(403);
  expect((await request("/projects", namedToken, { name: "Escape" })).status).toBe(403);
  const session = await ok<{ principal: { id: string; kind: string; tokenDigest?: string } }>(await request("/session"));
  expect(session.principal.id).toBe("agent:codex-mac"); expect(session.principal.kind).toBe("agent");
  expect(JSON.stringify(session)).not.toContain(namedToken); expect(JSON.stringify(session)).not.toContain(hash(namedToken));
  expect((await request("/projects", agentToken)).status).toBe(200);
});

test("read-only change, token rotation and revocation take effect on the next request", async () => {
  const [a] = await projects(); save(credentials([a!.id]));
  expect((await request(`/projects/${a!.id}/revisions`, namedToken, { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "One", changes: [] })).status).toBe(200);
  save(credentials([a!.id], true));
  expect((await request(`/projects/${a!.id}/revisions`)).status).toBe(200);
  expect((await request(`/projects/${a!.id}/revisions`, namedToken, { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "Denied", changes: [] })).status).toBe(403);
  save(credentials([a!.id], false, secondToken));
  expect((await request(`/projects/${a!.id}`)).status).toBe(401);
  expect((await request(`/projects/${a!.id}`, secondToken)).status).toBe(200);
  save({ agents: [] }); expect((await request(`/projects/${a!.id}`, secondToken)).status).toBe(401);
});

test("named agents retain actor-isolated idempotency through rotation", async () => {
  const [a] = await projects(); save(credentials([a!.id]));
  const path = `/projects/${a!.id}/revisions`; const body = { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "Candidate", changes: [] }; const key = "stable-operation";
  const first = await ok<CodeRevision>(await request(path, namedToken, body, key));
  expect(first.createdBy).toBe("agent:codex-mac");
  save(credentials([a!.id], false, secondToken));
  expect(await ok<CodeRevision>(await request(path, secondToken, body, key))).toEqual(first);
  expect((await request(path, secondToken, { ...body, message: "Changed" }, key)).status).toBe(409);
  save({ agents: [...credentials([a!.id], false, secondToken).agents, { id: "claude-server", tokenDigest: hash(namedToken), projectIds: [a!.id], readOnly: false }] });
  const other = await ok<CodeRevision>(await request(path, namedToken, body, key));
  expect(other.id).not.toBe(first.id); expect(other.createdBy).toBe("agent:claude-server");
});

test("reload failures are sanitized and fail closed for agent credentials while human recovery remains usable", async () => {
  const [a] = await projects(); save(credentials([a!.id]));
  const sensitive = `malformed-${namedToken}-${file}`; writeFileSync(file, sensitive);
  for (const token of [namedToken, agentToken]) {
    const r = await request("/projects", token); expect(r.status).toBe(503); const text = await r.text();
    expect(text).not.toContain(namedToken); expect(text).not.toContain(file); expect(text).not.toContain(sensitive);
  }
  expect((await request("/projects", operatorToken)).status).toBe(200);
  rmSync(file); expect((await request("/projects")).status).toBe(503);
});

test("startup rejects malformed, oversized, weakly protected or non-regular credentials files", () => {
  app.close();
  for (const value of [{ agents: [{ id: "connector", tokenDigest: hash(namedToken), projectIds: [] }] }, { agents: [{ id: "a", tokenDigest: hash(operatorToken), projectIds: [] }] }, { agents: [{ id: "a", tokenDigest: hash(namedToken), projectIds: ["../p"] }] }, { agents: [{ id: "a", tokenDigest: hash(namedToken), projectIds: [], token: namedToken }] }, { agents: [{ id: "a", tokenDigest: hash(namedToken), projectIds: [] }, { id: "a", tokenDigest: hash(secondToken), projectIds: [] }] }]) {
    save(value); expect(() => createHubApplication(config())).toThrow("agent credentials");
  }
  save({ agents: [] }); chmodSync(file, 0o644); expect(() => createHubApplication(config())).toThrow("agent credentials");
  writeFileSync(file, " ".repeat(65537)); chmodSync(file, 0o600); expect(() => createHubApplication(config())).toThrow("agent credentials");
  rmSync(file); mkdirSync(file); expect(() => createHubApplication(config())).toThrow("agent credentials");
  rmSync(file, { recursive: true }); const target = join(root, "target.json"); writeFileSync(target, JSON.stringify({ agents: [] }), { mode: 0o600 }); symlinkSync(target, file); expect(() => createHubApplication(config())).toThrow("agent credentials");
});

test("configured environment path is loaded and validation rejects an unavailable path", () => {
  const c = loadHubConfig({ KERYX_HUB_OPERATOR_TOKEN: operatorToken, KERYX_HUB_AGENT_TOKEN: agentToken, KERYX_HUB_AGENT_CREDENTIALS_FILE: file });
  expect(c).toHaveProperty("agentCredentialsFile", file);
  expect(() => loadHubConfig({ KERYX_HUB_OPERATOR_TOKEN: operatorToken, KERYX_HUB_AGENT_TOKEN: agentToken, KERYX_HUB_AGENT_CREDENTIALS_FILE: "" })).toThrow("agent credentials");
  expect(() => loadHubConfig({ KERYX_HUB_OPERATOR_TOKEN: operatorToken, KERYX_HUB_AGENT_TOKEN: agentToken, KERYX_HUB_AGENT_CREDENTIALS_FILE: join(root, "missing") })).toThrow("agent credentials");
});

test("current named token is redacted from Evidence command/output and durable state", async () => {
  const [a] = await projects(); save(credentials([a!.id]));
  const imported = await ok<{ documents: HubDocument[] }>(await request(`/projects/${a!.id}/import`, operatorToken, { expectedVersion: a!.version, sourceRevision: "fixture", documents: [{ path: "spec.md", kind: "spec", content: "Specification" }] }));
  let f = await ok<HubFlow>(await request(`/projects/${a!.id}/flows`, operatorToken, { title: "Task", specDocumentId: imported.documents[0]!.id, criteria: ["Done"] }));
  f = await ok<HubFlow>(await request(`/projects/${a!.id}/flows/${f.id}/freeze`, operatorToken, { expectedVersion: f.version }));
  f = await ok<HubFlow>(await request(`/projects/${a!.id}/flows/${f.id}/start`, namedToken, { expectedVersion: f.version }));
  const revision = await ok<CodeRevision>(await request(`/projects/${a!.id}/revisions`, namedToken, { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "Candidate", changes: [] }));
  const body = { subjectRevisionId: revision.id, checkId: "test", command: `echo ${namedToken}`, output: `secret ${namedToken}`, exitCode: 0 };
  const evidence = await ok<Evidence>(await request(`/projects/${a!.id}/flows/${f.id}/evidence`, namedToken, body, "evidence-redaction"));
  expect(evidence.actorId).toBe("agent:codex-mac"); expect(evidence.command).toBe("echo [REDACTED]"); expect(evidence.output).toBe("secret [REDACTED]");
  expect(readFileSync(join(root, "data", "hub.sqlite")).includes(Buffer.from(namedToken))).toBe(false);
  const changed = await request(`/projects/${a!.id}/flows/${f.id}/evidence`, namedToken, { ...body, output: "secret [REDACTED]" }, "evidence-redaction");
  expect(changed.status).toBe(409);
});

test("outer MCP route rejects missing, cookie-only and human credentials before SDK dispatch", async () => {
  for (const headers of [{}, { Cookie: "keryx_hub_session=not-an-agent" }, { Authorization: `Bearer ${operatorToken}` }]) {
    const response = await app.fetch(new Request("http://hub.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }));
    expect(response.status).toBe(headers.Authorization ? 403 : 401);
  }
  const response = await app.fetch(new Request("http://hub.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${agentToken}`, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(403);
});


test("permission reload rejects a mutation downgraded while its body was being received", async () => {
  const [a] = await projects(); save(credentials([a!.id]));
  let entered!: () => void; const reading = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const ready = new Promise<void>((resolve) => { release = resolve; });
  const body = { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "Must not commit", changes: [] };
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { entered(); await ready; controller.enqueue(Buffer.from(JSON.stringify(body))); controller.close(); } }, { highWaterMark: 0 });
  const response = app.fetch(new Request(`http://hub.test/hub/v1/projects/${a!.id}/revisions`, { method: "POST", headers: { Authorization: `Bearer ${namedToken}`, "Content-Type": "application/json", "Idempotency-Key": "pending-write" }, body: stream }));
  await reading; save(credentials([a!.id], true)); release();
  expect((await response).status).toBe(403);
  expect(await ok<{ revisions: CodeRevision[] }>(await request(`/projects/${a!.id}/revisions`))).toEqual({ revisions: [] });
});

test("real SDK clients retain distinct scoped identities and read-only MCP reads use POST safely", async () => {
  const [a, b] = await projects();
  save({ agents: [...credentials([a!.id]).agents, { id: "claude-server", tokenDigest: hash(secondToken), projectIds: [b!.id], readOnly: true }] });
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => app.fetch(r) });
  // SDK 1.30 exposes sessionId:string|undefined, wider than Transport's optional property.
  // The client contract does not need this getter; keep the actual SDK transport unchanged.
  const transport = (token: string): Omit<InstanceType<typeof StreamableHTTPClientTransport>, "sessionId"> => new StreamableHTTPClientTransport(new URL("/mcp", server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const writer = new Client({ name: "writer", version: "1" }); const reader = new Client({ name: "reader", version: "1" });
  try {
    await Promise.all([writer.connect(transport(namedToken)), reader.connect(transport(secondToken))]);
    const [first, second] = await Promise.all([writer.callTool({ name: "hub_list_projects", arguments: {} }), reader.callTool({ name: "hub_list_projects", arguments: {} })]);
    expect(JSON.stringify(first)).toContain(a!.id); expect(JSON.stringify(first)).not.toContain(b!.id);
    expect(JSON.stringify(second)).toContain(b!.id); expect(JSON.stringify(second)).not.toContain(a!.id);
    const read = await reader.callTool({ name: "hub_get_project", arguments: { projectId: b!.id } }); expect(read.isError).not.toBe(true);
    const denied = await reader.callTool({ name: "hub_create_revision", arguments: { projectId: b!.id, baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "Forbidden", changes: [], operationId: "read-only-write" } });
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain("agent-read-only");
    save({ agents: [] }); await expect(writer.listTools()).rejects.toThrow();
  } finally { await writer.close(); await reader.close(); await server.stop(true); }
});


test("Evidence original payload replays through same-agent key rotation without storing the key", async () => {
  const [a] = await projects(); save(credentials([a!.id]));
  const imported = await ok<{ documents: HubDocument[] }>(await request(`/projects/${a!.id}/import`, operatorToken, { expectedVersion: a!.version, sourceRevision: "fixture", documents: [{ path: "spec.md", kind: "spec", content: "Specification" }] }));
  let f = await ok<HubFlow>(await request(`/projects/${a!.id}/flows`, operatorToken, { title: "Task", specDocumentId: imported.documents[0]!.id, criteria: ["Done"] }));
  f = await ok<HubFlow>(await request(`/projects/${a!.id}/flows/${f.id}/freeze`, operatorToken, { expectedVersion: f.version }));
  f = await ok<HubFlow>(await request(`/projects/${a!.id}/flows/${f.id}/start`, namedToken, { expectedVersion: f.version }));
  const revision = await ok<CodeRevision>(await request(`/projects/${a!.id}/revisions`, namedToken, { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "Candidate", changes: [] }));
  const path = `/projects/${a!.id}/flows/${f.id}/evidence`;
  const body = { subjectRevisionId: revision.id, checkId: "rotation", command: "test", output: `secret ${namedToken}`, exitCode: 0 };
  const first = await ok<Evidence>(await request(path, namedToken, body, "rotate-evidence"));
  save(credentials([a!.id], false, secondToken));
  const replay = await ok<Evidence>(await request(path, secondToken, body, "rotate-evidence"));
  expect(replay).toEqual(first); expect(replay.output).toBe("secret [REDACTED]");
  const reports = await ok<{ evidence: Evidence[] }>(await request(path, secondToken)); expect(reports.evidence).toHaveLength(1);
  expect(JSON.stringify(reports)).not.toContain(namedToken);
});
