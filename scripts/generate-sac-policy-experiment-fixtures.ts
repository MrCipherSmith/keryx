import { createHash } from "node:crypto";
import {
  buildPolicyCorpus,
  createPolicyExperimentEvidenceAuthority,
  evaluatePolicyExperiment,
  hashPolicySandboxExecutionReceipt,
  hashPolicySandboxObservation,
  hashVerifiedTaskOutcome,
  POLICY_EXPERIMENT_SANDBOX_PROFILE,
  type PolicyExperimentEvidenceOwner,
  type VerifiedTaskOutcome,
} from "../src/sac/policy-experiment";
import { sealAccessReceipt, type IntegrityLinkedAccessReceipt } from "../src/sac/receipt-integrity";

const fixtureRoot = new URL("../fixtures/sac-policy-experiment/", import.meta.url);
const stamp = "2026-08-12T00:00:00Z";
const sha256 = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");
const readFixture = (relative: string): Promise<string> => Bun.file(new URL(relative, fixtureRoot)).text();

function receipt(id: string, previousRecordHash: string, action: "overview" | "resource"): IntegrityLinkedAccessReceipt {
  return sealAccessReceipt({
    schemaVersion: "1.0", id, workspaceId: "synthetic-workspace", actor: "agent:synthetic-producer",
    action, decision: "allowed", recordedAt: stamp,
    cost: { tokens: action === "overview" ? 64 : 128, toolCalls: 2, elapsedMs: 20 },
    contextAssembly: { traceRef: `./synthetic/${id}`, configurationRevision: "context-r1", selected: ["./ids/optional-a"], omittedOptional: [] },
    policy: { ref: "./policies/deterministic", revision: "policy-r1" },
    ...(action === "resource" ? { resourceRef: "./ids/optional-a" } : {}),
    outcome: "useful",
  }, previousRecordHash);
}

