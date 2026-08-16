import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProposalLifecycleError, ProposalLifecycleService } from "./proposal-lifecycle";
import { createGuardedOwnerWriter } from "./guarded-owner-writer";
import { createSacAuthorizationServer, validateSacLedger } from "./index";
import { WorkspaceService } from "./workspace-service";
import { createTrustedWrapUpAuthority, type TrustedWrapUpProvenance } from "./trusted-wrap-up";

const time = "2026-08-12T00:00:00.000Z";
async function setup(role = "owner", writer: { owner: string; write: (input: { correlationId: string }) => Promise<any>; recover?: () => Promise<any> } = { owner: "wiki", write: async ({ correlationId }) => ({ ok: true, owner: "wiki", receiptRef: "./receipts/target-write.json", targetRef: "./wiki/accepted.md", completedAt: time, correlationId }) }) {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-proposal-"));
  await mkdir(path.join(root, "evidence"), { recursive: true }); await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "evidence", "e.md"), "evidence"); await writeFile(path.join(root, "wiki", "accepted.md"), "accepted");
  const server = createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:reviewer", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }) });
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer: server, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, now: () => new Date(time) });
  await workspaces.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", id: "workspace-a", title: "Proposal" });
  const manifestPath = path.join(root, ".metaproject", "workspaces", "workspace-a", "workspace.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (role === "viewer") manifest.members = [{ subject: "user:owner", role: "owner" }, { subject: "user:reviewer", role: "viewer" }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const wrapUpAuthority = createTrustedWrapUpAuthority({ now: () => new Date(time), resolveExplicitWrapUp: async ({ sourceRef }) => ({ workspaceId: "workspace-a", sourceRevision: "wrapup-r1", summary: sourceRef.includes("flow") ? "separate explicit wrap-up" : "explicit wrap-up summary", evidence: [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update("evidence").digest("hex"), observedAt: time }], expiresAt: "2026-08-12T01:00:00.000Z" }) });
  const writerComposition = { authorize: async (intent: { reviewerAuthority: string }) => intent.reviewerAuthority === "owner" || intent.reviewerAuthority === "editor", recover: async () => writer.recover ? writer.recover() : undefined, persist: (intent: { correlationId: string }) => writer.write({ correlationId: intent.correlationId }) };
  const service = new ProposalLifecycleService({ workspaceRoot: root, workspaces, authorizationServer: server, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, policyRef: "./security/policy", policyRevision: "policy-r1", targetWriters: { [writer.owner]: createGuardedOwnerWriter({ owner: writer.owner as any, ...writerComposition }) } as any, wrapUpAuthority, now: () => new Date(time) });
  return { root, service, manifestPath, server, wrapUpAuthority, workspaces };
}

async function wrapUp(service: ProposalLifecycleService, overrides: Partial<TrustedWrapUpProvenance> = {}) {
  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "proposal-create-correlation-0001");
  return (service as any).options.wrapUpAuthority.issue({ actor, source: "session", sourceRef: "./evidence/e.md", ...overrides });
}

async function propose(service: ProposalLifecycleService, overrides: Record<string, unknown> = {}) {
  const evidence = [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update("evidence").digest("hex"), observedAt: time }];
  return service.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", workspaceId: "workspace-a", id: "proposal-a", proposalRevision: "r1", kind: "wiki-update", wrapUp: await wrapUp(service), ...overrides } as any);
}

test("creates an immutable schema-valid proposed record with no raw payload", async () => {
  const { root, service } = await setup(); const proposal = await propose(service);
  expect(proposal.status).toBe("proposed"); expect(JSON.stringify(proposal)).not.toContain("prompt");
  expect(JSON.parse(await readFile(path.join(root, ".metaproject", "workspaces", "workspace-a", "proposals", "proposal-a.json"), "utf8"))).toEqual(proposal);
});

