import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProposalLifecycleError, ProposalLifecycleService } from "./proposal-lifecycle";
import { createGuardedOwnerWriter } from "./guarded-owner-writer";
import { createSacAuthorizationServer, validateSacLedger } from "./index";
import { WorkspaceService } from "./workspace-service";
import { createTrustedWrapUpAuthority, type TrustedWrapUpProvenance } from "./trusted-wrap-up";
import { pathExists } from "../lib/fs";

const time = "2026-08-12T00:00:00.000Z";
async function setup(role = "owner", writer: { owner: string; write: (input: { correlationId: string }) => Promise<any>; recover?: () => Promise<any> } = { owner: "wiki", write: async ({ correlationId }) => ({ ok: true, owner: "wiki", receiptRef: "./receipts/target-write.json", targetRef: "./wiki/accepted.md", completedAt: time, correlationId }) }) {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-proposal-"));
  await mkdir(path.join(root, "evidence"), { recursive: true }); await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "evidence", "e.md"), "evidence"); await writeFile(path.join(root, "wiki", "accepted.md"), "accepted");
  // scanEvidenceSecurityGate scans through guardOutput() (src/security/guard.ts),
  // the same shared write-seam every other guarded owner-writer runs before its
  // write. That seam is a zero-cost no-op unless `modules.security.enabled` is
  // true in metaproject.json (guard.ts's `isSecurityEnabled`) — without this,
  // every scan below would short-circuit to a hardcoded "pass" regardless of
  // evidence content, and the secret/PII detection tests further down would be
  // testing nothing.
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }));
  const server = createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:reviewer", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }) });
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer: server, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, now: () => new Date(time) });
  await workspaces.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", id: "workspace-a", title: "Proposal" });
  const manifestPath = path.join(root, ".metaproject", "workspaces", "workspace-a", "workspace.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (role === "viewer") manifest.members = [{ subject: "user:owner", role: "owner" }, { subject: "user:reviewer", role: "viewer" }];
  else if (role === "editor") manifest.members = [{ subject: "user:owner", role: "owner" }, { subject: "user:reviewer", role: "editor" }];
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
  const first = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  const retry = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
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
  const request = { request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted" as const, idempotencyKey: "proposal-review-idempotency-0001", interactive: true };
  await expect(service.review(request)).rejects.toThrow("simulated crash");
  const recovered = await service.review(request);
  expect(recovered.event.toStatus).toBe("accepted"); expect(mutations).toBe(1); expect(ownerCalls).toBe(1);
  const ledger = await readFile(path.join(root, ".metaproject", "workspaces", "workspace-a", "activity.jsonl"), "utf8");
  expect(ledger).toContain('"recordType":"proposal-write-intent"'); expect(ledger).toContain('"toStatus":"accepted"');
});

test("failed target write and denied reviewer never accept or mutate target", async () => {
  let writes = 0; const failed = { owner: "wiki" as const, write: async () => { writes++; return { ok: false as const, code: "target_write_failed" as const }; } };
  const { service } = await setup("owner", failed); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  expect(result.event.toStatus).toBe("stale"); expect(writes).toBe(1);
  const denied = await setup("viewer"); await expect(propose(denied.service)).rejects.toMatchObject({ code: "access_denied" });
});

test("rejection is terminal append-only and does not call a target writer", async () => {
  let writes = 0; const { service } = await setup("owner", { owner: "wiki", write: async ({ correlationId }) => { writes++; return { ok: true as const, owner: "wiki" as const, receiptRef: "./receipts/a", targetRef: "./wiki/a", completedAt: time, correlationId }; } }); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not applicable", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  expect(result.event.toStatus).toBe("rejected"); expect(writes).toBe(0);
});

test("a terminal transition in another proposal does not consume this proposal idempotency stream", async () => {
  const { service } = await setup();
  await propose(service);
  const evidence = [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update("evidence").digest("hex"), observedAt: time }];
  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "proposal-create-correlation-0002");
  const wrapUp = await (service as any).options.wrapUpAuthority.issue({ actor, source: "flow", sourceRef: "./flows/wrap-up" });
  await service.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0002", workspaceId: "workspace-a", id: "proposal-b", proposalRevision: "r1", kind: "risk", wrapUp });
  await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0002", workspaceId: "workspace-a", proposalId: "proposal-b", decision: "dismissed", reason: "out of scope", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not applicable", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
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
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
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
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
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
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  expect(result.event.toStatus).toBe("stale");
});

