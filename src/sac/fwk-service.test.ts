import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FwkReadService, createLocalFwkReadService, resolvePolicySelectionSafely, diagnosePolicyReadiness } from "./fwk-service";
import { createSacAuthorizationServer, type SacVerifiedPrincipal } from "./index";
import { verifyAccessReceiptLedger } from "./receipt-integrity";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";

const stamp = "2026-08-11T00:00:00Z";
const source = async () => ({
  facts: [{ id: "fact-a", uri: "./evidence/a", revision: "r1", observedAt: stamp, expiresAt: "2099-01-01T00:00:00Z", trust: "primary" as const, visible: true, statement: "verified fact" }],
  work: { flowRef: { uri: "./flows/148", snapshot: "in-progress", revision: "r1" }, completed: ["T1"], next: ["T2"] },
  knowHow: [{ id: "wiki-a", kind: "wiki" as const, uri: "./wiki/a", revision: "r1", trust: "accepted" as const, status: "fresh" as const, accepted: true, visible: true }],
});
const make = async (guard: import("./index").StrictSacGuard = { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" }, authenticateRequest: (request: unknown) => Promise<SacVerifiedPrincipal | undefined> = async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" })) => new FwkReadService({ guard, authorizationServer: createSacAuthorizationServer({ authenticateRequest }), source: async () => source(), canonical: { workspaceRoot: await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-service-")), configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" }, now: () => new Date(stamp) });
const read = (service: FwkReadService, overrides: Partial<{ workspaceId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number }; required: string[]; optional: string[] }> = {}) => service.overview({ workspaceId: "workspace-a", request: undefined, requestCorrelationId: "fwk-read-correlation-0001", budget: { maxItems: 3, maxTokens: 100 }, ...overrides });

type PolicyExperimentFixtureIndex = Readonly<{
  baselineArtifactDigest: string;
  candidateArtifactDigest: string;
  corpusVersion: string;
  corpusDigest: string;
  baselineVersion: string;
  candidateVersion: string;
  evaluationReportDigest: string;
  baselineArtifactRef: string;
  candidateArtifactRef: string;
  corpusRef: string;
  evaluationReportRef: string;
}>;

const policyFixtureRoot = new URL("../../fixtures/sac-policy-experiment/", import.meta.url);

const readFixtureJson = async <T>(relativePath: string): Promise<T> => JSON.parse(await readFile(new URL(relativePath, policyFixtureRoot), "utf8")) as T;

const copyFixtureArtifact = async (workspaceRoot: string, relativeSource: string, destination: string): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(new URL(relativeSource, policyFixtureRoot)));
};

const seedRuntimePolicyFixtureWorkspace = async (workspaceRoot: string): Promise<PolicyExperimentFixtureIndex> => {
  const manifest = await readFixtureJson<{
    artifacts: Record<string, { ref: string; sha256: string }>;
  }>("artifact-manifest.json");
  const baselineArtifact = await readFixtureJson<{
    version: string;
  }>("artifacts/deterministic-baseline.json");
  const candidateArtifact = await readFixtureJson<{
    version: string;
  }>("artifacts/candidate.json");
  const corpus = await readFixtureJson<{
    manifest: { corpusVersion: string; corpusDigest: string; baselineVersion: string; baselineDigest: string; };
  }>("corpus.json");
  const report = await readFixtureJson<{
    candidateVersion: string;
    baselineVersion: string;
    baselineDigest: string;
    corpusVersion: string;
    corpusDigest: string;
    reportDigest: string;
  }>("evaluation-report.json");

  const policyDir = path.join(workspaceRoot, ".metaproject", "context-operations", "policy-experiment");
  const destination: Record<"baselineArtifactRef" | "candidateArtifactRef" | "corpusRef" | "evaluationReportRef", string> = {
    baselineArtifactRef: "./policy-experiment/artifacts/deterministic-baseline.json",
    candidateArtifactRef: "./policy-experiment/artifacts/candidate.json",
    corpusRef: "./policy-experiment/corpus.json",
    evaluationReportRef: "./policy-experiment/evaluation-report.json",
  };
  await mkdir(path.join(policyDir, "artifacts"), { recursive: true });
  await copyFixtureArtifact(workspaceRoot, "artifacts/deterministic-baseline.json", path.join(workspaceRoot, destination.baselineArtifactRef.slice(2)));
  await copyFixtureArtifact(workspaceRoot, "artifacts/candidate.json", path.join(workspaceRoot, destination.candidateArtifactRef.slice(2)));
  await copyFixtureArtifact(workspaceRoot, "corpus.json", path.join(workspaceRoot, destination.corpusRef.slice(2)));
  await copyFixtureArtifact(workspaceRoot, "evaluation-report.json", path.join(workspaceRoot, destination.evaluationReportRef.slice(2)));

  return {
    baselineArtifactDigest: manifest.artifacts.baseline!.sha256,
    candidateArtifactDigest: manifest.artifacts.candidate!.sha256,
    corpusVersion: corpus.manifest.corpusVersion,
    corpusDigest: corpus.manifest.corpusDigest,
    baselineVersion: baselineArtifact.version,
    candidateVersion: candidateArtifact.version,
    evaluationReportDigest: report.reportDigest,
    baselineArtifactRef: destination.baselineArtifactRef,
    candidateArtifactRef: destination.candidateArtifactRef,
    corpusRef: destination.corpusRef,
    evaluationReportRef: destination.evaluationReportRef,
  };
};