test("accepted transition requires guarded target receipt and same-key retry returns it", async () => {
  const { root, service } = await setup(); await propose(service);
  const first = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  const retry = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(first).toEqual(retry); expect(first.event.toStatus).toBe("accepted");
  const acceptance = (first.event as any).acceptance;
  expect(acceptance.targetWrite.binding).toMatchObject({ intentRef: acceptance.writeIntentRef, proposalId: "proposal-a", proposalRevision: "r1", workspaceId: "workspace-a", correlationId: "proposal-review-correlation-0001", idempotencyKey: "proposal-review-idempotency-0001", reviewerSubject: "user:reviewer", reviewerAuthority: "owner", policyRevision: "policy-r1" });
  const ledgerRecords = (await readFile(path.join(root, ".metaproject", "workspaces", "workspace-a", "activity.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(ledgerRecords).toHaveLength(2); expect(ledgerRecords.map((record) => record.sequence)).toEqual([1, 2]);
  await expect(validateSacLedger({ events: ledgerRecords })).resolves.toMatchObject({ valid: true });
});

test("crash recovery obtains a durable owner receipt without a duplicate mutation", async () => {
  let ownerCalls = 0; let mutations = 0;
  let durableReceipt: Record<string, unknown> | undefined;
  const writer = { owner: "wiki" as const, write: async ({ correlationId }: { correlationId: string }) => {
    ownerCalls += 1;
    if (ownerCalls === 1) { mutations += 1; durableReceipt = { ok: true as const, owner: "wiki" as const, receiptRef: "./receipts/a", targetRef: "./wiki/a", completedAt: time, correlationId }; throw new Error("simulated crash after owner commit"); }
    return { ok: true as const, owner: "wiki" as const, receiptRef: "./receipts/a", targetRef: "./wiki/a", completedAt: time, correlationId };
  }, recover: async () => durableReceipt };
  const { root, service } = await setup("owner", writer as any); await propose(service);
  const request = { request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted" as const, idempotencyKey: "proposal-review-idempotency-0001" };
  await expect(service.review(request)).rejects.toThrow("simulated crash");
  const recovered = await service.review(request);
  expect(recovered.event.toStatus).toBe("accepted"); expect(mutations).toBe(1); expect(ownerCalls).toBe(1);
  const ledger = await readFile(path.join(root, ".metaproject", "workspaces", "workspace-a", "activity.jsonl"), "utf8");
  expect(ledger).toContain('"recordType":"proposal-write-intent"'); expect(ledger).toContain('"toStatus":"accepted"');
});

test("failed target write and denied reviewer never accept or mutate target", async () => {
  let writes = 0; const failed = { owner: "wiki" as const, write: async () => { writes++; return { ok: false as const, code: "target_write_failed" as const }; } };
  const { service } = await setup("owner", failed); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("stale"); expect(writes).toBe(1);
  const denied = await setup("viewer"); await expect(propose(denied.service)).rejects.toMatchObject({ code: "access_denied" });
});

test("rejection is terminal append-only and does not call a target writer", async () => {
  let writes = 0; const { service } = await setup("owner", { owner: "wiki", write: async ({ correlationId }) => { writes++; return { ok: true as const, owner: "wiki" as const, receiptRef: "./receipts/a", targetRef: "./wiki/a", completedAt: time, correlationId }; } }); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not applicable", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("rejected"); expect(writes).toBe(0);
});

test("a terminal transition in another proposal does not consume this proposal idempotency stream", async () => {
  const { service } = await setup();
  await propose(service);
  const evidence = [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update("evidence").digest("hex"), observedAt: time }];
  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "proposal-create-correlation-0002");
  const wrapUp = await (service as any).options.wrapUpAuthority.issue({ actor, source: "flow", sourceRef: "./flows/wrap-up" });
  await service.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0002", workspaceId: "workspace-a", id: "proposal-b", proposalRevision: "r1", kind: "risk", wrapUp });
  await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0002", workspaceId: "workspace-a", proposalId: "proposal-b", decision: "dismissed", reason: "out of scope", idempotencyKey: "proposal-review-idempotency-0001" });
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not applicable", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.proposalId).toBe("proposal-a");
  expect(result.event.sequence).toBe(1);
});

test("persists only trusted wrap-up reference and rejects policy revision mismatch", async () => {
  const { root, service } = await setup();
  await expect(service.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-raw1", workspaceId: "workspace-a", id: "proposal-raw", proposalRevision: "r1", kind: "wiki-update", wrapUp: await wrapUp(service) })).resolves.toMatchObject({ status: "proposed" });
  expect(await readFile(path.join(root, ".metaproject", "workspaces", "workspace-a", "proposals", "proposal-raw.json"), "utf8")).not.toContain("raw prompt");
  const mismatch = new ProposalLifecycleService({ workspaceRoot: root, workspaces: (service as any).options.workspaces, authorizationServer: (service as any).options.authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, policyRef: "./security/policy", policyRevision: "wrong-r2", targetWriters: {}, wrapUpAuthority: (service as any).options.wrapUpAuthority });
  await expect(propose(mismatch)).rejects.toMatchObject({ code: "guard_denied" });
});

test("requires a server-issued explicit session or Flow wrap-up, bound once to actor/workspace/evidence", async () => {
  const { service, wrapUpAuthority, server } = await setup();
  const actor = await server.actorContextFor(undefined, "proposal-create-correlation-0001");
  const forged = { id: "wrapup-forged", source: "session", sourceRef: "./evidence/e.md", sourceRevision: "r1", workspaceId: "workspace-a", actorSubject: actor!.subject, summaryDigest: "fake", evidence: [], issuedAt: time, expiresAt: "2026-08-12T01:00:00.000Z" } as any;
  await expect(propose(service, { wrapUp: forged })).rejects.toMatchObject({ code: "trusted_wrap_up_required" });
  const issued = await wrapUpAuthority.issue({ actor: actor!, source: "flow", sourceRef: "./flows/wrap-up" });
  await expect(propose(service, { workspaceId: "workspace-b", wrapUp: issued })).rejects.toMatchObject({ code: "trusted_wrap_up_required" });
  const replay = await wrapUp(service);
  await propose(service, { wrapUp: replay });
  await expect(propose(service, { id: "proposal-b", wrapUp: replay })).rejects.toMatchObject({ code: "trusted_wrap_up_required" });
});

test("stale evidence is denied at owner-use after approval and never invokes writer", async () => {
  let writes = 0; const { root, service } = await setup("owner", { owner: "wiki", write: async ({ correlationId }) => { writes++; return { ok: true as const, owner: "wiki" as const, receiptRef: "./receipts/a", targetRef: "./wiki/a", completedAt: time, correlationId }; } }); await propose(service);
  (service as any).options.beforeTargetWrite = async () => { await writeFile(path.join(root, "evidence", "e.md"), "changed"); };
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("stale"); expect(writes).toBe(0);
});

// The `skill` owner's real storage folder is `.metaproject/project-skills/`,
// not `.metaproject/skill/` (unlike memory/wiki, where the owner name and the
// real folder happen to match) — targetWriteOrStale's owner-prefix check has
// to know that, via a real per-owner prefix map (ownerTargetPrefix in
// proposal-lifecycle.ts), or every skill accept silently lands as "stale".
test("a skill owner receipt is accepted when targetRef matches the real ./project-skills prefix", async () => {
  const { service } = await setup("owner", {
    owner: "skill",
    write: async ({ correlationId }) => ({ ok: true as const, owner: "skill" as const, receiptRef: "./project-skills/sac/x.receipt.json", targetRef: "./project-skills/sac/x/SKILL.md", completedAt: time, correlationId }),
  });
  await propose(service, { kind: "decision" }); // any non-wiki-update/non-memory-entry kind routes to "skill" (ownerFor)
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("accepted");
});

test("a skill owner receipt is REJECTED (lands as stale) when targetRef uses the wrong ./skill prefix, not the real ./project-skills one", async () => {
  const { service } = await setup("owner", {
    owner: "skill",
    // This is exactly what the old, buggy `startsWith('./' + owner)` check
    // would have accepted — proving the fix enforces the REAL prefix, not
    // merely "any string starting with the owner's name".
    write: async ({ correlationId }) => ({ ok: true as const, owner: "skill" as const, receiptRef: "./skill/x.receipt.json", targetRef: "./skill/x/SKILL.md", completedAt: time, correlationId }),
  });
  await propose(service, { kind: "decision" });
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("stale");
});

// --- WSL-1/WSL-3 interaction with proposal lifecycle (AC-3, AC-4, AC-6) ---
// `WorkspaceService.archive`/`removeResource` do not exist yet (see
// workspace-service.test.ts and docs/requirements/sac-workspace-lifecycle/).
// These tests are expected to fail red until task-implementer lands WSL-1..4
// AND wires the archived-workspace guard into ProposalLifecycleService.create.

test("propose (create) against an archived workspace is rejected with a typed guard_denied ProposalLifecycleError (AC-3)", async () => {
  const { service, workspaces } = await setup();
  await (workspaces as any).archive({ request: undefined, requestCorrelationId: "workspace-archive-before-propose-0001", workspaceId: "workspace-a" });
  await expect(propose(service)).rejects.toBeInstanceOf(ProposalLifecycleError);
  await expect(propose(service)).rejects.toMatchObject({ code: "guard_denied" });
});

test("review of a proposal that predates its workspace's archival completes normally — archive never blocks in-flight review (AC-4)", async () => {
  const { service, workspaces } = await setup();
  await propose(service);
  await (workspaces as any).archive({ request: undefined, requestCorrelationId: "workspace-archive-after-propose-0001", workspaceId: "workspace-a" });
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("accepted");
});

test("removeResource never causes a pending/accepted proposal's evidence resolution to fail — resources and evidence are independent (AC-6)", async () => {
  const { root, service, workspaces } = await setup();
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export {};\n");
  await (workspaces as any).addResource({ request: undefined, requestCorrelationId: "workspace-addresource-0001", workspaceId: "workspace-a", resource: { kind: "component", uri: "./src/a.ts" } });
  // Evidence resolves via ./evidence/e.md (set up by `setup()`/`propose()`), a
  // path entirely independent of the ./src/a.ts workspace resource below —
  // this is the fact AC-6 depends on (targetWriteOrStale never resolves
  // evidence via manifest.resources[] membership).
  await propose(service);
  await (workspaces as any).removeResource({ request: undefined, requestCorrelationId: "workspace-removeresource-0001", workspaceId: "workspace-a", uri: "./src/a.ts" });
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("accepted");
});