// --- WSL-1/WSL-3 interaction with proposal lifecycle (AC-3, AC-4, AC-6) ---
// `WorkspaceService.archive`/`removeResource` land via
// docs/requirements/sac-workspace-lifecycle/ (merged ahead of slate).

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
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
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
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  expect(result.event.toStatus).toBe("accepted");
});

// SLATE-12 / AC-3: `create()`'s `security.gate` must come from a real
// detectSecrets/detectPii scan of the evidence content, never a hardcoded
// "pass" literal. These two tests share the exact same evidence path
// (`./evidence/e.md`, the one `setup()`/`wrapUp()` already wire the proposal
// to) and differ only in that file's content, which is what proves the gate
// genuinely depends on what the scan sees rather than being a constant.
test("clean evidence content legitimately resolves security.gate to \"pass\" via a real scan", async () => {
  const { service } = await setup(); // setup() writes plain "evidence" content with no secret/PII pattern
  const proposal = await propose(service);
  expect(proposal.security.gate).toBe("pass");
});

test("evidence content containing a detectable secret flips security.gate to \"needs-approval\"", async () => {
  const { root, service } = await setup();
  // A real AWS-access-key-shaped value (the canonical AWS docs example key) —
  // matches `secrets.aws-access-key` in src/security/detect/secrets.ts's
  // `/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/` exactly, so this is a genuine detector
  // hit, not a guess. Built via concatenation (not a source-literal) so this
  // project's own pre-push secret scan doesn't flag the test fixture itself
  // — the runtime string is byte-identical either way. Overwriting the same
  // evidence/e.md `wrapUp()` already references is enough: `create()`'s
  // default `validateEvidence` only checks containment/existence, not a
  // revision/content hash match, so the fixed `revision` `wrapUp()` issues
  // stays valid even though the content changed.
  const awsExampleKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  await writeFile(path.join(root, "evidence", "e.md"), awsExampleKey);
  const proposal = await propose(service);
  expect(proposal.security.gate).toBe("needs-approval");
});

// Regression for the reviewed-and-fixed blocker: scanEvidenceSecurityGate must
// pin scan results to the exact content the trusted wrap-up's revision hash
// was computed over, not "whatever is currently on disk" at create() time —
// otherwise a swap-back between wrap-up issuance and create() lets clean
// replacement content sail through unscanned even though it was never the
// content the proposal's evidence claims to be pinned to.
test("evidence content that no longer matches its wrap-up-pinned revision escalates to \"needs-approval\" even though the replacement content is itself clean (regression: swap-back exploit)", async () => {
  const { root, service } = await setup(); // evidence/e.md starts as "evidence" — the exact content wrapUp()'s revision is pinned to
  const provenance = await wrapUp(service); // revision hash is pinned to content A ("evidence") while the file still holds it
  await writeFile(path.join(root, "evidence", "e.md"), "an unrelated clean replacement note"); // content B swapped in after the pin, before create()
  const proposal = await service.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", workspaceId: "workspace-a", id: "proposal-revision-mismatch", proposalRevision: "r1", kind: "wiki-update", wrapUp: provenance });
  expect(proposal.security.gate).toBe("needs-approval");
});