const writeRuntimePolicyConfig = async (workspaceRoot: string, patch: (input: PolicyExperimentFixtureIndex) => Partial<PolicyExperimentFixtureIndex> = () => ({})): Promise<PolicyExperimentFixtureIndex> => {
  const fixture = await seedRuntimePolicyFixtureWorkspace(workspaceRoot);
  const patched = { ...fixture, ...patch(fixture) };
  const policyDir = path.join(workspaceRoot, ".metaproject", "context-operations", "policy-experiment");
  await mkdir(policyDir, { recursive: true });
  const config = {
    enabled: true,
    killSwitch: false,
    candidateArtifactRef: fixture.candidateArtifactRef,
    candidateArtifactDigest: patched.candidateArtifactDigest,
    candidateVersion: fixture.candidateVersion,
    baselineArtifactRef: fixture.baselineArtifactRef,
    baselineArtifactDigest: patched.baselineArtifactDigest,
    baselineVersion: fixture.baselineVersion,
    corpusVersion: fixture.corpusVersion,
    corpusDigest: patched.corpusDigest,
    corpusRef: fixture.corpusRef,
    evaluationReportRef: fixture.evaluationReportRef,
    evaluationDigest: patched.evaluationReportDigest,
    rollbackBaselineVersion: fixture.baselineVersion,
  };
  await writeFile(path.join(policyDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
  return { ...fixture, ...patched };
};

test("mandatory budget overflow is typed and has no manifest or receipt", async () => {
  const result = await read(await make(), { budget: { maxItems: 0, maxTokens: 0 } });
  expect(result).toEqual({ code: "context_overflow", requiredId: "fact-a" });
  expect("receipt" in result).toBe(false);
});
test("optional omissions are partial and every omission is named", async () => {
  const result = await read(await make(), { budget: { maxItems: 1, maxTokens: 100 }, optional: ["work", "wiki-a"] });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.partial).toBe(true); expect(result.omittedOptional).toEqual(["work", "wiki-a"]);
  expect(result.receipt.contextAssembly.omittedOptional).toEqual(["./ids/work", "./ids/wiki-a"]);
});
test("receipts contain canonical trace/revisions and no forbidden raw fields", async () => {
  const result = await read(await make());
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.receipt).toMatchObject({ decision: "allowed", contextAssembly: { traceRef: expect.stringContaining("./.metaproject/context-operations/traces/"), configurationRevision: "context-r1" }, policy: { revision: "policy-r1" } });
  expect(JSON.stringify(result.receipt)).not.toContain("verified fact");
});
test("disabled and advisory guard deny disclosure while retaining metadata-only receipt", async () => {
  for (const guard of [{ mode: "disabled" }, { mode: "advisory", decision: "pass" }] as const) {
    const result = await read(await make(guard));
    expect("code" in result).toBe(false); if ("code" in result) continue;
    expect(result.manifest.freshness).toBe("denied"); expect(result.receipt.decision).toBe("denied");
  }
});

test("revision, expiry, and visibility outcomes are explicit and cannot produce a fresh overview", async () => {
  const dated = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => ({ facts: [
      { id: "stale", uri: "./evidence/stale", revision: "r1", observedAt: stamp, expiresAt: "2099-01-01T00:00:00Z", trust: "primary", visible: true, statement: "stale evidence", status: "stale" },
      { id: "expired", uri: "./evidence/expired", revision: "r1", observedAt: stamp, expiresAt: stamp, trust: "primary", visible: true, statement: "expired evidence" },
      { id: "denied", uri: "./evidence/denied", revision: "r1", observedAt: stamp, expiresAt: "2099-01-01T00:00:00Z", trust: "primary", visible: false, statement: "not disclosed" },
    ], knowHow: [{ id: "unaccepted", kind: "wiki", uri: "./wiki/draft", revision: "r1", trust: "accepted", status: "fresh", accepted: false, visible: true }] }),
    canonical: { workspaceRoot: await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-service-")), configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" }, now: () => new Date(stamp),
  });
  const result = await read(dated, { optional: ["unaccepted"] });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.freshness).toBe("stale");
  expect(result.manifest.facts.map((fact) => (fact as { freshness: string }).freshness)).toEqual(["stale", "expired"]);
  expect(result.manifest.facts.map((fact) => (fact as { statement: string }).statement)).not.toContain("not disclosed");
  expect(result.manifest.knowHow).toEqual([]);
  expect(result.receipt.contextAssembly.selected).toContain("./ids/stale");
  expect(result.receipt.contextAssembly.omittedOptional).toEqual(["./ids/denied", "./ids/unaccepted"]);
});

