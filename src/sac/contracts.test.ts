import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  authorizeSacUse,
  createSacAuthorizationServer,
  evaluateStrictSacGuard,
  resolveWorkspaceReference,
  validateSacContract,
  validateSacLedger,
} from "./index";

function trustedServer(subject: string, authenticationMethod: "local-os" | "trusted-harness" = "local-os") {
  return createSacAuthorizationServer({
    authenticateRequest: async () => ({ subject, authenticationMethod, roleRevision: "roles-1" }),
  });
}

async function trustedActor(subject: string, requestCorrelationId: string, authenticationMethod: "local-os" | "trusted-harness" = "local-os") {
  const actor = await trustedServer(subject, authenticationMethod).actorContextFor({ transport: "server-owned" }, requestCorrelationId);
  if (!actor) throw new Error("test server did not issue ActorContext");
  return actor;
}

const fixtureRoot = path.join(
  import.meta.dir,
  "../../docs/requirements/shared-agent-context/schemas/fixtures",
);

const schemaForFixture: Record<string, string> = {
  "valid-workspace.json": "workspace-manifest",
  "invalid-workspace.json": "workspace-manifest",
  "invalid-duplicate-roles.json": "workspace-manifest",
  "invalid-unsafe-uri.json": "workspace-manifest",
  "valid-fwk-receipt.json": "fwk-receipt",
  "invalid-evidence-missing-revision.json": "fwk-receipt",
  "invalid-bound-work-no-flow-ref.json": "fwk-receipt",
  "invalid-time-order.json": "fwk-receipt",
  "invalid-stale-evidence.json": "fwk-receipt",
  "valid-proposal.json": "workspace-proposal",
  "invalid-proposal.json": "workspace-proposal",
  "valid-accepted-transition.json": "workspace-proposal",
  "invalid-accepted-transition-failed-gate.json": "workspace-proposal",
  "invalid-accepted-transition-no-target-write.json": "workspace-proposal",
  "valid-review-decision.json": "review-decision",
  "valid-access-receipt.json": "access-receipt",
  "invalid-spoofed-viewer-mutation.json": "review-decision",
  "invalid-resource-egress.json": "access-receipt",
};

const validFixtures = new Set([
  "valid-workspace.json",
  "valid-fwk-receipt.json",
  "valid-proposal.json",
  "valid-accepted-transition.json",
  "valid-review-decision.json",
  "valid-access-receipt.json",
]);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path.join(fixtureRoot, name)).text());
}

test("SAC positive and labelled negative fixtures validate through their named Draft 2020-12 contract plus semantic validation", async () => {
  for (const [name, schema] of Object.entries(schemaForFixture)) {
    const result = await validateSacContract({ schema, document: await fixture(name) });
    expect(result.valid, name).toBe(validFixtures.has(name));
  }
});

test("SAC semantic validation rejects duplicate or conflicting canonical SubjectId roles", async () => {
  const duplicateRoles = await fixture("invalid-duplicate-roles.json");
  const result = await validateSacContract({
    schema: "workspace-manifest",
    document: duplicateRoles,
  });

  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.code === "duplicate_subject_role")).toBe(true);
});

test("SAC semantic validation rejects non-UTC timestamps and invalid lifecycle ordering", async () => {
  const outOfOrder = await fixture("invalid-time-order.json");
  const result = await validateSacContract({ schema: "fwk-receipt", document: outOfOrder });

  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.code === "invalid_temporal_order")).toBe(true);

  const nonUtc = structuredClone(await fixture("valid-workspace.json")) as {
    createdAt: string;
  };
  nonUtc.createdAt = "2026-08-11T00:00:00+01:00";
  const nonUtcResult = await validateSacContract({
    schema: "workspace-manifest",
    document: nonUtc,
  });
  expect(nonUtcResult.valid).toBe(false);
  expect(nonUtcResult.errors.some((error) => error.code === "invalid_utc_timestamp")).toBe(true);
});