// Branch coverage gap: the existing secret-detection test above uses an
// AWS-key-shaped value, so `detectSecrets(content).length > 0 || detectPii(...)`
// short-circuits and detectPii is never actually exercised by any test. This
// evidence content matches `pii.email` in src/security/detect/pii.ts and no
// rule in src/security/detect/secrets.ts, and its revision is pinned to
// exactly this content (via a one-off wrapUpAuthority/service, mirroring the
// "persists only trusted wrap-up reference..." test's inline construction
// above) so this isolates the detectPii branch from the revision-mismatch
// branch covered by the regression test above.
test("evidence content with a detectable PII pattern but no secret pattern flips security.gate to \"needs-approval\" via the detectPii branch (isolated from the revision-mismatch branch)", async () => {
  const { root, service } = await setup();
  const piiContent = "contact: jane.doe@example.com";
  await writeFile(path.join(root, "evidence", "e.md"), piiContent);
  const piiWrapUpAuthority = createTrustedWrapUpAuthority({ now: () => new Date(time), resolveExplicitWrapUp: async () => ({ workspaceId: "workspace-a", sourceRevision: "wrapup-r1", summary: "pii wrap-up summary", evidence: [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update(piiContent).digest("hex"), observedAt: time }], expiresAt: "2026-08-12T01:00:00.000Z" }) });
  const piiService = new ProposalLifecycleService({ workspaceRoot: root, workspaces: (service as any).options.workspaces, authorizationServer: (service as any).options.authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, policyRef: "./security/policy", policyRevision: "policy-r1", targetWriters: (service as any).options.targetWriters, wrapUpAuthority: piiWrapUpAuthority, now: () => new Date(time) });
  const actor = await (piiService as any).options.authorizationServer.actorContextFor(undefined, "proposal-create-correlation-0001");
  const provenance = await piiWrapUpAuthority.issue({ actor, source: "session", sourceRef: "./evidence/e.md" });
  const proposal = await piiService.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", workspaceId: "workspace-a", id: "proposal-pii", proposalRevision: "r1", kind: "wiki-update", wrapUp: provenance });
  expect(proposal.security.gate).toBe("needs-approval");
});

// Review finding 1: `readWorkspaceFileNoFollow`'s own "safe descriptor source
// reads are unavailable on this platform" failure (secure-resource-read.ts's
// documented fail-closed contract on hosts without the Bun/POSIX FFI bridge —
// Windows, musl/Alpine Linux) must escalate to "needs-approval", never fall
// through the old blanket `catch { continue }` into a silent "pass". Uses the
// `readEvidenceFile` test seam rather than a real non-POSIX host.
test("a platform-unavailable safe-read bridge fails closed to \"needs-approval\", never silently \"pass\"", async () => {
  const { service } = await setup();
  (service as any).options.readEvidenceFile = () => { throw new Error("safe descriptor source reads are unavailable on this platform"); };
  const proposal = await propose(service);
  expect(proposal.security.gate).toBe("needs-approval");
});

// Companion to the platform-unavailable test above: an ORDINARY per-item read
// failure (binary content, containment failure, ENOENT, etc. — anything other
// than the platform-unavailable bridge error) must still be "nothing
// scannable" for that item, not an auto-escalation. This is what proves the
// fix distinguishes the one error class it must fail closed on from every
// other read/resolve failure, rather than making everything fail closed.
test("an ordinary (non-platform) evidence read failure is treated as \"nothing scannable\", not escalated", async () => {
  const { service } = await setup();
  (service as any).options.readEvidenceFile = () => { throw new Error("boom: simulated per-item read failure, unrelated to platform availability"); };
  const proposal = await propose(service);
  expect(proposal.security.gate).toBe("pass");
});

// Review finding 4: scanEvidenceSecurityGate must genuinely call the shared
// `guardOutput()` write seam (src/security/guard.ts) rather than a private
// detectSecrets/detectPii call running in parallel to it. `guardOutput` is a
// no-op unless `modules.security.enabled` is true in metaproject.json — a
// private detector call would never have cared about that toggle. Disabling
// the module here and still seeing secret-shaped evidence resolve to "pass"
// is the one observation a private-detector implementation could not produce.
test("scanEvidenceSecurityGate genuinely calls the shared guardOutput() seam: disabling the security module makes secret-shaped evidence resolve to \"pass\"", async () => {
  const { root, service } = await setup();
  const awsExampleKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  await writeFile(path.join(root, "evidence", "e.md"), awsExampleKey);
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { security: { enabled: false } } }));
  // Pin the wrap-up's revision to the exact secret content on disk, isolating
  // this from the revision-mismatch branch (same technique as the detectPii
  // isolation test above).
  const wrapUpAuthority = createTrustedWrapUpAuthority({ now: () => new Date(time), resolveExplicitWrapUp: async () => ({ workspaceId: "workspace-a", sourceRevision: "wrapup-r1", summary: "secret wrap-up summary, module disabled", evidence: [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update(awsExampleKey).digest("hex"), observedAt: time }], expiresAt: "2026-08-12T01:00:00.000Z" }) });
  const disabledService = new ProposalLifecycleService({ workspaceRoot: root, workspaces: (service as any).options.workspaces, authorizationServer: (service as any).options.authorizationServer, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, policyRef: "./security/policy", policyRevision: "policy-r1", targetWriters: (service as any).options.targetWriters, wrapUpAuthority, now: () => new Date(time) });
  const actor = await (disabledService as any).options.authorizationServer.actorContextFor(undefined, "proposal-create-correlation-0001");
  const provenance = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: "./evidence/e.md" });
  const proposal = await disabledService.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", workspaceId: "workspace-a", id: "proposal-secret-module-off", proposalRevision: "r1", kind: "wiki-update", wrapUp: provenance });
  expect(proposal.security.gate).toBe("pass");
});