test("progressive read returns only the requested item and a resource receipt", async () => {
  const result = await (await make()).read({ workspaceId: "workspace-a", itemId: "wiki-a", request: undefined, requestCorrelationId: "fwk-read-correlation-0002", budget: { maxItems: 1, maxTokens: 100 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.facts).toEqual([]); expect(result.manifest.knowHow).toHaveLength(1);
  expect(result.receipt).toMatchObject({ action: "resource", resourceRef: "./ids/wiki-a" });
});

test("a caller supplied actor claim cannot mint a trusted FWK identity", async () => {
  const service = await make(undefined, async (request) => request === undefined
    ? { subject: "user:owner", authenticationMethod: "local-os" as const, roleRevision: "roles-r1" }
    : undefined);
  const result = await read(service, { request: { actor: "user:owner", roles: ["owner"] } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.freshness).toBe("denied");
  expect(result.receipt.actor).toBe("service:untrusted");
});

test("allowed and denied receipts are appended with a causal integrity chain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-ledger-"));
  const canonical = { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" };
  const allowed = new FwkReadService({ guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" }, authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }), source: async () => source(), canonical, now: () => new Date(stamp) });
  const denied = new FwkReadService({ guard: { mode: "disabled" }, authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }), source: async () => source(), canonical, now: () => new Date(stamp) });
  await read(allowed, { requestCorrelationId: "fwk-ledger-allowed-correlation-1" });
  await read(denied, { requestCorrelationId: "fwk-ledger-denied-correlation-1" });
  const receipts = (await readFile(path.join(root, ".metaproject", "context-operations", "access-receipts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { decision: string; integrity: { previousRecordHash: string; recordHash: string } });
  expect(receipts).toHaveLength(2);
  expect(receipts[0]!.integrity.previousRecordHash).toBe("GENESIS");
  expect(receipts[1]!.integrity.previousRecordHash).toBe(receipts[0]!.integrity.recordHash);
  expect(receipts[1]!.decision).toBe("denied");
  expect(JSON.stringify(receipts)).not.toContain("verified fact");
  const checkpointPath = path.join(root, ".metaproject", "context-operations", "access-receipts.checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
    ledgerBytes: number;
    recordCount: number;
    headHash: string;
    integrity: { checkpointHash: string };
  };
  expect(checkpoint).toMatchObject({
    ledgerBytes: (await stat(path.join(root, ".metaproject", "context-operations", "access-receipts.jsonl"))).size,
    recordCount: 2,
    headHash: receipts[1]!.integrity.recordHash,
  });
  expect(checkpoint.integrity.checkpointHash).toMatch(/^[a-f0-9]{64}$/);
  expect((await stat(checkpointPath)).mode & 0o777).toBe(0o600);
});
test("normal receipt appends use the bounded checkpoint fast path and missing checkpoints rebuild once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-checkpoint-"));
  let fullAudits = 0;
  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => source(),
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
    now: () => new Date(stamp),
    verifyReceiptLedger: (receipts) => {
      fullAudits += 1;
      return verifyAccessReceiptLedger(receipts);
    },
  });
  await read(service, { requestCorrelationId: "fwk-checkpoint-first-0001" });
  await read(service, { requestCorrelationId: "fwk-checkpoint-second-0001" });
  await read(service, { requestCorrelationId: "fwk-checkpoint-third-0001" });
  expect(fullAudits).toBe(0);

  await unlink(path.join(root, ".metaproject", "context-operations", "access-receipts.checkpoint.json"));
  await read(service, { requestCorrelationId: "fwk-checkpoint-rebuild-0001" });
  expect(fullAudits).toBe(1);
});

