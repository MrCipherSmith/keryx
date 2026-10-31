import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubApplication } from "./server";
import { handleHubMcp } from "./mcp";
import type { HubApplication, HubFlow, Project, ImportResponse, CodeRevision } from "./contracts";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const operator = "test-operator-" + "a".repeat(64);
const agent = "test-agent-" + "b".repeat(64);
let app: HubApplication;
let dir: string;
let server: ReturnType<typeof Bun.serve>;
const clients: InstanceType<typeof Client>[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-mcp-"));
  app = createHubApplication({ dataDir: dir, operatorToken: operator, agentToken: agent });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (new URL(request.url).pathname !== "/mcp") return app.fetch(request);
    const bearer = request.headers.get("authorization");
    if (bearer !== `Bearer ${agent}`) return new Response("", { status: 401 });
    return handleHubMcp(request, { actor: { id: "agent:connector", kind: "agent", role: "agent" }, apiFetch: r => app.fetch(r) });
  } });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server.stop(true); app.close(); rmSync(dir, { recursive: true, force: true });
});
async function client() {
  const value = new Client({ name: "hub-mcp-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", server.url), { requestInit: { headers: { Authorization: `Bearer ${agent}` } } });
  // SDK1.30's getter is wider than Transport under exactOptionalPropertyTypes.
  // Hide the unused optional session getter from the structural type; runtime transport is unchanged.
  const link: Omit<typeof transport, "sessionId"> = transport;
  await value.connect(link);
  clients.push(value); return value;
}
async function rest<T>(path: string, body?: unknown): Promise<T> {
  const r = await app.fetch(new Request("http://hub.test/hub/v1" + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${operator}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  expect(r.status).toBe(200); return r.json() as Promise<T>;
}
async function fixture() {
  const project = await rest<Project>("/projects", { name: "MCP project" });
  const imported = await rest<ImportResponse>(`/projects/${project.id}/import`, { expectedVersion: 1, sourceRevision: "fixture", documents: [{ path: "specs/task.md", kind: "spec", content: "# MCP task" }] });
  const spec = imported.documents[0]!;
  let flow = await rest<HubFlow>(`/projects/${project.id}/flows`, { title: "MCP lifecycle", specDocumentId: spec.id, criteria: ["Human accepts"] });
  flow = await rest<HubFlow>(`/projects/${project.id}/flows/${flow.id}/freeze`, { expectedVersion: flow.version });
  return { project, flow, spec };
}
function data(result: Awaited<ReturnType<InstanceType<typeof Client>["callTool"]>>) {
  const content = result.content;
  if (!Array.isArray(content) || content[0]?.type !== "text" || typeof content[0].text !== "string") throw Error("Expected JSON text result");
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

test("official SDK initializes, discovers a fixed annotated catalogue, and reads real Hub data", async () => {
  const { project, spec } = await fixture(); const c = await client();
  const list = await c.listTools(); expect(list.tools).toHaveLength(15);
  expect(list.tools.find(t => t.name === "hub_get_document")?.annotations?.readOnlyHint).toBe(true);
  expect(list.tools.find(t => t.name === "hub_create_revision")?.annotations?.readOnlyHint).toBe(false);
  expect(list.tools.map(t => t.name)).not.toContain("hub_accept_flow");
  expect(data(await c.callTool({ name: "hub_list_projects", arguments: {} })).projects).toEqual([expect.objectContaining({ id: project.id })]);
  expect(data(await c.callTool({ name: "hub_get_document", arguments: { projectId: project.id, documentId: spec.id } })).content).toBe("# MCP task");
  expect(data(await c.callTool({ name: "hub_get_context", arguments: { projectId: project.id } })).fullSnapshot).toBe(true);
  expect(Array.isArray(data(await c.callTool({ name: "hub_get_events", arguments: { projectId: project.id, after: 0 } })).events)).toBe(true);
});

test("SDK mutations preserve replay/conflict, exact revision Evidence and human acceptance boundary", async () => {
  const { project, flow } = await fixture(); const c = await client();
  const start = { projectId: project.id, flowId: flow.id, expectedVersion: flow.version, operationId: "start-one" };
  const started = data(await c.callTool({ name: "hub_start_flow", arguments: start })); expect(started.status).toBe("in-progress");
  expect(data(await c.callTool({ name: "hub_start_flow", arguments: start }))).toEqual(started);
  const create = { projectId: project.id, baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "review", purpose: "review-bundle", changes: [{ path: "change.patch", contentBase64: "YQ==" }], operationId: "revision-one" };
  const revision = data(await c.callTool({ name: "hub_create_revision", arguments: create })); expect(revision.createdBy).toBe("agent:connector");
  expect(data(await c.callTool({ name: "hub_create_revision", arguments: create }))).toEqual(revision);
  const conflict = await c.callTool({ name: "hub_create_revision", arguments: { ...create, message: "changed" } }); expect(conflict.isError).toBe(true); expect(JSON.stringify(conflict)).toContain("idempotency-conflict");
  const summary = data(await c.callTool({ name: "hub_list_revisions", arguments: { projectId: project.id } })); expect(JSON.stringify(summary)).not.toContain("contentBase64");
  expect(data(await c.callTool({ name: "hub_get_revision", arguments: { projectId: project.id, revisionId: revision.id } })).id).toBe(revision.id);
  const evidence = data(await c.callTool({ name: "hub_add_evidence", arguments: { projectId: project.id, flowId: flow.id, subjectRevisionId: revision.id, checkId: "sdk", command: "test", exitCode: 0, output: "pass", operationId: "evidence-one" } })); expect(evidence.actorId).toBe("agent:connector");
  const submitted = data(await c.callTool({ name: "hub_submit_for_review", arguments: { projectId: project.id, flowId: flow.id, expectedVersion: started.version, subjectRevisionId: revision.id, operationId: "submit-one" } })); expect(submitted.status).toBe("implemented");
  expect(data(await c.callTool({ name: "hub_get_evidence", arguments: { projectId: project.id, flowId: flow.id } })).evidence).toEqual([expect.objectContaining({ subjectRevisionId: revision.id })]);
  expect((await rest<Project>(`/projects/${project.id}`)).lineRevisionId).toBeNull();
});

test("closed schemas and allowlist reject extra keys, traversal, missing operation keys and forbidden tools", async () => {
  const c = await client();
  for (const args of [ { projectId: ".." }, { projectId: "a/b" }, { projectId: "ok", arbitrary: true } ]) {
    const r = await c.callTool({ name: "hub_get_project", arguments: args }); expect(r.isError).toBe(true); expect(JSON.stringify(r)).toContain("invalid-arguments");
  }
  expect((await c.callTool({ name: "hub_start_flow", arguments: { projectId: "p", flowId: "f", expectedVersion: 2 } })).isError).toBe(true);
  expect((await c.callTool({ name: "hub_accept_flow", arguments: {} })).isError).toBe(true);
});

test("tool invocation retains cross-project domain scope and sanitizes unexpected API errors", async () => {
  const { project } = await fixture(); const other = await fixture(); const c = await client();
  const denied = await c.callTool({ name: "hub_get_document", arguments: { projectId: project.id, documentId: other.spec.id } }); expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain("not-found");
  const request = new Request("http://hub.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${agent}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hub_list_projects", arguments: {} } }) });
  const r = await handleHubMcp(request, { actor: { id: "agent:test", kind: "agent", role: "agent" }, apiFetch: async () => { throw Error("SECRET_INTERNAL_PATH " + agent); } });
  expect(await r.text()).not.toContain("SECRET_INTERNAL_PATH");
});