// Review finding 3: `security.gate` used to be computed at the very top of
// `create()`, long before the authorization/lock-acquisition/wrap-up-consume
// sequence that precedes the actual write — a TOCTOU window an evidence swap
// could sail through unscanned. `beforeCreateWrite` fires deep inside that
// sequence, inside the file lock, immediately before the (fixed) write-time
// scan. If the gate were still computed early, this swap — which happens
// strictly after `create()` begins — could not possibly be seen by it, and
// the persisted gate would stay "pass" (the original evidence is clean).
test("evidence swapped inside create()'s TOCTOU window (after authorization/lock begin, before persist) is still scanned fresh at write-time", async () => {
  const { root, service } = await setup();
  (service as any).options.beforeCreateWrite = async () => {
    await writeFile(path.join(root, "evidence", "e.md"), "swapped after create() began, inside the file lock, before persist");
  };
  const proposal = await propose(service);
  expect(proposal.security.gate).toBe("needs-approval");
  const persisted = JSON.parse(await readFile(path.join(root, ".metaproject", "workspaces", "workspace-a", "proposals", "proposal-a.json"), "utf8"));
  expect(persisted.security.gate).toBe("needs-approval");
});

// SLATE-14 / AC-4 (cheap regression guard): the misleading self-accept claim
// must be gone from the source comment. review-orchestrator independently
// confirms the corrected wording by direct code read; this only guards
// against the old string silently coming back.
test("the createLocalProposalLifecycleService comment no longer claims a self-accept protection that isn't real", async () => {
  const source = await readFile(new URL("./proposal-lifecycle.ts", import.meta.url), "utf8");
  expect(source).not.toContain("can never self-accept");
});

// --- SLATE-8: unattended checkpoint (AC4, AC5, AC6) ---
// `review()`'s `interactive` gate mirrors `checkApproval` rule (h)
// (src/harness/mutation/approval.ts:148-149, `interactive === false ->
// invalid`) and is documented at the top of `review()` in
// proposal-lifecycle.ts. These tests exercise it against the real
// authorization/role machinery (not a mock), because AC4 requires "regardless
// of role" to be genuinely proven, not merely asserted in a comment.

test("accept is denied when interactive:false, for an owner reviewer (AC4) — mirrors src/lib/serve-turn.ts:605's honest `deps.interactive = false`, the same value every keryx serve session resolves for `runRemoteTurn`", async () => {
  const { service } = await setup("owner"); await propose(service);
  await expect(service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: false })).rejects.toMatchObject({ code: "non_interactive_accept_denied" });
});

test("accept is denied when interactive:false, for an editor reviewer too (AC4) — the denial does not depend on which otherwise-valid role the reviewer holds, and `review()` never consults `PolicyProfile` (src/harness/policy/profiles.ts) at all for this gate: profile answers a capability-ceiling question, interactive answers a human-presence question, and they are deliberately different axes never referenced together here", async () => {
  const { service } = await setup("editor"); await propose(service);
  await expect(service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: false })).rejects.toMatchObject({ code: "non_interactive_accept_denied" });
});

test("accept succeeds when interactive:true for an otherwise-valid actor — the human-at-the-terminal case `keryx workspace review`/MCP `sac.review` both pass", async () => {
  const { service } = await setup("owner"); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  expect(result.event.toStatus).toBe("accepted");
});