test("checkpoint refresh failure after append does not fail or duplicate the committed receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-checkpoint-failure-"));
  let refreshAttempts = 0;
  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => source(),
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
    now: () => new Date(stamp),
    refreshReceiptCheckpoint: async () => {
      refreshAttempts += 1;
      throw new Error("injected checkpoint rename failure");
    },
  });

  const result = await read(service, { requestCorrelationId: "fwk-checkpoint-failure-0001" });
  expect("code" in result).toBe(false);
  expect(refreshAttempts).toBe(1);
  const ledger = path.join(root, ".metaproject", "context-operations", "access-receipts.jsonl");
  const receipts = (await readFile(ledger, "utf8")).trim().split("\n");
  expect(receipts).toHaveLength(1);
  await expect(stat(path.join(root, ".metaproject", "context-operations", "access-receipts.checkpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("live long receipt audit retains lock ownership and serializes a second writer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-live-lock-"));
  const canonical = { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" };
  const bootstrap = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => source(), canonical, now: () => new Date(stamp),
  });
  await read(bootstrap, { requestCorrelationId: "fwk-live-lock-bootstrap-0001" });
  const checkpoint = path.join(root, ".metaproject", "context-operations", "access-receipts.checkpoint.json");
  await unlink(checkpoint);

  let releaseAudit!: () => void;
  const auditRelease = new Promise<void>((resolve) => { releaseAudit = resolve; });
  let auditStarted!: () => void;
  const started = new Promise<void>((resolve) => { auditStarted = resolve; });
  let activeAudits = 0;
  let maxActiveAudits = 0;
  const verify = async (receipts: Parameters<typeof verifyAccessReceiptLedger>[0]) => {
    activeAudits += 1;
    maxActiveAudits = Math.max(maxActiveAudits, activeAudits);
    auditStarted();
    await auditRelease;
    activeAudits -= 1;
    return verifyAccessReceiptLedger(receipts);
  };
  const makeWriter = () => new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => source(), canonical, now: () => new Date(stamp), verifyReceiptLedger: verify,
    receiptLockOptions: { staleMs: 10, heartbeatMs: 2, retryMs: 2, timeoutMs: 1_000 },
  });

  const first = read(makeWriter(), { requestCorrelationId: "fwk-live-lock-first-0001" });
  await started;
  const second = read(makeWriter(), { requestCorrelationId: "fwk-live-lock-second-0001" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseAudit();
  await Promise.all([first, second]);

  expect(maxActiveAudits).toBe(1);
  const ledger = path.join(root, ".metaproject", "context-operations", "access-receipts.jsonl");
  const receipts = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(receipts).toHaveLength(3);
  expect(verifyAccessReceiptLedger(receipts)).toMatchObject({ ok: true, verifiedCount: 3 });
  expect(JSON.parse(await readFile(checkpoint, "utf8"))).toMatchObject({ recordCount: 3, headHash: receipts[2]!.integrity.recordHash });
});

test("a corrupted receipt ledger refuses the next append", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-corrupt-ledger-"));
  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => source(),
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
    now: () => new Date(stamp),
  });
  await read(service, { requestCorrelationId: "fwk-corrupt-ledger-first-0001" });
  const ledger = path.join(root, ".metaproject", "context-operations", "access-receipts.jsonl");
  const first = JSON.parse((await readFile(ledger, "utf8")).trim()) as Record<string, unknown>;
  first.cost = { tokens: 999, toolCalls: 1, elapsedMs: 0 };
  await writeFile(ledger, `${JSON.stringify(first)}\n`);
  await expect(read(service, { requestCorrelationId: "fwk-corrupt-ledger-second-0001" }))
    .rejects.toThrow("invalid access receipt ledger");
});
test("same-size historical receipt corruption invalidates the checkpoint and refuses append", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-historical-corruption-"));
  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => source(),
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
    now: () => new Date(stamp),
  });
  await read(service, { requestCorrelationId: "fwk-historical-first-0001" });
  await read(service, { requestCorrelationId: "fwk-historical-second-0001" });
  const ledger = path.join(root, ".metaproject", "context-operations", "access-receipts.jsonl");
  const lines = (await readFile(ledger, "utf8")).trimEnd().split("\n");
  const first = JSON.parse(lines[0]!) as { cost: { tokens: number } };
  first.cost.tokens = 9;
  lines[0] = JSON.stringify(first);
  const before = (await stat(ledger)).size;
  await writeFile(ledger, `${lines.join("\n")}\n`);
  expect((await stat(ledger)).size).toBe(before);
  await expect(read(service, { requestCorrelationId: "fwk-historical-third-0001" }))
    .rejects.toThrow("invalid access receipt ledger");
});

const ledgerPaths = (root: string) => ({
  ledger: path.join(root, ".metaproject", "context-operations", "access-receipts.jsonl"),
  checkpoint: path.join(root, ".metaproject", "context-operations", "access-receipts.checkpoint.json"),
});
const receiptService = (root: string) => new FwkReadService({
  guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
  authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
  source: async () => source(),
  canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
  now: () => new Date(stamp),
});

test("same-size corruption of a middle receipt, not just the first, refuses the next append", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-mid-ledger-"));
  const service = receiptService(root);
  const { ledger } = ledgerPaths(root);
  await read(service, { requestCorrelationId: "fwk-mid-ledger-first-0001" });
  await read(service, { requestCorrelationId: "fwk-mid-ledger-second-0001" });
  await read(service, { requestCorrelationId: "fwk-mid-ledger-third-0001" });
  const lines = (await readFile(ledger, "utf8")).trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  const middle = JSON.parse(lines[1]!) as { cost: { tokens: number } };
  expect(middle.cost.tokens).toBe(0);
  middle.cost.tokens = 9;
  lines[1] = JSON.stringify(middle);
  const before = (await stat(ledger)).size;
  await writeFile(ledger, `${lines.join("\n")}\n`);
  expect((await stat(ledger)).size).toBe(before);
  await expect(read(service, { requestCorrelationId: "fwk-mid-ledger-fourth-0001" }))
    .rejects.toThrow("invalid access receipt ledger");
});

