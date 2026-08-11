import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProposalLifecycleService } from "./proposal-lifecycle";
import { createSacAuthorizationServer } from "./index";
import { WorkspaceService } from "./workspace-service";

const time = "2026-08-12T00:00:00.000Z";
async function setup(role = "owner", writer: ConstructorParameters<typeof ProposalLifecycleService>[0]["targetWriter"] = async ({ correlationId }) => ({ ok: true, receiptRef: "./receipts/target-write.json", targetRef: "./wiki/accepted.md", completedAt: time, correlationId })) {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-proposal-"));
  await mkdir(path.join(root, "evidence"), { recursive: true }); await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "evidence", "e.md"), "evidence"); await writeFile(path.join(root, "wiki", "accepted.md"), "accepted");
  const server = createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:reviewer", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }) });
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer: server, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, now: () => new Date(time) });
  await workspaces.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", id: "workspace-a", title: "Proposal", component: undefined });
  const manifestPath = path.join(root, ".metaproject", "workspaces", "workspace-a", "workspace.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (role === "viewer") manifest.members = [{ subject: "user:owner", role: "owner" }, { subject: "user:reviewer", role: "viewer" }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const service = new ProposalLifecycleService({ workspaceRoot: root, workspaces, authorizationServer: server, guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "policy-r1" }, policyRef: "./security/policy", policyRevision: "policy-r1", targetWriter: writer, now: () => new Date(time) });
  return { root, service, manifestPath };
}

async function propose(service: ProposalLifecycleService) {
  return service.create({ request: undefined, requestCorrelationId: "proposal-create-correlation-0001", workspaceId: "workspace-a", id: "proposal-a", proposalRevision: "r1", kind: "wiki-update", summary: "explicit wrap-up summary", evidence: [{ kind: "evidence", uri: "./evidence/e.md", revision: "r1", observedAt: time }] });
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
  expect((await readFile(path.join(root, ".metaproject", "workspaces", "workspace-a", "activity.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test("failed target write and denied reviewer never accept or mutate target", async () => {
  let writes = 0; const failed = async () => { writes++; return { ok: false as const, code: "target_write_failed" as const }; };
  const { service } = await setup("owner", failed); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "accepted", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("stale"); expect(writes).toBe(1);
  const denied = await setup("viewer"); await expect(propose(denied.service)).rejects.toMatchObject({ code: "access_denied" });
});

test("rejection is terminal append-only and does not call a target writer", async () => {
  let writes = 0; const { service } = await setup("owner", async ({ correlationId }) => { writes++; return { ok: true as const, receiptRef: "./receipts/a", targetRef: "./wiki/a", completedAt: time, correlationId }; }); await propose(service);
  const result = await service.review({ request: undefined, requestCorrelationId: "proposal-review-correlation-0001", workspaceId: "workspace-a", proposalId: "proposal-a", decision: "rejected", reason: "not applicable", idempotencyKey: "proposal-review-idempotency-0001" });
  expect(result.event.toStatus).toBe("rejected"); expect(writes).toBe(0);
});