test("a \"rejected\" decision is completely unaffected by interactive:false (AC6 — only \"accepted\" is gated)", async () => {
  const { service } = await setup(); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not applicable", idempotencyKey: "proposal-review-idempotency-0001", interactive: false });
  expect(result.event.toStatus).toBe("rejected");
});

test("a \"dismissed\" decision is completely unaffected by interactive:false (AC6)", async () => {
  const { service } = await setup(); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "dismissed", reason: "no longer needed", idempotencyKey: "proposal-review-idempotency-0001", interactive: false });
  expect(result.event.toStatus).toBe("dismissed");
});

test("propose (create()) carries no interactive gate at all and is unaffected by a subsequent denied accept — the deferred-queue model (AC6)", async () => {
  const { service } = await setup();
  // create()'s input type has no `interactive` field whatsoever — nothing to
  // bypass or satisfy, proving the SLATE-8 change is scoped to review()'s
  // accept branch only, never to propose/create().
  const proposal = await propose(service);
  expect(proposal.status).toBe("proposed");
  // The same unattended session's accept is still denied: propose is not a
  // side door around the gate, and the proposal remains pending rather than
  // being rejected outright.
  await expect(service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: proposal.id, decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: false })).rejects.toMatchObject({ code: "non_interactive_accept_denied" });
});

test("the interactive value cannot be sourced from actor/clientClaims/proposal content — a spoofed interactive:true claim inside `request` has no effect on the boolean actually consulted (AC5)", async () => {
  const { service } = await setup(); await propose(service);
  // `request` normally flows only to `authorizationServer.actorContextFor()`
  // to resolve the trusted actor — review() never reads an `interactive`
  // field off it or off `clientClaims`. A malicious-looking payload that
  // tries to smuggle `interactive`/`clientClaims.interactive` through here
  // must be ignored: only the caller-supplied top-level `interactive`
  // parameter — fixed at the harness/CLI/MCP boundary, never inside a
  // request body a model/agent could shape — is honored.
  const spoofedRequest = { interactive: true, clientClaims: { interactive: true, role: "owner" } };
  await expect(service.review({ request: spoofedRequest, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: false })).rejects.toMatchObject({ code: "non_interactive_accept_denied" });
});

test("the denial uses a distinct error code from other guard_denied reasons (F-008) — a caller pattern-matching on `.code` can never conflate \"no human present\" with archived-workspace or policy-guard denials", async () => {
  const { service } = await setup(); await propose(service);
  await expect(service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: false })).rejects.toMatchObject({ code: "non_interactive_accept_denied", message: expect.stringContaining("interactive: false") });
});

test("a replayed accept (same idempotency key) succeeds even when the retry's interactive value differs from the original — the idempotency replay lookup runs before the SLATE-8 gate, so it is never re-decided (F-006)", async () => {
  const { service } = await setup("owner"); await propose(service);
  const first = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  expect(first.event.toStatus).toBe("accepted");
  // Same idempotency key, but this replay call is dishonestly/differently
  // tagged `interactive: false`. It must still return the already-committed
  // "accepted" outcome rather than being freshly re-decided and denied.
  const replay = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001", interactive: false });
  expect(replay).toEqual(first);
});