test("a checkpoint without a content commitment is re-audited rather than trusted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-legacy-checkpoint-"));
  const service = receiptService(root);
  const { ledger, checkpoint } = ledgerPaths(root);
  await read(service, { requestCorrelationId: "fwk-legacy-checkpoint-first-0001" });
  await read(service, { requestCorrelationId: "fwk-legacy-checkpoint-second-0001" });

  // A checkpoint in the shape the previous release wrote: stat identity, no
  // content digest. It must not be honoured, and the honest ledger under it
  // must still work once it has been re-audited.
  const current = JSON.parse(await readFile(checkpoint, "utf8")) as { ledgerBytes: number; recordCount: number; headHash: string; tailOffset: number };
  const stats = await stat(ledger, { bigint: true });
  const legacyBody = {
    schemaVersion: "1.0", ledgerBytes: current.ledgerBytes, device: stats.dev.toString(), inode: stats.ino.toString(),
    modifiedNs: stats.mtimeNs.toString(), changedNs: stats.ctimeNs.toString(),
    recordCount: current.recordCount, headHash: current.headHash, tailOffset: current.tailOffset,
  };
  const legacyHash = createHash("sha256").update(JSON.stringify(legacyBody), "utf8").digest("hex");
  await writeFile(checkpoint, `${JSON.stringify({ ...legacyBody, integrity: { checkpointHash: legacyHash } })}\n`);

  let fullAudits = 0;
  const auditing = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({ authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }) }),
    source: async () => source(),
    canonical: { workspaceRoot: root, configurationRevision: "context-r1", policyRef: "./security/policy", policyRevision: "policy-r1" },
    now: () => new Date(stamp),
    verifyReceiptLedger: (receipts) => { fullAudits += 1; return verifyAccessReceiptLedger(receipts); },
  });
  await read(auditing, { requestCorrelationId: "fwk-legacy-checkpoint-third-0001" });
  expect(fullAudits).toBe(1);
  const upgraded = JSON.parse(await readFile(checkpoint, "utf8")) as { schemaVersion: string; contentDigest?: string };
  expect(upgraded.schemaVersion).toBe("1.1");
  expect(upgraded.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  const receipts = (await readFile(ledger, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(verifyAccessReceiptLedger(receipts)).toMatchObject({ ok: true, verifiedCount: 3 });
});

test("a legacy checkpoint over an already-tampered ledger is refused, not adopted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-legacy-tampered-"));
  const service = receiptService(root);
  const { ledger, checkpoint } = ledgerPaths(root);
  await read(service, { requestCorrelationId: "fwk-legacy-tampered-first-0001" });
  await read(service, { requestCorrelationId: "fwk-legacy-tampered-second-0001" });
  const current = JSON.parse(await readFile(checkpoint, "utf8")) as { ledgerBytes: number; recordCount: number; headHash: string; tailOffset: number };

  const lines = (await readFile(ledger, "utf8")).trimEnd().split("\n");
  const first = JSON.parse(lines[0]!) as { cost: { tokens: number } };
  first.cost.tokens = 9;
  lines[0] = JSON.stringify(first);
  await writeFile(ledger, `${lines.join("\n")}\n`);

  const stats = await stat(ledger, { bigint: true });
  const legacyBody = {
    schemaVersion: "1.0", ledgerBytes: Number(stats.size), device: stats.dev.toString(), inode: stats.ino.toString(),
    modifiedNs: stats.mtimeNs.toString(), changedNs: stats.ctimeNs.toString(),
    recordCount: current.recordCount, headHash: current.headHash, tailOffset: current.tailOffset,
  };
  const legacyHash = createHash("sha256").update(JSON.stringify(legacyBody), "utf8").digest("hex");
  await writeFile(checkpoint, `${JSON.stringify({ ...legacyBody, integrity: { checkpointHash: legacyHash } })}\n`);

  await expect(read(service, { requestCorrelationId: "fwk-legacy-tampered-third-0001" }))
    .rejects.toThrow("invalid access receipt ledger");
});

test("a ledger truncated to a valid prefix is refused instead of silently shortened", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-truncated-"));
  const service = receiptService(root);
  const { ledger } = ledgerPaths(root);
  await read(service, { requestCorrelationId: "fwk-truncated-first-0001" });
  await read(service, { requestCorrelationId: "fwk-truncated-second-0001" });
  const lines = (await readFile(ledger, "utf8")).trimEnd().split("\n");
  // Dropping the last record leaves a chain that verifies perfectly on its own.
  await writeFile(ledger, `${lines[0]!}\n`);
  expect(verifyAccessReceiptLedger([JSON.parse(lines[0]!)])).toMatchObject({ ok: true });
  await expect(read(service, { requestCorrelationId: "fwk-truncated-third-0001" }))
    .rejects.toThrow("invalid access receipt ledger: truncated-ledger");
});