export async function generateSacPolicyExperimentFixtures(): Promise<Readonly<Record<string, string>>> {
  const baselineArtifact = await readFixture("artifacts/deterministic-baseline.json");
  const candidateArtifact = await readFixture("artifacts/candidate.json");
  const allowedControlArtifact = await readFixture("sandbox/allowed-control.json");
  const deniedControlArtifact = await readFixture("sandbox/denied-escape-control.json");
  const baselineDigest = sha256(baselineArtifact);
  const candidateDigest = sha256(candidateArtifact);
  const outcomes: Record<string, unknown> = {};
  const executionReceipts: unknown[] = [];
  const verifiedOutcomes = new Map<string, VerifiedTaskOutcome>();
  const owner: PolicyExperimentEvidenceOwner = {
    resolveOutcome: (reference) => {
      const verifiedOutcome = verifiedOutcomes.get(reference.artifactHash);
      const artifact = outcomes[reference.artifactRef];
      if (!verifiedOutcome || artifact === undefined) return undefined;
      return {
        authenticated: true, kind: reference.kind, subject: reference.subject,
        producerSubject: "agent:synthetic-producer", receiptHash: reference.receiptHash,
        artifactRef: reference.artifactRef, artifactRevision: reference.artifactRevision,
        artifactContent: JSON.stringify(artifact), verifiedOutcome,
      };
    },
    resolveSandboxControls: (request) => ({
      authenticated: true,
      candidateVersion: request.candidateVersion,
      candidateDigest: request.candidateDigest,
      profileDigest: request.profileDigest,
      evidenceRevision: request.evidenceRevision,
      deadlineMs: request.deadlineMs,
      allowed: { control: "allowed-control", attempted: true, outcome: "completed", exitCode: 0, enforcement: "sandbox-allow", artifactContent: allowedControlArtifact, artifactHash: sha256(allowedControlArtifact) },
      denied: { control: "denied-escape-control", attempted: true, outcome: "blocked", exitCode: null, enforcement: "sandbox-deny", artifactContent: deniedControlArtifact, artifactHash: sha256(deniedControlArtifact) },
    }),
    executeSandbox: async (request) => {
      const observation = { kind: "completed" as const, selection: { selectedIds: request.request.baselineAuthorizedIds } };
      const artifactContent = JSON.stringify({ requestDigest: request.requestDigest, observation });
      const body = {
        candidateVersion: request.candidateVersion, candidateDigest: request.candidateDigest,
        profileDigest: request.profileDigest, requestDigest: request.requestDigest,
        evidenceRevision: request.evidenceRevision, deadlineMs: request.deadlineMs,
        allowedControlArtifactHash: request.allowedControlArtifactHash,
        deniedControlArtifactHash: request.deniedControlArtifactHash,
        observation, observationDigest: hashPolicySandboxObservation(observation),
        termination: "not-requested" as const, artifactHash: sha256(artifactContent),
      };
      const execution = { authenticated: true, artifactContent, ...body, integrity: { recordHash: hashPolicySandboxExecutionReceipt(body) } };
      executionReceipts.push(execution);
      return execution;
    },
    terminateSandbox: async () => undefined,
  };
  const authority = createPolicyExperimentEvidenceAuthority(owner);
  const makeOutcome = (linked: IntegrityLinkedAccessReceipt, caseClass: "standard" | "adversarial") => {
    const artifactRef = `./fixtures/sac-policy-experiment/outcomes/${linked.id}.json`;
    const artifact = { schemaVersion: 1, gateId: `gate-${linked.id}`, runId: `run-${linked.id}`, status: "pass", checks: [{ checkId: "independent-task-verification", status: "pass", blocking: true, evidenceRefs: [`evidence-${linked.id}`] }], evaluatedAt: stamp, evidenceRefs: [`evidence-${linked.id}`], unresolvedBlockerIds: [] };
    outcomes[artifactRef] = artifact;
    const artifactHash = sha256(JSON.stringify(artifact));
    const body = {
      schemaVersion: "1.0" as const, id: `verified-${linked.id}`, receiptHash: linked.integrity.recordHash,
      verifier: { kind: "completion-gate" as const, subject: "service:synthetic-verifier", artifactRef, artifactRevision: "gate-r1", artifactHash },
      result: "pass" as const, expectedSelection: "select" as const, caseClass, verifiedAt: stamp,
    };
    const verified: VerifiedTaskOutcome = { ...body, integrity: { recordHash: hashVerifiedTaskOutcome(body) } };
    verifiedOutcomes.set(artifactHash, verified);
    return authority.resolveOutcome({ outcome: verified });
  };
  const first = receipt("synthetic-receipt-a", "GENESIS", "overview");
  const second = receipt("synthetic-receipt-b", first.integrity.recordHash, "resource");
  const third = receipt("synthetic-receipt-c", second.integrity.recordHash, "overview");
  const receipts = [first, second, third];
  const corpus = buildPolicyCorpus({
    receipts, outcomes: [makeOutcome(first, "standard"), makeOutcome(second, "standard"), makeOutcome(third, "adversarial")],
    receiptLedgerRef: "./fixtures/sac-policy-experiment/receipts.jsonl",
    corpusVersion: "sac-policy-corpus-1.0.0", baselineVersion: "deterministic-context-1.0.0",
    baselineDigest, candidateVersion: "candidate-1.0.0", pseudonymKey: "synthetic-fixture-key-not-a-production-key",
    pseudonymizationRevision: "hmac-sha256-v1", knownConfigurationRevisions: ["context-r1"],
    knownPolicyRevisions: ["policy-r1"], split: { algorithm: "sha256-modulo-v1", seed: "published-split-v1", holdoutPercent: 50 },
  });
  const caseTimeoutMs = 1000;
  const evidenceRevision = "sandbox-controls-1.0.0";
  const controlEvidence = authority.resolveSandboxControls({ candidateVersion: "candidate-1.0.0", candidateDigest, profile: POLICY_EXPERIMENT_SANDBOX_PROFILE, evidenceRevision, deadlineMs: caseTimeoutMs });
  const executionCapability = authority.createSandboxExecutionCapability({ candidateVersion: "candidate-1.0.0", candidateDigest, profile: POLICY_EXPERIMENT_SANDBOX_PROFILE, evidenceRevision, deadlineMs: caseTimeoutMs, controlEvidence });
  const report = await evaluatePolicyExperiment({
    corpus,
    baseline: { version: "deterministic-context-1.0.0", artifactDigest: baselineDigest, select: (request) => ({ selectedIds: request.eligibleIds }) },
    candidate: { version: "candidate-1.0.0", artifactDigest: candidateDigest },
    sandbox: { profile: POLICY_EXPERIMENT_SANDBOX_PROFILE, controlEvidence, executionCapability, caseTimeoutMs, terminationAckTimeoutMs: 25 },
  });
  const generated: Record<string, string> = {
    "receipts.jsonl": `${receipts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "corpus.json": `${JSON.stringify(corpus, null, 2)}\n`,
    "manifest.json": `${JSON.stringify(corpus.manifest, null, 2)}\n`,
    "evaluation-report.json": `${JSON.stringify(report, null, 2)}\n`,
    "sandbox/execution-receipts.json": `${JSON.stringify(executionReceipts, null, 2)}\n`,
  };
  for (const [reference, artifact] of Object.entries(outcomes)) generated[reference.replace("./fixtures/sac-policy-experiment/", "")] = `${JSON.stringify(artifact)}\n`;
  return generated;
}

if (import.meta.main) {
  const generated = await generateSacPolicyExperimentFixtures();
  if (process.argv.includes("--check")) {
    for (const [relative, expected] of Object.entries(generated)) {
      const actual = await readFixture(relative);
      if (actual !== expected) throw new Error(`stale generated fixture: ${relative}`);
    }
  } else {
    for (const [relative, content] of Object.entries(generated)) await Bun.write(new URL(relative, fixtureRoot), content);
  }
}
