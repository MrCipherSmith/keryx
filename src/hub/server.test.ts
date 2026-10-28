// Acceptance tests written before the Hub server implementation. Real filesystem/SQLite,
// HTTP Request/Response boundary, no internal service mocks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeRevision, Evidence, HubApplication, HubConfig, HubDocument, HubFlow, ImportResponse, Project, Proposal } from "./contracts";
import { createHubApplication } from "./server";

const operatorToken = "human-operator-" + "a".repeat(64);
const reviewerToken = "human-reviewer-" + "b".repeat(64);
const agentToken = "local-agent-" + "c".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const encoded = (value: string) => Buffer.from(value).toString("base64");
let app: HubApplication;
let dataDir: string;
let config: HubConfig;

async function request(path: string, options: { method?: string; body?: unknown; token?: string | null; key?: string; cookie?: string; origin?: string } = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.token !== null && !options.cookie) headers.set("Authorization", `Bearer ${options.token ?? operatorToken}`);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.origin) headers.set("Origin", options.origin);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD") headers.set("Idempotency-Key", options.key ?? randomUUID());
  return app.fetch(new Request(`http://hub.test${path.startsWith("/healthz") ? path : `/hub/v1${path}`}`, {
    method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
}
async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}
async function project() { return json<Project>(await request("/projects", { method: "POST", body: { name: "Acceptance project" } })); }
async function imported(p: Project) {
  return json<ImportResponse>(await request(`/projects/${p.id}/import`, { method: "POST", token: agentToken, body: {
    expectedVersion: p.version, sourceRevision: "local-source-1", documents: [
      { path: "wiki/architecture.md", kind: "wiki", content: "# Architecture\nStatus: accepted\nLocal apps stay local." },
      { path: "openspec/specs/hub/spec.md", kind: "spec", content: "# Hub\nHuman accepts exact evidence subject." },
    ],
  } }));
}
async function revision(p: Project, message = "initial") {
  return json<CodeRevision>(await request(`/projects/${p.id}/revisions`, { method: "POST", token: agentToken, body: {
    baseRevisionId: null, gitBaseSha: "a".repeat(40), message,
    changes: [{ path: "src/main.ts", contentBase64: encoded(message), mode: "100644" }],
  } }));
}
async function flowFixture() {
  const p = await project();
  const importedResult = await imported(p);
  const spec = importedResult.documents.find((d) => d.kind === "spec")!;
  let flow = await json<HubFlow>(await request(`/projects/${p.id}/flows`, { method: "POST", token: agentToken, body: { title: "Implement Hub", specDocumentId: spec.id, criteria: ["Human accepts exact subject"] } }));
  flow = await json<HubFlow>(await request(`/projects/${p.id}/flows/${flow.id}/freeze`, { method: "POST", body: { expectedVersion: flow.version } }));
  flow = await json<HubFlow>(await request(`/projects/${p.id}/flows/${flow.id}/start`, { method: "POST", token: agentToken, body: { expectedVersion: flow.version } }));
  return { p, spec, flow, importedResult };
}
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "team-hub-acceptance-"));
  config = { dataDir, operatorToken, agentToken, reviewerToken };
  app = createHubApplication(config);
});
afterEach(() => { app?.close(); rmSync(dataDir, { recursive: true, force: true }); });