test("runtime policy experiment resolver prefers candidate when full pinned chain is valid", async () => {
  const canonical = { workspaceRoot: await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-phase6-runtime-")), policyRef: "./security/policy/local", policyRevision: "local-offline-v1" };
  const fixture = await writeRuntimePolicyConfig(canonical.workspaceRoot);
  const authorizationServer = createSacAuthorizationServer({
    authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }),
  });
  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer,
    source: async () => source(),
    canonical: { ...canonical, configurationRevision: "context-r1" },
    policySelection: () => resolvePolicySelectionSafely(canonical.workspaceRoot, canonical),
    now: () => new Date(stamp),
  });
  const result = await read(service, { requestCorrelationId: "fwk-phase6-0001-runtime-long" });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.receipt.policy).toEqual({ ref: fixture.candidateArtifactRef, revision: fixture.candidateVersion });
});

test("runtime policy experiment resolver returns deterministic baseline on digest mismatch", async () => {
  const canonical = { workspaceRoot: await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-phase6-runtime-")), policyRef: "./security/policy/local", policyRevision: "local-offline-v1" };
  const fixture = await writeRuntimePolicyConfig(canonical.workspaceRoot, (value) => ({ candidateArtifactDigest: `${value.candidateArtifactDigest.slice(0, -1)}0` }));
  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({
      authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }),
    }),
    source: async () => source(),
    canonical: { ...canonical, configurationRevision: "context-r1" },
    policySelection: () => resolvePolicySelectionSafely(canonical.workspaceRoot, canonical),
    now: () => new Date(stamp),
  });
  const result = await read(service, { requestCorrelationId: "fwk-phase6-0002-runtime-long" });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.receipt.policy).toEqual({ ref: canonical.policyRef, revision: canonical.policyRevision });
  expect(result.receipt.policy.ref).toBe(canonical.policyRef);
  expect(fixture.candidateArtifactDigest).toBeTruthy();
});

test("runtime policy experiment resolver cannot activate with kill-switch true", async () => {
  const canonical = { workspaceRoot: await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-phase6-runtime-")), policyRef: "./security/policy/local", policyRevision: "local-offline-v1" };
  await writeRuntimePolicyConfig(canonical.workspaceRoot, (value) => ({ ...value, candidateArtifactDigest: value.candidateArtifactDigest }));
  const configPath = path.join(canonical.workspaceRoot, ".metaproject", "context-operations", "policy-experiment", "config.json");
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  await writeFile(configPath, JSON.stringify({ ...parsed, killSwitch: true }), "utf8");

  const service = new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "guard-r1" },
    authorizationServer: createSacAuthorizationServer({
      authenticateRequest: async () => ({ subject: "user:owner", authenticationMethod: "local-os", roleRevision: "roles-r1" }),
    }),
    source: async () => source(),
    canonical: { ...canonical, configurationRevision: "context-r1" },
    policySelection: () => resolvePolicySelectionSafely(canonical.workspaceRoot, canonical),
    now: () => new Date(stamp),
  });
  const result = await read(service, { requestCorrelationId: "fwk-phase6-0003-runtime-long" });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.receipt.policy).toEqual({ ref: canonical.policyRef, revision: canonical.policyRevision });
});

test("phase-6b readiness: a valid enabled config is integrity-ready and would activate", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "keryx-sac-readiness-ok-"));
  await writeRuntimePolicyConfig(workspaceRoot);
  const report = await diagnosePolicyReadiness(workspaceRoot);
  expect(report.configPresent).toBe(true);
  expect(report.integrityReady).toBe(true);
  expect(report.candidateWouldActivate).toBe(true);
  expect(report.steps.filter((step) => step.status === "fail")).toEqual([]);
  expect(report.steps.some((step) => step.step === "activation-gate" && step.status === "pass")).toBe(true);
});

test("phase-6b readiness: a disabled config is still integrity-ready but would not activate", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "keryx-sac-readiness-off-"));
  await writeRuntimePolicyConfig(workspaceRoot);
  const configPath = path.join(workspaceRoot, ".metaproject", "context-operations", "policy-experiment", "config.json");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, JSON.stringify({ ...parsed, enabled: false }), "utf8");
  const report = await diagnosePolicyReadiness(workspaceRoot);
  expect(report.integrityReady).toBe(true);
  expect(report.candidateWouldActivate).toBe(false);
  const failed = report.steps.filter((step) => step.status === "fail").map((step) => step.step);
  expect(failed).toEqual(["activation-flags"]);
});

test("phase-6b readiness: a missing config is reported, not ready", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "keryx-sac-readiness-missing-"));
  const report = await diagnosePolicyReadiness(workspaceRoot);
  expect(report.configPresent).toBe(false);
  expect(report.integrityReady).toBe(false);
  expect(report.candidateWouldActivate).toBe(false);
  expect(report.steps).toEqual([{ step: "config", status: "fail", detail: expect.stringContaining("no policy-experiment config") }]);
});

