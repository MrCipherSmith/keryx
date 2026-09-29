// R4d (flow 369): the approval routes, driven through `handleServeRequest` with the
// production submission pipeline and a real broker. No network, no provider.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { registerProject } from "./project-registry";
import { createApprovalBroker, createConsumerRegistry } from "./serve-approvals-broker";
import { createApproval, listApprovals, newApprovalId, readApproval, readApprovalEvidence, type ApprovalView } from "./serve-approvals-store";
import { CountingExecutor, registryOf, ScriptedProvider, tool, waitFor } from "./serve-approvals.test-helpers";
import { defaultServeConfig } from "./serve-config";
import { issueServeToken, readServeCredential, type ServeCredentialRecord } from "./serve-credential";
import { handleServeRequest, type ServeContext } from "./serve-server";
import { createSubmitTurn } from "./serve-turn";
import { readTurnRecord } from "./serve-turn-store";

let configDir = "";
let project = "";
let token = "";
let credential: ServeCredentialRecord;
let executor: CountingExecutor;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-r4d-route-")));
  configDir = path.join(base, "config");
  project = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(project, ".metaproject"), { recursive: true });
  const issued = issueServeToken(configDir);
  if (!issued.ok) {
    throw new Error("fixture could not issue a token");
  }
  token = issued.token;
  credential = issued.record;
  registerProject(project, { dir: configDir });
  executor = new CountingExecutor();
});