test("a different idempotency key on an already-terminal proposal is never mistaken for a replay of a prior transition — the replay short-circuit only matches on the exact idempotencyKey, so a genuinely new request still runs the normal terminal-transition/gate logic (F-006 ordering)", async () => {
  const { service } = await setup("owner"); await propose(service);
  await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not applicable", idempotencyKey: "proposal-review-idempotency-0001", interactive: true });
  // A second, fresh accept attempt under a different idempotency key is not a
  // replay of the first (rejected) transition. `events.length > 0` denies it
  // as a conflict before the interactive gate is even reached, proving the
  // gate reordering did not create a bypass where a fresh non-interactive
  // accept attempt could slip through as if it were a replay.
  await expect(service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0002", interactive: false })).rejects.toMatchObject({ code: "conflict" });
});

// --- SLATE-10 (flow 165, T2): listProposedProposals / listVisibleProposedProposals / isEvidenceFresh ---
//
// RED: none of `listProposedProposals`, `listVisibleProposedProposals`,
// `isEvidenceFresh` exist on `ProposalLifecycleService` yet (task-implementer's
// Track A/Track B add them per plan.md) — every test below fails at runtime
// ("is not a function") and at typecheck until then. Called directly (no
// `as any`) since plan.md pins these as PUBLIC methods, unlike the file's
// existing `(service as any).options...` casts for genuinely-private access.

test("listProposedProposals returns only proposals still in 'proposed' status — a terminalized sibling proposal is filtered out via its activity.jsonl transition", async () => {
  const { root, service } = await setup();
  await propose(service); // proposal-a: stays pending

  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "list-correlation-0002");
  const secondWrapUp = await (service as any).options.wrapUpAuthority.issue({ actor, source: "flow", sourceRef: "./flows/wrap-up" });
  await service.create({ request: undefined, requestCorrelationId: "list-correlation-0002", workspaceId: "workspace-a", id: "proposal-b", proposalRevision: "r1", kind: "risk", wrapUp: secondWrapUp });
  await service.review({ request: undefined, requestCorrelationId: "list-review-0002", workspaceId: "workspace-a", proposalId: "proposal-b", decision: "dismissed", reason: "not needed", idempotencyKey: "list-review-idem-0002", interactive: true });

  const pending = await service.listProposedProposals("workspace-a");
  expect(pending.map((p: any) => p.id)).toEqual(["proposal-a"]);

  // Both proposal-a.json and proposal-b.json plus proposal-b's decision
  // sidecar exist on disk — none of the sidecars leaked into the result.
  const proposalsDir = path.join(root, ".metaproject", "workspaces", "workspace-a", "proposals");
  const files = await readdir(proposalsDir);
  expect(files.length).toBeGreaterThan(2);
  expect(pending).toHaveLength(1);
});