test("phase-6b readiness: a pinned-digest mismatch fails the artifact gate, not the format gate", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "keryx-sac-readiness-digest-"));
  await writeRuntimePolicyConfig(workspaceRoot);
  const configPath = path.join(workspaceRoot, ".metaproject", "context-operations", "policy-experiment", "config.json");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  await writeFile(configPath, JSON.stringify({ ...parsed, baselineArtifactDigest: "a".repeat(64) }), "utf8");
  const report = await diagnosePolicyReadiness(workspaceRoot);
  expect(report.integrityReady).toBe(false);
  expect(report.candidateWouldActivate).toBe(false);
  expect(report.steps.some((step) => step.step === "digest-format" && step.status === "pass")).toBe(true);
  expect(report.steps.some((step) => step.step === "baseline-artifact" && step.status === "fail")).toBe(true);
});

// SLATE-3 bundled fix / AC-5: a flow-read failure inside
// createLocalFwkReadService's `source` composition (deleted/malformed/
// permission-denied flow resource) must yield `work.state === "unbound"`,
// never an uncaught rejection. This exercises the real local composition end
// to end (real WorkspaceService + real workspace.json on disk), not a
// synthetic `source` stub, since the bug lived specifically inside
// fwk-service.ts's own `work` IIFE.
test("a malformed-JSON flow resource yields work.state \"unbound\" from createLocalFwkReadService.overview, not an uncaught rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-local-flow-"));
  const authorizationServer = localWorkspaceAuthorizationServer();
  const strictGuard = { mode: "strict" as const, availability: "available" as const, decision: "pass" as const, policyRevision: "local-offline-v1" };
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer, strictGuard });
  await workspaces.create({ request: undefined, requestCorrelationId: "fwk-local-flow-correlation-0001", id: "workspace-a", title: "Local flow read" });
  await mkdir(path.join(root, "flows"), { recursive: true });
  // Not valid JSON: JSON.parse throws inside the `work` IIFE's try/catch.
  await writeFile(path.join(root, "flows", "broken.json"), "{ this is not valid json");
  await workspaces.addResource({ request: undefined, requestCorrelationId: "fwk-local-flow-correlation-0001", workspaceId: "workspace-a", resource: { kind: "flow", uri: "./flows/broken.json" } });

  const service = createLocalFwkReadService(root);
  const result = await service.overview({ workspaceId: "workspace-a", request: undefined, requestCorrelationId: "fwk-local-flow-correlation-0002", budget: { maxItems: 10, maxTokens: 1000 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.work).toEqual({ state: "unbound" });
});

// Review finding: `migrateFlow` (src/flow/store.ts) throws for any
// schemaVersion other than 1 or 2 — including a missing field, since
// `undefined !== 1 && undefined !== 2`. The `work` IIFE's catch documents
// swallowing that throw into "unbound" exactly like malformed JSON, but that
// specific path had zero test coverage until now.
test("a flow resource with valid shape but an unsupported/missing schemaVersion yields work.state \"unbound\", never an uncaught rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-local-flow-badversion-"));
  const authorizationServer = localWorkspaceAuthorizationServer();
  const strictGuard = { mode: "strict" as const, availability: "available" as const, decision: "pass" as const, policyRevision: "local-offline-v1" };
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer, strictGuard });
  await workspaces.create({ request: undefined, requestCorrelationId: "fwk-local-flow-badversion-correlation-0001", id: "workspace-a", title: "Local flow read" });
  await mkdir(path.join(root, "flows"), { recursive: true });
  // Valid shape (id/status/updatedAt/tasks all present, passes the IIFE's own
  // shape check) but schemaVersion is absent — migrateFlow throws on this,
  // not a JSON.parse SyntaxError.
  await writeFile(path.join(root, "flows", "badversion.json"), JSON.stringify({ id: "flow-1", status: "in-progress", updatedAt: stamp, tasks: [] }));
  await workspaces.addResource({ request: undefined, requestCorrelationId: "fwk-local-flow-badversion-correlation-0001", workspaceId: "workspace-a", resource: { kind: "flow", uri: "./flows/badversion.json" } });

  const service = createLocalFwkReadService(root);
  const result = await service.overview({ workspaceId: "workspace-a", request: undefined, requestCorrelationId: "fwk-local-flow-badversion-correlation-0002", budget: { maxItems: 10, maxTokens: 1000 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.work).toEqual({ state: "unbound" });
});