test("SAC resolves only realpath-contained workspace-relative typed references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-sac-outside-"));
  try {
    await mkdir(path.join(root, "evidence"));
    await writeFile(path.join(root, "evidence", "fact.json"), "{}", "utf8");
    await writeFile(path.join(outside, "secret.json"), "{}", "utf8");
    await symlink(path.join(outside, "secret.json"), path.join(root, "evidence", "escape"));

    await expect(
      resolveWorkspaceReference({ workspaceRoot: root, kind: "evidence", uri: "./evidence/fact.json" }),
    ).resolves.toBe(path.join(root, "evidence", "fact.json"));

    for (const uri of [
      "/tmp/absolute.json",
      "file:///tmp/absolute.json",
      "https://example.test/reference.json",
      "./evidence/../secret.json",
      "./evidence/escape",
    ]) {
      await expect(
        resolveWorkspaceReference({ workspaceRoot: root, kind: "evidence", uri }),
      ).rejects.toMatchObject({ code: "unsafe_workspace_reference" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("SAC ledger validation rejects replayed/conflicting idempotency transitions", async () => {
  const corpus = (await fixture("replay-idempotency-corpus.json")) as { events: unknown[] };
  const result = await validateSacLedger({ events: corpus.events });

  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.code === "idempotency_replay")).toBe(true);
});

test("SAC authorization accepts only a trusted ActorContext and ignores client actor or role claims", async () => {
  const actor = await trustedActor("user:viewer", "request-correlation-0001");

  const result = await authorizeSacUse({
    actorContext: actor,
    workspaceId: "payments-work",
    action: "write",
    clientClaims: { actor: "user:owner", role: "owner", workspaceOwner: "user:owner" },
    resolveCurrentRole: async () => ({ role: "viewer", revision: "roles-1", workspaceId: "payments-work" }),
  });

  expect(result.allowed).toBe(false);
  expect(result.code).toBe("insufficient_role");
});

test("SAC authorization denies cross-workspace access, revoked roles, and role changes at use time", async () => {
  const actor = await trustedActor("user:editor", "request-correlation-0002", "trusted-harness");

  await expect(
    authorizeSacUse({
      actorContext: actor,
      workspaceId: "other-workspace",
      action: "read",
      resolveCurrentRole: async () => ({ role: "editor", revision: "roles-1", workspaceId: "payments-work" }),
    }),
  ).resolves.toMatchObject({ allowed: false, code: "workspace_access_denied" });

  await expect(
    authorizeSacUse({
      actorContext: actor,
      workspaceId: "payments-work",
      action: "read",
      resolveCurrentRole: async () => ({ role: "revoked", revision: "roles-2", workspaceId: "payments-work" }),
    }),
  ).resolves.toMatchObject({ allowed: false, code: "role_revoked" });

  let currentRevision = "roles-1";
  const authorization = await authorizeSacUse({
    actorContext: actor,
    workspaceId: "payments-work",
    action: "write",
    resolveCurrentRole: async () => ({ role: "editor", revision: currentRevision, workspaceId: "payments-work" }),
  });
  expect(authorization.allowed).toBe(true);

  currentRevision = "roles-2";
  await expect(
    authorization.authorizeAtUse(async () => ({ role: "revoked", revision: currentRevision, workspaceId: "payments-work" })),
  ).resolves.toMatchObject({ allowed: false, code: "authorization_changed" });
});

test("SAC rejects forged ActorContext objects because only a server authentication boundary can issue them", async () => {
  const forgedActor = Object.freeze({
    subject: "user:owner",
    authenticationMethod: "local-os" as const,
    issuedRoleRevision: "roles-1",
    requestCorrelationId: "request-correlation-0003",
  });
  const result = await authorizeSacUse({
    actorContext: forgedActor,
    workspaceId: "payments-work",
    action: "write",
    resolveCurrentRole: async () => ({ role: "owner", revision: "roles-1", workspaceId: "payments-work" }),
  });
  expect(result).toMatchObject({ allowed: false, code: "untrusted_actor" });
});

test("SAC authorization revalidates workspace identity at use time even when role and revision are unchanged", async () => {
  const actor = await trustedActor("user:editor", "request-correlation-0004");
  const authorization = await authorizeSacUse({
    actorContext: actor,
    workspaceId: "payments-work",
    action: "write",
    resolveCurrentRole: async () => ({ role: "editor", revision: "roles-1", workspaceId: "payments-work" }),
  });
  expect(authorization.allowed).toBe(true);
  await expect(
    authorization.authorizeAtUse(async () => ({ role: "editor", revision: "roles-1", workspaceId: "other-workspace" })),
  ).resolves.toMatchObject({ allowed: false, code: "workspace_access_denied" });
});

test("SAC evaluates the normative schema, including bounds, patterns, nested required fields, and closed objects", async () => {
  const proposal = structuredClone(await fixture("valid-proposal.json")) as Record<string, unknown>;
  proposal.kind = "invented-kind";
  proposal.summary = "";
  const proposalResult = await validateSacContract({ schema: "workspace-proposal", document: proposal });
  expect(proposalResult.valid).toBe(false);
  expect(proposalResult.errors.some((entry) => entry.code === "schema_enum")).toBe(true);
  expect(proposalResult.errors.some((entry) => entry.code === "schema_min_length")).toBe(true);

  const transition = structuredClone(await fixture("valid-accepted-transition.json")) as { priorEventHash: string };
  transition.priorEventHash = "not-a-sha256";
  expect((await validateSacContract({ schema: "workspace-proposal", document: transition })).valid).toBe(false);

  const review = structuredClone(await fixture("valid-review-decision.json")) as { security: Record<string, unknown> };
  delete review.security.policyRevision;
  review.security.unexpected = true;
  const reviewResult = await validateSacContract({ schema: "review-decision", document: review });
  expect(reviewResult.valid).toBe(false);
  expect(reviewResult.errors.some((entry) => entry.path === "$.security.policyRevision")).toBe(true);
  expect(reviewResult.errors.some((entry) => entry.path === "$.security.unexpected")).toBe(true);
});

test("SAC evaluates normative uniqueItems and contains cardinality plus x-uniqueBy resource semantics", async () => {
  const base = await fixture("valid-workspace.json") as { members: Record<string, unknown>[]; resources: Record<string, unknown>[] };

  const duplicateMember = structuredClone(base);
  duplicateMember.members.push(structuredClone(duplicateMember.members[0]!));
  const duplicateMemberResult = await validateSacContract({ schema: "workspace-manifest", document: duplicateMember });
  expect(duplicateMemberResult.valid).toBe(false);
  expect(duplicateMemberResult.errors.some((entry) => entry.code === "schema_unique_items")).toBe(true);

  const noOwner = structuredClone(base);
  noOwner.members = noOwner.members.map((member) => ({ ...member, role: "viewer" }));
  const noOwnerResult = await validateSacContract({ schema: "workspace-manifest", document: noOwner });
  expect(noOwnerResult.valid).toBe(false);
  expect(noOwnerResult.errors.some((entry) => entry.code === "schema_min_contains")).toBe(true);

  const twoOwners = structuredClone(base);
  twoOwners.members.push({ subject: "user:second-owner", role: "owner" });
  const twoOwnersResult = await validateSacContract({ schema: "workspace-manifest", document: twoOwners });
  expect(twoOwnersResult.valid).toBe(false);
  expect(twoOwnersResult.errors.some((entry) => entry.code === "schema_max_contains")).toBe(true);

  const duplicateResource = structuredClone(base);
  duplicateResource.resources.push(structuredClone(duplicateResource.resources[0]!));
  const duplicateResourceResult = await validateSacContract({ schema: "workspace-manifest", document: duplicateResource });
  expect(duplicateResourceResult.valid).toBe(false);
  expect(duplicateResourceResult.errors.some((entry) => entry.code === "duplicate_resource_reference")).toBe(true);
});

test("SAC production eligibility fails closed unless a strict enforced guard passes", async () => {
  for (const guard of [
    { mode: "disabled" },
    { mode: "advisory", decision: "pass" },
    { mode: "strict", availability: "unavailable" },
    { mode: "strict", availability: "error" },
    { mode: "strict", availability: "indeterminate" },
    { mode: "strict", availability: "available", decision: "error" },
  ] as const) {
    const result = await evaluateStrictSacGuard({ guard, operation: "egress" });
    expect(result.allowed, JSON.stringify(guard)).toBe(false);
    expect(result.disclose).toBe(false);
    expect(result.allowWrite).toBe(false);
  }

  await expect(
    evaluateStrictSacGuard({
      guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "security-1" },
      operation: "read",
    }),
  ).resolves.toMatchObject({ allowed: true, disclose: true, allowWrite: false });
});