afterEach(() => {
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

interface FixtureOptions {
  expirySeconds?: number;
  requireConsumer?: boolean;
  canSee?: (view: ApprovalView) => boolean;
}

function fixture(options: FixtureOptions = {}): ServeContext {
  const consumers = createConsumerRegistry();
  const broker = createApprovalBroker({
    dir: configDir,
    expirySeconds: options.expirySeconds ?? 300,
    maxPending: 4,
    requireConsumer: options.requireConsumer ?? true,
    hasConsumer: () => consumers.attached(),
    pollMs: 5,
  });
  const submitTurn = createSubmitTurn({
    profile: resolveLocalProfile("unattended-untrusted"),
    provider: new ScriptedProvider([{ id: "call-1", name: "do_thing", input: '{"body":"SECRET-ARGUMENT-VALUE"}' }]),
    providerName: "scripted-stub",
    model: "stub-model",
    dir: configDir,
    containmentAvailable: () => true,
    hooksEnv: { KERYX_HOOKS: "off" },
    toolRegistry: registryOf(tool("do_thing", "write")),
    toolExecutor: executor,
    approvals: broker,
  });
  return {
    config: defaultServeConfig(credential.id, { port: 0 }),
    resolveCredential: () => readServeCredential(configDir),
    nonLoopback: false,
    boundPort: 12345,
    dir: configDir,
    state: () => "listening" as const,
    submitTurn,
    approvals: {
      consumers,
      wake: () => broker.wake(),
      ...(options.canSee !== undefined ? { canSee: options.canSee } : {}),
    },
  };
}

function req(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function submit(ctx: ServeContext, body: Record<string, unknown> = {}): Promise<{ turnId: string; status: number }> {
  const response = await handleServeRequest(req("POST", "/v1/turns", { schemaVersion: "1.0.0", project, prompt: "do it", ...body }), ctx);
  const parsed = await json(response);
  return { turnId: String(parsed.turnId), status: response.status };
}

function answer(ctx: ServeContext, id: string, decision: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleServeRequest(req("POST", `/v1/approvals/${id}`, { decision }, headers), ctx);
}

async function pendingIds(ctx: ServeContext): Promise<string[]> {
  const listed = await json(await handleServeRequest(req("GET", "/v1/approvals"), ctx));
  return (listed.approvals as Array<{ approvalId: string }>).map((entry) => entry.approvalId);
}

function seed(overrides: Partial<Parameters<typeof createApproval>[0]> = {}): string {
  const approvalId = newApprovalId();
  createApproval(
    {
      approvalId,
      turnId: randomUUID(),
      sessionId: randomUUID(),
      summary: "Run tool",
      scope: "This call only",
      consequence: "Writes",
      expiresAt: new Date(Date.now() + 300_000),
      correlationId: randomUUID(),
      callFingerprint: "a".repeat(64),
      floors: [],
      ...overrides,
    },
    configDir,
  );
  return approvalId;
}

async function finished(turnId: string) {
  await waitFor(() => {
    const record = readTurnRecord(turnId, configDir);
    return record.ok && record.value.result !== undefined;
  });
  const record = readTurnRecord(turnId, configDir);
  return record.ok ? record.value.result : undefined;
}

describe("GET /v1/approvals", () => {
  test("lists a pending approval as the schema's projection, with no arguments and no fingerprint", async () => {
    const ctx = fixture();
    const { turnId, status } = await submit(ctx, { stream: true });
    expect(status).toBe(202);
    const running = readTurnRecord(turnId, configDir);
    expect(running.ok && running.value.result).toBeFalsy();
    await waitFor(() => listApprovals(configDir).length === 1);

    const response = await handleServeRequest(req("GET", "/v1/approvals"), ctx);
    expect(response.status).toBe(200);
    const raw = await response.clone().text();
    const body = await json(response);
    expect(body.schemaVersion).toBe("1.0.0");
    const [entry] = body.approvals as Array<Record<string, unknown>>;
    expect(Object.keys(entry!).sort()).toEqual(
      ["approvalId", "consequence", "correlationId", "createdAt", "expiresAt", "schemaVersion", "scope", "sessionId", "state", "summary", "turnId"].sort(),
    );
    expect(entry!.state).toBe("pending");
    expect(raw).not.toContain("SECRET-ARGUMENT-VALUE");
    expect(raw).not.toContain("callFingerprint");

    await answer(ctx, String(entry!.approvalId), "deny");
    await finished(turnId);
  });

  test("resolved approvals are listed only on request", async () => {
    const ctx = fixture();
    const id = seed();
    await answer(ctx, id, "deny");
    expect(await pendingIds(ctx)).toEqual([]);
    const all = await json(await handleServeRequest(req("GET", "/v1/approvals?state=all"), ctx));
    expect((all.approvals as Array<{ approvalId: string }>).map((entry) => entry.approvalId)).toEqual([id]);
  });

  test("needs the bearer token, like every route", async () => {
    const ctx = fixture();
    const response = await handleServeRequest(new Request("http://127.0.0.1/v1/approvals"), ctx);
    expect(response.status).toBe(401);
  });

  test("only GET is accepted", async () => {
    const response = await handleServeRequest(req("POST", "/v1/approvals", {}), fixture());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

describe("POST /v1/approvals/{id}", () => {
  test("an allow is applied once, the turn continues and the call runs exactly once", async () => {
    const ctx = fixture();
    const { turnId } = await submit(ctx, { stream: true });
    await waitFor(() => listApprovals(configDir).length === 1);
    const [id] = await pendingIds(ctx);

    const first = await answer(ctx, id!, "allow");
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ schemaVersion: "1.0.0", approvalId: id, state: "allowed", replay: false });

    const result = await finished(turnId);
    expect(result?.outcome).toBe("completed");
    expect(executor.names).toEqual(["do_thing"]);

    const replay = await answer(ctx, id!, "allow");
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ state: "allowed", replay: true });
    expect(executor.names).toEqual(["do_thing"]);
  });

  test("a replay with the OTHER decision returns the original outcome and changes nothing", async () => {
    const ctx = fixture();
    const id = seed();
    expect(await json(await answer(ctx, id, "deny"))).toMatchObject({ state: "denied", replay: false });
    const flipped = await answer(ctx, id, "allow");
    expect(flipped.status).toBe(200);
    expect(await json(flipped)).toMatchObject({ state: "denied", replay: true });
    const view = readApproval(id, configDir);
    expect(view.ok && view.value.state).toBe("denied");
    expect(readApprovalEvidence(configDir).filter((event) => event.approvalId === id && event.kind === "resolved")).toHaveLength(1);
  });

  test("concurrent conflicting answers apply exactly one", async () => {
    const ctx = fixture();
    const id = seed();
    const responses = await Promise.all([answer(ctx, id, "allow"), answer(ctx, id, "deny"), answer(ctx, id, "allow"), answer(ctx, id, "deny")]);
    const bodies = await Promise.all(responses.map(json));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(bodies.filter((body) => body.replay === false)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.state)).size).toBe(1);
    expect(readApprovalEvidence(configDir).filter((event) => event.approvalId === id && event.kind === "resolved")).toHaveLength(1);
  });

  test("an expired approval answers 410 and is already a deny", async () => {
    const ctx = fixture();
    const id = seed({ expiresAt: new Date(Date.now() - 1_000) });
    const response = await answer(ctx, id, "allow");
    expect(response.status).toBe(410);
    expect((await json(response)).error).toMatchObject({ code: "expired" });
    const view = readApproval(id, configDir);
    expect(view.ok && view.value.state).toBe("expired");
  });

  test("an undeliverable approval also answers 410", async () => {
    const ctx = fixture();
    const id = seed();
    const { resolveApproval } = await import("./serve-approvals-store");
    resolveApproval(id, { state: "undeliverable", reason: "no-consumer-attached" }, configDir);
    expect((await answer(ctx, id, "allow")).status).toBe(410);
  });

  test("the turn that raised an approval cannot answer it, and nothing changes", async () => {
    const ctx = fixture();
    const turnId = randomUUID();
    const id = seed({ turnId });
    const response = await answer(ctx, id, "allow", { "x-keryx-turn": turnId });
    expect(response.status).toBe(403);
    const view = readApproval(id, configDir);
    expect(view.ok && view.value.state).toBe("pending");
    expect(readApprovalEvidence(configDir).some((event) => event.approvalId === id && event.kind === "resolved")).toBe(false);
    expect((await answer(ctx, id, "allow", { "x-keryx-turn": randomUUID() })).status).toBe(200);
  });

  test("an unknown id, a malformed id and an id the token may not see are one indistinguishable 404", async () => {
    const hidden = seed();
    const ctx = fixture({ canSee: (view) => view.approvalId !== hidden });
    const unknown = await answer(ctx, randomUUID(), "allow");
    const malformed = await handleServeRequest(req("POST", "/v1/approvals/not-an-id", { decision: "allow" }), ctx);
    const unseen = await answer(ctx, hidden, "allow");
    for (const response of [unknown, malformed, unseen]) {
      expect(response.status).toBe(404);
    }
    const bodies = await Promise.all([unknown, malformed, unseen].map((response) => response.text()));
    expect(new Set(bodies).size).toBe(1);
    const view = readApproval(hidden, configDir);
    expect(view.ok && view.value.state).toBe("pending");
  });

  test("an approval the token may not see is absent from the list too", async () => {
    const hidden = seed();
    const shown = seed();
    const ctx = fixture({ canSee: (view) => view.approvalId !== hidden });
    expect(await pendingIds(ctx)).toEqual([shown]);
  });

  const malformedBodies: Array<[string, unknown]> = [
    ["not JSON", "{nope"],
    ["an empty object", {}],
    ["an unknown decision", { decision: "maybe" }],
    ["a non-string decision", { decision: true }],
    ["an array", ["allow"]],
    ["an extra field that asks for a standing grant", { decision: "allow", trustMcpTool: true }],
    ["an extra field that names arguments", { decision: "allow", arguments: { body: "x" } }],
  ];
  for (const [label, body] of malformedBodies) {
    test(`a malformed body (${label}) is rejected before any state change`, async () => {
      const ctx = fixture();
      const id = seed();
      const before = readApprovalEvidence(configDir).length;
      const response = await handleServeRequest(req("POST", `/v1/approvals/${id}`, body), ctx);
      expect(response.status).toBe(400);
      const view = readApproval(id, configDir);
      expect(view.ok && view.value.state).toBe("pending");
      expect(readApprovalEvidence(configDir)).toHaveLength(before);
    });
  }

  test("a body that is not application/json is rejected", async () => {
    const ctx = fixture();
    const id = seed();
    const response = await handleServeRequest(
      new Request(`http://127.0.0.1/v1/approvals/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: '{"decision":"allow"}' }),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  test("an oversized body is refused", async () => {
    const ctx = fixture();
    const id = seed();
    const response = await handleServeRequest(req("POST", `/v1/approvals/${id}`, JSON.stringify({ decision: "allow", pad: "x".repeat(10_000) })), ctx);
    expect([400, 413]).toContain(response.status);
  });

  test("only POST is accepted on an approval", async () => {
    const id = seed();
    const response = await handleServeRequest(req("GET", `/v1/approvals/${id}`), fixture());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("delivery and status", () => {
  test("a turn nobody is consuming is undeliverable at once, and the client is told through the stream and the result", async () => {
    const ctx = fixture({ requireConsumer: true });
    const { turnId } = await submit(ctx, { stream: false });
    const result = await finished(turnId);
    expect(result?.outcome).toBe("denied");
    expect(result?.reasonCode).toBe("approval-undeliverable");
    expect(executor.names).toEqual([]);
    expect(await pendingIds(ctx)).toEqual([]);
  });

  test("listing approvals is what makes a consumer, and a listed approval is deliverable", async () => {
    const ctx = fixture({ requireConsumer: true });
    await handleServeRequest(req("GET", "/v1/approvals"), ctx);
    const { turnId } = await submit(ctx, { stream: false });
    await waitFor(() => listApprovals(configDir).length === 1);
    expect(listApprovals(configDir)[0]!.state).toBe("pending");
    await answer(ctx, listApprovals(configDir)[0]!.approvalId, "deny");
    expect((await finished(turnId))?.reasonCode).toBe("approval-denied");
  });

  test("/v1/status reports the real pending count", async () => {
    const ctx = fixture();
    const status = async () => (await json(await handleServeRequest(req("GET", "/v1/status"), ctx))).pendingApprovals;
    expect(await status()).toBe(0);
    const first = seed();
    seed();
    expect(await status()).toBe(2);
    await answer(ctx, first, "deny");
    expect(await status()).toBe(1);
  });
});