test("a flow resource deleted after registration also yields work.state \"unbound\", never an uncaught rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-local-flow-deleted-"));
  const authorizationServer = localWorkspaceAuthorizationServer();
  const strictGuard = { mode: "strict" as const, availability: "available" as const, decision: "pass" as const, policyRevision: "local-offline-v1" };
  const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer, strictGuard });
  await workspaces.create({ request: undefined, requestCorrelationId: "fwk-local-flow-deleted-correlation-0001", id: "workspace-a", title: "Local flow read" });
  await mkdir(path.join(root, "flows"), { recursive: true });
  const flowPath = path.join(root, "flows", "gone.json");
  await writeFile(flowPath, JSON.stringify({ id: "flow-1", status: "in-progress", updatedAt: stamp, tasks: [] }));
  await workspaces.addResource({ request: undefined, requestCorrelationId: "fwk-local-flow-deleted-correlation-0001", workspaceId: "workspace-a", resource: { kind: "flow", uri: "./flows/gone.json" } });
  await unlink(flowPath);

  const service = createLocalFwkReadService(root);
  const result = await service.overview({ workspaceId: "workspace-a", request: undefined, requestCorrelationId: "fwk-local-flow-deleted-correlation-0002", budget: { maxItems: 10, maxTokens: 1000 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(result.manifest.work).toEqual({ state: "unbound" });
});

// Review finding 2: the actor's role being revoked strictly between the
// manifest read and a resource's re-authorization-at-use
// (`WorkspaceService.readResourceForActor`'s own documented TOCTOU-closing
// re-check) must deny the WHOLE overview, never surface as a partial
// disclosure where facts/knowHow already resolved successfully stay visible
// and only `work` quietly becomes "unbound". `beforeResourceOpen` fires once
// per `readResourceForActor` call, in the exact gap between its first and
// second (re-)authorization check — the real window the finding names. The
// facts read (the 1st call) is left untouched so it legitimately succeeds;
// revoking the actor's membership on the 2nd call (the flow resource)
// reproduces the race precisely where the bug lived: inside the local
// `work` IIFE's own catch, which used to swallow `WorkspaceServiceError`
// unconditionally instead of only content-class failures.
test("an actor's role revoked strictly between the flow resource's two re-authorization checks denies the whole overview, not just \"work: unbound\"", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sac-fwk-local-flow-revoked-"));
  const authorizationServer = localWorkspaceAuthorizationServer();
  const actor = await authorizationServer.actorContextFor(undefined, "fwk-local-flow-revoked-correlation-0000");
  if (!actor) throw new Error("test setup: local authorization server did not issue an actor");

  await mkdir(path.join(root, "evidence"), { recursive: true });
  await writeFile(path.join(root, "evidence", "a.md"), "evidence content");
  await mkdir(path.join(root, "flows"), { recursive: true });
  await writeFile(path.join(root, "flows", "revoke.json"), JSON.stringify({ id: "flow-1", status: "in-progress", updatedAt: stamp, tasks: [] }));

  const manifestPath = path.join(root, ".metaproject", "workspaces", "workspace-a", "workspace.json");
  let opens = 0;
  const service = createLocalFwkReadService(root, {
    beforeResourceOpen: async () => {
      opens += 1;
      // 1st call = the evidence fact (left alone, so facts legitimately
      // succeed). 2nd call = the flow resource: revoke here, strictly
      // between its own two re-authorization checks. Only the actor's own
      // membership is removed — a second, permanent owner is kept in place
      // so the manifest stays schema-valid (a workspace always needs an
      // owner) and this is a genuine per-actor revocation, not a workspace
      // wipe.
      if (opens === 2) {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { members: Array<{ subject: string }> };
        manifest.members = manifest.members.filter((member) => member.subject !== actor.subject);
        await writeFile(manifestPath, JSON.stringify(manifest));
      }
    },
  });

  // Registered through a plain WorkspaceService using the SAME authorization
  // server/actor as the service under test, so `service.overview` below
  // authenticates as the same actor whose role gets revoked mid-flight.
  const setupWorkspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer, strictGuard: { mode: "strict" as const, availability: "available" as const, decision: "pass" as const, policyRevision: "local-offline-v1" } });
  await setupWorkspaces.create({ request: undefined, requestCorrelationId: "fwk-local-flow-revoked-correlation-0001", id: "workspace-a", title: "Revoked role" });
  // Resources are registered while the actor still holds "owner" (write-rank
  // required by addResource); the actor is demoted to "viewer" (still enough
  // for the read-only overview below) and a distinct permanent owner is added
  // only afterward, so `beforeResourceOpen`'s later membership removal above
  // leaves a schema-valid, non-empty, single-owner manifest behind.
  await setupWorkspaces.addResource({ request: undefined, requestCorrelationId: "fwk-local-flow-revoked-correlation-0001", workspaceId: "workspace-a", resource: { kind: "evidence", uri: "./evidence/a.md" } });
  await setupWorkspaces.addResource({ request: undefined, requestCorrelationId: "fwk-local-flow-revoked-correlation-0001", workspaceId: "workspace-a", resource: { kind: "flow", uri: "./flows/revoke.json" } });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { members: Array<{ subject: string; role: string }> };
  manifest.members = [{ subject: "user:fwk-revoked-permanent-owner", role: "owner" }, { subject: actor.subject, role: "viewer" }];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await service.overview({ workspaceId: "workspace-a", request: undefined, requestCorrelationId: "fwk-local-flow-revoked-correlation-0002", budget: { maxItems: 10, maxTokens: 1000 } });
  expect("code" in result).toBe(false); if ("code" in result) return;
  expect(opens).toBe(2);
  // The full denied() shape: facts: [] and knowHow: [] too, not merely
  // work: { state: "unbound" } with facts still populated (the old bug).
  expect(result.manifest).toEqual({ facts: [], work: { state: "unbound" }, knowHow: [], freshness: "denied" });
  expect(result.receipt.decision).toBe("denied");
});