describe("Team Hub authenticated durable API", () => {
  test("separates human/agent identity and rejects cookie mutations from another origin", async () => {
    expect((await request("/projects", { token: null })).status).toBe(401);
    const publicHealth = await request("/healthz", { token: null });
    expect(publicHealth.status).toBe(200);
    expect(await publicHealth.json()).toEqual({ ok: true });
    const login = await request("/session", { method: "POST", token: null, body: { token: operatorToken } });
    const session = await json<{ principal: { kind: string; role: string } }>(login);
    expect(session.principal).toMatchObject({ kind: "human", role: "operator" });
    const cookieHeader = login.headers.get("set-cookie")!;
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite");
    const cookie = cookieHeader.split(";")[0]!;
    expect((await request("/projects", { method: "POST", cookie, origin: "https://evil.test", body: { name: "forged" } })).status).toBe(403);
    const agent = await json<{ principal: { kind: string; role: string } }>(await request("/session", { token: agentToken }));
    expect(agent.principal).toMatchObject({ kind: "agent", role: "agent" });
    expect(JSON.stringify(session)).not.toContain(operatorToken);
  });

  test("imports canonical content as unreviewed, then survives restart for a second human", async () => {
    const p = await project();
    const result = await imported(p);
    expect(result.documents).toHaveLength(2);
    expect(result.documents.every((d) => d.approval === "unreviewed")).toBe(true);
    app.close(); app = createHubApplication(config);
    const docs = await json<{ documents: HubDocument[] }>(await request(`/projects/${p.id}/documents`, { token: reviewerToken }));
    expect(docs.documents.map((d) => [d.id, d.contentDigest]).sort()).toEqual(result.documents.map((d) => [d.id, d.contentDigest]).sort());
    const reimport = await json<ImportResponse>(await request(`/projects/${p.id}/import`, { method: "POST", token: agentToken, body: {
      expectedVersion: result.project.version, sourceRevision: "local-source-2", documents: [{ path: result.documents[0]!.path, kind: result.documents[0]!.kind, content: "New unreviewed claim" }],
    } }));
    expect(reimport.proposals).toHaveLength(1);
    const original = await json<HubDocument>(await request(`/projects/${p.id}/documents/${result.documents[0]!.id}`));
    expect(original.content).toBe(result.documents[0]!.content);
  });

  test("reviews only an exact pending proposal as human and prevents lost updates", async () => {
    const p = await project(); const result = await imported(p); const doc = result.documents[0]!;
    const propose = async (content: string) => json<Proposal>(await request(`/projects/${p.id}/proposals`, { method: "POST", token: agentToken, body: { documentId: doc.id, baseVersion: doc.version, content, reason: "Clarify ownership" } }));
    const first = await propose("First correction"); const second = await propose("Concurrent correction");
    const reviewPath = `/projects/${p.id}/proposals/${first.id}/review`;
    const review = { decision: "accepted", expectedVersion: first.version, contentDigest: first.contentDigest };
    expect((await request(reviewPath, { method: "POST", token: agentToken, body: review })).status).toBe(403);
    expect((await request(reviewPath, { method: "POST", body: { ...review, contentDigest: digest("other content") } })).status).toBe(409);
    const accepted = await json<Proposal>(await request(reviewPath, { method: "POST", token: reviewerToken, body: review }));
    expect(accepted.status).toBe("accepted"); expect(accepted.reviewedBy).toBeTruthy(); expect(accepted.receipt).toBeTruthy();
    expect((await request(`/projects/${p.id}/proposals/${second.id}/review`, { method: "POST", body: { decision: "accepted", expectedVersion: second.version, contentDigest: second.contentDigest } })).status).toBe(409);
    const current = await json<HubDocument>(await request(`/projects/${p.id}/documents/${doc.id}`));
    expect(current.content).toBe(first.content); expect(current.version).toBe(doc.version + 1); expect(current.approval).toBe("accepted");
  });

  test("pins Flow criteria, requires matching successful evidence and explicit human trust acknowledgment", async () => {
    const { p, spec, flow: started } = await flowFixture(); let flow = started;
    expect(flow.specContentDigest).toBe(spec.contentDigest); expect(flow.status).toBe("in-progress");
    const r = await revision(p); const another = await revision(p, "other subject");
    const submitPath = `/projects/${p.id}/flows/${flow.id}/submit-for-review`;
    expect((await request(submitPath, { method: "POST", token: agentToken, body: { expectedVersion: flow.version, subjectRevisionId: r.id } })).status).toBe(409);
    const evidence = await json<Evidence>(await request(`/projects/${p.id}/flows/${flow.id}/evidence`, { method: "POST", token: agentToken, body: { subjectRevisionId: r.id, checkId: "acceptance", command: "bun test", exitCode: 0, output: "4 pass" } }));
    expect(evidence.provenance).toBe("self-reported"); expect(evidence.actorId).toBeTruthy();
    flow = await json<HubFlow>(await request(submitPath, { method: "POST", token: agentToken, body: { expectedVersion: flow.version, subjectRevisionId: r.id } }));
    expect(flow.status).toBe("implemented");
    const acceptPath = `/projects/${p.id}/flows/${flow.id}/accept`;
    const acceptance = { expectedVersion: flow.version, subjectRevisionId: r.id, acknowledgeSelfReportedEvidence: true };
    expect((await request(acceptPath, { method: "POST", token: agentToken, body: acceptance })).status).toBe(403);
    expect((await request(acceptPath, { method: "POST", body: { ...acceptance, subjectRevisionId: another.id } })).status).toBe(409);
    const unacknowledged = await request(acceptPath, { method: "POST", body: { ...acceptance, acknowledgeSelfReportedEvidence: false } });
    expect([400, 409]).toContain(unacknowledged.status);
    flow = await json<HubFlow>(await request(acceptPath, { method: "POST", body: acceptance }));
    expect(flow.status).toBe("done"); expect(flow.acceptedBy).toBeTruthy(); expect(flow.receipt).toBeTruthy();
  });

  test("refuses stale pinned specifications and cross-project evidence subjects", async () => {
    const { p, spec, flow } = await flowFixture();
    const other = await project(); const outsideRevision = await revision(other);
    const forbidden = await request(`/projects/${p.id}/flows/${flow.id}/evidence`, { method: "POST", token: agentToken, body: { subjectRevisionId: outsideRevision.id, checkId: "foreign", command: "bun test", exitCode: 0, output: "pass" } });
    expect([400, 404, 409]).toContain(forbidden.status);
    const proposal = await json<Proposal>(await request(`/projects/${p.id}/proposals`, { method: "POST", body: { documentId: spec.id, baseVersion: spec.version, content: "Changed normative criteria", reason: "Changed requirements" } }));
    await json<Proposal>(await request(`/projects/${p.id}/proposals/${proposal.id}/review`, { method: "POST", body: { decision: "accepted", expectedVersion: proposal.version, contentDigest: proposal.contentDigest } }));
    const r = await revision(p);
    await json<Evidence>(await request(`/projects/${p.id}/flows/${flow.id}/evidence`, { method: "POST", token: agentToken, body: { subjectRevisionId: r.id, checkId: "ok", command: "bun test", exitCode: 0, output: "pass" } }));
    expect((await request(`/projects/${p.id}/flows/${flow.id}/submit-for-review`, { method: "POST", body: { expectedVersion: flow.version, subjectRevisionId: r.id } })).status).toBe(409);
  });

  test("freeze is human-only and failed evidence does not qualify for review", async () => {
    const p = await project(); const result = await imported(p); const spec = result.documents.find((d) => d.kind === "spec")!;
    let flow = await json<HubFlow>(await request(`/projects/${p.id}/flows`, { method: "POST", token: agentToken, body: { title: "Failing check", specDocumentId: spec.id, criteria: ["Check passes"] } }));
    expect((await request(`/projects/${p.id}/flows/${flow.id}/freeze`, { method: "POST", token: agentToken, body: { expectedVersion: flow.version } })).status).toBe(403);
    flow = await json<HubFlow>(await request(`/projects/${p.id}/flows/${flow.id}/freeze`, { method: "POST", body: { expectedVersion: flow.version } }));
    flow = await json<HubFlow>(await request(`/projects/${p.id}/flows/${flow.id}/start`, { method: "POST", body: { expectedVersion: flow.version } }));
    const r = await revision(p);
    await json<Evidence>(await request(`/projects/${p.id}/flows/${flow.id}/evidence`, { method: "POST", token: agentToken, body: { subjectRevisionId: r.id, checkId: "tests", command: "bun test", exitCode: 1, output: "FAIL" } }));
    expect((await request(`/projects/${p.id}/flows/${flow.id}/submit-for-review`, { method: "POST", body: { expectedVersion: flow.version, subjectRevisionId: r.id } })).status).toBe(409);
  });

  test("stores immutable incremental revision trees with deletion and human-only versioned line selection", async () => {
    const p = await project();
    const first = await json<CodeRevision>(await request(`/projects/${p.id}/revisions`, { method: "POST", token: agentToken, body: { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "base", changes: [
      { path: "keep.txt", contentBase64: encoded("keep"), mode: "100644" }, { path: "delete.txt", contentBase64: encoded("remove"), mode: "100644" },
    ] } }));
    const second = await json<CodeRevision>(await request(`/projects/${p.id}/revisions`, { method: "POST", token: agentToken, body: { baseRevisionId: first.id, gitBaseSha: first.gitBaseSha, message: "delta", changes: [
      { path: "delete.txt", deleted: true }, { path: "bin/run", contentBase64: encoded("#!/bin/sh\n"), mode: "100755" },
    ] } }));
    expect(second.files.map((f) => f.path).sort()).toEqual(["bin/run", "keep.txt"]);
    expect(second.files.find((f) => f.path === "keep.txt")?.contentDigest).toBe(digest("keep"));
    const original = await json<CodeRevision>(await request(`/projects/${p.id}/revisions/${first.id}`));
    expect(original.files).toHaveLength(2); expect(original.files.some((f) => f.path === "delete.txt")).toBe(true);
    const delta = await json<{ changes: { path: string; deleted?: boolean }[] }>(await request(`/projects/${p.id}/revisions/${second.id}/changes?from=${first.id}`));
    expect(delta.changes.find((c) => c.path === "delete.txt")?.deleted).toBe(true);
    expect(delta.changes.some((c) => c.path === "keep.txt")).toBe(false);
    const linePath = `/projects/${p.id}/line`; const body = { revisionId: second.id, expectedVersion: 0 };
    expect((await request(linePath, { method: "POST", token: agentToken, body })).status).toBe(403);
    const selected = await json<Project>(await request(linePath, { method: "POST", body }));
    expect(selected.lineRevisionId).toBe(second.id); expect(selected.lineVersion).toBe(1);
    expect((await request(linePath, { method: "POST", body: { revisionId: first.id, expectedVersion: 0 } })).status).toBe(409);
  });

  test("replays durable idempotent receipts and rejects changed payloads without duplicate audit events", async () => {
    const p = await project(); const r = await revision(p); const path = `/projects/${p.id}/line`; const key = randomUUID();
    const body = { revisionId: r.id, expectedVersion: 0 };
    const first = await request(path, { method: "POST", key, body }); const status = first.status; const original = await first.json();
    expect(status).toBeGreaterThanOrEqual(200); expect(status).toBeLessThan(300);
    const before = await json<{ events: unknown[]; cursor: number }>(await request(`/projects/${p.id}/events`));
    app.close(); app = createHubApplication(config);
    const replay = await request(path, { method: "POST", key, body }); expect(replay.status).toBe(status); expect(await replay.json()).toEqual(original);
    const after = await json<{ events: unknown[]; cursor: number }>(await request(`/projects/${p.id}/events`)); expect(after).toEqual(before);
    expect((await request(path, { method: "POST", key, body: { ...body, expectedVersion: 1 } })).status).toBe(409);
  });

  test("rejects unsafe snapshot paths and unsupported modes instead of omitting entries", async () => {
    const p = await project();
    for (const change of [{ path: "../escape", contentBase64: encoded("bad"), mode: "100644" }, { path: ".git/config", contentBase64: encoded("bad"), mode: "100644" }, { path: "link", contentBase64: encoded("target"), mode: "120000" }]) {
      expect((await request(`/projects/${p.id}/revisions`, { method: "POST", token: agentToken, body: { baseRevisionId: null, gitBaseSha: "a".repeat(40), message: "unsafe", changes: [change] } })).status).toBe(400);
    }
    const revisions = await json<{ revisions: CodeRevision[] }>(await request(`/projects/${p.id}/revisions`)); expect(revisions.revisions).toHaveLength(0);
  });
});