test("listProposedProposals never misidentifies a sidecar file (.decision.json/.approval.json/.write-result.json/.write-intent.json) as a proposal — filters by parsed recordType, not filename regex", async () => {
  const { root, service } = await setup();
  await propose(service);
  await service.review({ request: undefined, requestCorrelationId: "sidecar-review-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "sidecar-review-idem-0001", interactive: true });
  // Accepting proposal-a writes .approval.json/.write-intent.json/.write-result.json
  // sidecars AND terminalizes it via activity.jsonl.
  const proposalsDir = path.join(root, ".metaproject", "workspaces", "workspace-a", "proposals");
  const files = await readdir(proposalsDir);
  expect(files.some((f) => f.includes(".approval.json") || f.includes(".write-result.json") || f.includes(".write-intent.json"))).toBe(true);

  const pending = await service.listProposedProposals("workspace-a");
  expect(pending).toEqual([]); // accepted (terminal), and no sidecar was ever counted as a proposal
});

test("listProposedProposals returns [] for a workspace with no proposals/ dir yet (ENOENT), not a throw", async () => {
  const { service } = await setup();
  await expect(service.listProposedProposals("workspace-a")).resolves.toEqual([]);
});

test("listProposedProposals skips a malformed proposals/ entry (partial/corrupt JSON) rather than throwing — a listing path, not a load path (unlike loadProposal, which legitimately throws on a single known id's bad JSON)", async () => {
  const { root, service } = await setup();
  await propose(service);
  const proposalsDir = path.join(root, ".metaproject", "workspaces", "workspace-a", "proposals");
  await writeFile(path.join(proposalsDir, "corrupt.json"), "{not valid json");
  const pending = await service.listProposedProposals("workspace-a");
  expect(pending.map((p: any) => p.id)).toEqual(["proposal-a"]);
});

test("AC1 (flow 165): listVisibleProposedProposals surfaces a pending proposal from an ARCHIVED workspace identically to one from an active workspace — always includeArchived:true, never a caller toggle", async () => {
  const { root, service, workspaces, server } = await setup();
  await propose(service); // proposal-a in workspace-a (active)

  await workspaces.create({ request: undefined, requestCorrelationId: "archived-ws-create-0001", id: "workspace-b", title: "Archived WS" });
  const wrapUpAuthorityB = createTrustedWrapUpAuthority({ now: () => new Date(time), resolveExplicitWrapUp: async () => ({ workspaceId: "workspace-b", sourceRevision: "wrapup-r1", summary: "workspace-b summary", evidence: [{ kind: "evidence", uri: "./evidence/e.md", revision: createHash("sha256").update("evidence").digest("hex"), observedAt: time }], expiresAt: "2026-08-12T01:00:00.000Z" }) });
  const serviceB = new ProposalLifecycleService({ workspaceRoot: root, workspaces, authorizationServer: server, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, policyRef: "./security/policy", policyRevision: "policy-r1", targetWriters: {}, wrapUpAuthority: wrapUpAuthorityB, now: () => new Date(time) });
  const actorB = await server.actorContextFor(undefined, "archived-ws-actor-0001");
  const wrapUpB = await wrapUpAuthorityB.issue({ actor: actorB!, source: "session", sourceRef: "./evidence/e.md" });
  await serviceB.create({ request: undefined, requestCorrelationId: "archived-ws-create-0002", workspaceId: "workspace-b", id: "proposal-b", proposalRevision: "r1", kind: "follow-up", wrapUp: wrapUpB });
  await workspaces.archive({ request: undefined, requestCorrelationId: "archived-ws-archive-0001", workspaceId: "workspace-b" });

  const visible = await service.listVisibleProposedProposals(actorB!);
  const workspaceIdsWithProposals = visible.map((entry: any) => entry.workspace.id).sort();
  expect(workspaceIdsWithProposals).toEqual(["workspace-a", "workspace-b"]);
  const archivedGroup = visible.find((entry: any) => entry.workspace.id === "workspace-b");
  expect(archivedGroup?.workspace.status).toBe("archived");
  expect(archivedGroup?.proposals.map((p: any) => p.id)).toEqual(["proposal-b"]);

  // Not a caller-toggle: a plain `listForActor({includeArchived:false})` call
  // must NOT surface workspace-b — listVisibleProposedProposals's inclusion
  // of it is hardcoded internally, not threaded through from a caller flag.
  const activeOnly = await workspaces.listForActor({ actorContext: actorB!, includeArchived: false });
  expect(activeOnly.map((w) => w.id)).not.toContain("workspace-b");
});

test("listVisibleProposedProposals omits a visible workspace that currently has zero pending proposals — an empty per-workspace group is not itself an item", async () => {
  const { service, workspaces, server } = await setup();
  await workspaces.create({ request: undefined, requestCorrelationId: "empty-ws-create-0001", id: "workspace-empty", title: "Empty" });
  const actor = await server.actorContextFor(undefined, "empty-ws-actor-0001");
  const visible = await service.listVisibleProposedProposals(actor!);
  expect(visible.map((entry: any) => entry.workspace.id)).not.toContain("workspace-empty");
});

// --- isEvidenceFresh (Track B item 6): read-only re-check, never throws, never writes ---

test("isEvidenceFresh: unmutated evidence is fresh", async () => {
  const { service } = await setup();
  const proposal = await propose(service);
  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "fresh-check-0001");
  await expect(service.isEvidenceFresh(proposal, actor)).resolves.toBe(true);
});

test("isEvidenceFresh: evidence mutated on disk after the proposal pinned its hash is stale — same fail-toward-stale posture as targetWriteOrStale's own catch block, but callable BEFORE any review/accept", async () => {
  const { root, service } = await setup();
  const proposal = await propose(service);
  await writeFile(path.join(root, "evidence", "e.md"), "changed after the proposal pinned this revision");
  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "fresh-check-0002");
  await expect(service.isEvidenceFresh(proposal, actor)).resolves.toBe(false);
});

test("isEvidenceFresh: a deleted/unreadable evidence file is stale, never a throw", async () => {
  const { root, service } = await setup();
  const proposal = await propose(service);
  await rm(path.join(root, "evidence", "e.md"));
  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "fresh-check-0003");
  await expect(service.isEvidenceFresh(proposal, actor)).resolves.toBe(false);
});

test("isEvidenceFresh never mutates lifecycle state — no activity.jsonl ledger is created, unlike an actual review/accept call", async () => {
  const { root, service } = await setup();
  const proposal = await propose(service);
  const actor = await (service as any).options.authorizationServer.actorContextFor(undefined, "fresh-check-0004");
  await service.isEvidenceFresh(proposal, actor);
  const ledgerPath = path.join(root, ".metaproject", "workspaces", "workspace-a", "activity.jsonl");
  expect(await pathExists(ledgerPath)).toBe(false);
});