test("HTTP adapter bounds malformed bodies and gives explicit stateless notification/method outcomes", async () => {
  const context = { actor: { id: "agent:test", kind: "agent" as const, role: "agent" as const }, apiFetch: (r: Request) => app.fetch(r) };
  const headers = { Authorization: `Bearer ${agent}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  for (const method of ["GET", "DELETE", "PUT"]) expect((await handleHubMcp(new Request("http://hub.test/mcp", { method, headers }), context)).status).toBe(405);
  expect((await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers, body: "{" }), context)).status).toBe(400);
  expect((await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers: { ...headers, "Content-Length": String(33 * 1024 * 1024) }, body: "{}" }), context)).status).toBe(413);
  const notification = await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), context); expect(notification.status).toBe(202); expect(await notification.text()).toBe("");
  const response = await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), { ...context, actor: { id: "human:test", kind: "human", role: "operator" } }); expect(response.status).toBe(403);
});

test("concurrent SDK clients keep independent calls and return no incoming bearer secret", async () => {
  const { project } = await fixture(); const a = await client(); const b = await client();
  const values = await Promise.all([a.callTool({ name: "hub_get_project", arguments: { projectId: project.id } }), b.callTool({ name: "hub_list_flows", arguments: { projectId: project.id } })]);
  expect(data(values[0]!).id).toBe(project.id); expect(Array.isArray(data(values[1]!).flows)).toBe(true);
  expect(JSON.stringify(values)).not.toContain(agent);
  const revision = await rest<CodeRevision>(`/projects/${project.id}/revisions`, { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: agent, changes: [] });
  expect(JSON.stringify(await a.callTool({ name: "hub_get_revision", arguments: { projectId: project.id, revisionId: revision.id } }))).not.toContain(agent);
});

test("transport rejects actual oversized bytes, invalid protocol headers and JSON-RPC batches", async () => {
  const context = { actor: { id: "agent:test", kind: "agent" as const, role: "agent" as const }, apiFetch: (r: Request) => app.fetch(r) };
  const headers = { Authorization: `Bearer ${agent}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const oversized = new Request("http://hub.test/mcp", { method: "POST", headers, body: new Uint8Array(32 * 1024 * 1024 + 1) });
  expect((await handleHubMcp(oversized, context)).status).toBe(413);
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  expect((await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers: { ...headers, "MCP-Protocol-Version": "2099-01-01" }, body: JSON.stringify(ping) }), context)).status).toBe(400);
  expect((await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers, body: JSON.stringify([ping]) }), context)).status).toBe(400);
});

test("redaction covers escaped token text and Cloudflare service credentials in successful tool responses", async () => {
  const secret = 'opaque-"quoted\\key-' + "x".repeat(32); const cfSecret = "cloudflare-secret-" + "z".repeat(32);
  const request = new Request("http://hub.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "CF-Access-Client-Secret": cfSecret, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hub_list_projects", arguments: {} } }) });
  const r = await handleHubMcp(request, { actor: { id: "agent:test", kind: "agent", role: "agent" }, apiFetch: async () => Response.json({ projects: [{ note: secret, metadata: cfSecret }] }) });
  const value = await r.json();
  expect(JSON.parse(value.result.content[0].text)).toEqual({ projects: [{ note: "[REDACTED]", metadata: "[REDACTED]" }] });
});

test("F-MCP-001: credential redaction preserves JSON for trailing backslashes and quoted secrets", async () => {
  for (const secret of ["opaque-" + "x".repeat(32) + "\\", 'opaque-"quoted-' + "x".repeat(32) + "\\", "opaque-" + "x".repeat(32) + "\\\\"]) {
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const payload = { jsonrpc: "2.0", id: "ordinary-call-id", method: "tools/call", params: { name: "hub_list_projects", arguments: {} } };
    const context = { actor: { id: "agent:test", kind: "agent" as const, role: "agent" as const }, apiFetch: async () => Response.json({ projects: [{ note: secret, nested: [secret, { again: secret }] }] }) };
    const result = await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers, body: JSON.stringify(payload) }), context);
    expect(result.status).toBe(200);
    const envelope = await result.json(); expect(envelope.id).toBe("ordinary-call-id");
    expect(JSON.parse(envelope.result.content[0].text)).toEqual({ projects: [{ note: "[REDACTED]", nested: ["[REDACTED]", { again: "[REDACTED]" }] }] });
    const protocolError = await handleHubMcp(new Request("http://hub.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "ordinary-error-id", method: "method-not-present", params: { note: secret } }) }), context);
    const error = await protocolError.json(); expect(error.id).toBe("ordinary-error-id"); expect(error.error.code).toBe(-32601);
    expect(JSON.stringify(error)).not.toContain(secret);
  }
});

test("credential-bearing request IDs are rejected before execution without changing benign IDs", async () => {
  const secret = "opaque-" + "x".repeat(32) + "\\"; let calls = 0;
  const request = new Request("http://hub.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "id:" + secret, method: "tools/call", params: { name: "hub_list_projects", arguments: {} } }) });
  const result = await handleHubMcp(request, { actor: { id: "agent:test", kind: "agent", role: "agent" }, apiFetch: async () => { calls++; return Response.json({ projects: [] }); } });
  expect(result.status).toBe(400); expect(calls).toBe(0);
  const error = await result.json(); expect(error.error.code).toBe("invalid-request"); expect(JSON.stringify(error)).not.toContain(secret);
});

test("F-MCP-001: official SDK callTool parses structured results with escaped opaque credentials", async () => {
  for (const secret of ["sdk-" + "y".repeat(32) + "\\", 'sdk-"quoted-' + "y".repeat(32) + "\\"]) {
    const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handleHubMcp(request, { actor: { id: "agent:opaque", kind: "agent", role: "agent" }, apiFetch: async () => Response.json({ projects: [{ note: secret, nested: { note: secret } }] }) }) });
    const c = new Client({ name: "opaque-credential-regression", version: "1" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } });
      const link: Omit<typeof transport, "sessionId"> = transport;
      await c.connect(link);
      const result = await c.callTool({ name: "hub_list_projects", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(data(result)).toEqual({ projects: [{ note: "[REDACTED]", nested: { note: "[REDACTED]" } }] });
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally { await c.close(); await endpoint.stop(true); }
  }
});
