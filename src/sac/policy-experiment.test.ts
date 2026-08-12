import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  buildPolicyCorpus,
  createPolicyExperimentEvidenceAuthority,
  defaultPolicyExperimentConfig,
  evaluatePolicyExperiment,
  formatPolicyEvaluationReport,
  hashVerifiedTaskOutcome,
  resolvePolicyExperiment,
  rollbackPolicyExperiment,
  POLICY_EXPERIMENT_SANDBOX_PROFILE,
  type CandidateSelection,
  type PolicyCorpus,
  type PolicyExperimentCandidate,
  type PolicyExperimentSandbox,
  type PolicyExperimentSandboxEvidence,
  type TrustedVerifiedTaskOutcome,
  type VerifiedTaskOutcome,
} from "./policy-experiment";
import {
  sealAccessReceipt,
  verifyAccessReceiptLedger,
  type IntegrityLinkedAccessReceipt,
} from "./receipt-integrity";

const stamp = "2026-08-12T00:00:00Z";
const hex = (character: string): string => character.repeat(64);
const artifactFor = (linked: IntegrityLinkedAccessReceipt): string => JSON.stringify({
  receiptHash: linked.integrity.recordHash,
  independentlyVerified: true,
});
const evidenceAuthority = createPolicyExperimentEvidenceAuthority();

function receipt(
  id: string,
  previousRecordHash: string = "GENESIS",
  overrides: Partial<IntegrityLinkedAccessReceipt> = {},
): IntegrityLinkedAccessReceipt {
  return sealAccessReceipt({
    schemaVersion: "1.0",
    id,
    workspaceId: "workspace-private",
    actor: "agent:producer",
    action: "overview",
    decision: "allowed",
    recordedAt: stamp,
    cost: { tokens: 80, toolCalls: 2, elapsedMs: 12 },
    contextAssembly: {
      traceRef: "./context/trace-private",
      configurationRevision: "context-r1",
      selected: ["./ids/private-a", "./ids/private-b"],
      omittedOptional: ["./ids/private-c"],
    },
    policy: { ref: "./policies/deterministic", revision: "policy-r1" },
    outcome: "useful",
    ...overrides,
  }, previousRecordHash);
}

function outcome(
  linked: IntegrityLinkedAccessReceipt,
  overrides: Partial<VerifiedTaskOutcome> = {},
): VerifiedTaskOutcome {
  const base = {
    schemaVersion: "1.0" as const,
    id: `outcome-${linked.id}`,
    receiptHash: linked.integrity.recordHash,
    verifier: {
      kind: "completion-gate" as const,
      subject: "service:independent-verifier",
      artifactRef: `./verification/${linked.id}.json`,
      artifactRevision: "gate-r1",
      artifactHash: createHash("sha256").update(artifactFor(linked)).digest("hex"),
    },
    result: "pass" as const,
    expectedSelection: "select" as const,
    caseClass: "standard" as const,
    verifiedAt: stamp,
  };
  const merged = { ...base, ...overrides };
  return { ...merged, integrity: { recordHash: hashVerifiedTaskOutcome(merged) } };
}

const trustOutcome = (entry: VerifiedTaskOutcome): TrustedVerifiedTaskOutcome => {
  const linked = { integrity: { recordHash: entry.receiptHash } } as IntegrityLinkedAccessReceipt;
  return evidenceAuthority.resolveOutcome({ outcome: entry, artifactContent: artifactFor(linked) });
};

const corpusInput = (receipts: IntegrityLinkedAccessReceipt[], outcomes: VerifiedTaskOutcome[]) => ({
  receipts,
  outcomes: outcomes.map(trustOutcome),
  receiptLedgerRef: "./.metaproject/context-operations/access-receipts.jsonl",
  corpusVersion: "sac-policy-corpus-1.0.0",
  baselineVersion: "deterministic-context-1.0.0",
  candidateVersion: "candidate-1.0.0",
  pseudonymKey: "test-only-corpus-scoped-key",
  pseudonymizationRevision: "hmac-sha256-v1",
  knownConfigurationRevisions: ["context-r1"],
  knownPolicyRevisions: ["policy-r1"],
  split: { algorithm: "sha256-modulo-v1" as const, seed: "split-seed-v1", holdoutPercent: 50 },
});

function validCorpus(): PolicyCorpus {
  const first = receipt("receipt-a");
  const second = receipt("receipt-b", first.integrity.recordHash);
  const adversarial = receipt("receipt-c", second.integrity.recordHash);
  return buildPolicyCorpus(corpusInput(
    [first, second, adversarial],
    [outcome(first), outcome(second), outcome(adversarial, { caseClass: "adversarial" })],
  ));
}

describe("AccessReceipt integrity", () => {
  test("verifies every record hash and predecessor edge", () => {
    const first = receipt("receipt-a");
    const second = receipt("receipt-b", first.integrity.recordHash);
    expect(verifyAccessReceiptLedger([first, second])).toEqual({
      ok: true,
      headHash: second.integrity.recordHash,
      verifiedCount: 2,
    });
  });

  test("rejects a modified body and every dependent chain segment", () => {
    const first = receipt("receipt-a");
    const second = receipt("receipt-b", first.integrity.recordHash);
    const tampered = { ...first, cost: { ...first.cost, tokens: 1 } };
    expect(verifyAccessReceiptLedger([tampered, second])).toMatchObject({
      ok: false,
      firstInvalidIndex: 0,
      validPrefixLength: 0,
      reason: "record-hash-mismatch",
    });
  });

  test("rejects duplicate and broken predecessor hashes", () => {
    const first = receipt("receipt-a");
    const broken = receipt("receipt-b", hex("a"));
    expect(verifyAccessReceiptLedger([first, broken])).toMatchObject({
      ok: false,
      firstInvalidIndex: 1,
      reason: "predecessor-mismatch",
    });
    expect(verifyAccessReceiptLedger([first, first])).toMatchObject({
      ok: false,
      firstInvalidIndex: 1,
      reason: "duplicate-record-hash",
    });
  });

  test("rejects hash-valid receipts that violate the closed receipt schema", () => {
    const valid = receipt("receipt-a");
    const { integrity: _integrity, ...body } = valid;
    const withRawContent = sealAccessReceipt({
      ...body,
      prompt: "must never enter an AccessReceipt",
    } as typeof body, "GENESIS");
    expect(verifyAccessReceiptLedger([withRawContent])).toMatchObject({
      ok: false,
      firstInvalidIndex: 0,
      reason: "invalid-record-shape",
    });
  });
});

describe("offline corpus construction", () => {
  test("includes only rows bound to independently hashed outcomes", () => {
    const linked = receipt("receipt-a");
    const corpus = buildPolicyCorpus(corpusInput([linked], [outcome(linked)]));
    expect(corpus.rows).toHaveLength(1);
    expect(corpus.rows[0]).toMatchObject({
      receipt: {
        recordHash: linked.integrity.recordHash,
        previousRecordHash: "GENESIS",
        configurationRevision: "context-r1",
        policyRevision: "policy-r1",
      },
      outcome: {
        artifactRevision: "gate-r1",
        artifactHash: outcome(linked).verifier.artifactHash,
        result: "pass",
      },
    });
    expect(corpus.rows[0]?.outcome.recordHash).toHaveLength(64);
  });

  test("never treats AccessReceipt.outcome or a producing-agent verifier as ground truth", () => {
    const linked = receipt("receipt-a", "GENESIS", { outcome: "useful" });
    const selfVerified = outcome(linked, {
      verifier: { ...outcome(linked).verifier, subject: linked.actor },
    });
    const selfCorpus = buildPolicyCorpus(corpusInput([linked], [selfVerified]));
    expect(selfCorpus.rows).toEqual([]);
    expect(selfCorpus.quarantine).toContainEqual(expect.objectContaining({ reason: "verifier-not-independent" }));

    const missingCorpus = buildPolicyCorpus(corpusInput([linked], []));
    expect(missingCorpus.rows).toEqual([]);
    expect(missingCorpus.quarantine).toContainEqual(expect.objectContaining({ reason: "independent-outcome-missing" }));
  });

  test("quarantines outcome digest mismatch and unknown revisions", () => {
    const linked = receipt("receipt-a");
    const badDigest = { ...outcome(linked), integrity: { recordHash: hex("0") } };
    const digestCorpus = buildPolicyCorpus(corpusInput([linked], [badDigest]));
    expect(digestCorpus.quarantine).toContainEqual(expect.objectContaining({ reason: "outcome-hash-mismatch" }));

    const unknown = receipt("receipt-b", "GENESIS", {
      contextAssembly: { ...linked.contextAssembly, configurationRevision: "unknown-config" },
    });
    const revisionCorpus = buildPolicyCorpus(corpusInput([unknown], [outcome(unknown)]));
    expect(revisionCorpus.quarantine).toContainEqual(expect.objectContaining({ reason: "unknown-configuration-revision" }));
  });

  test("quarantines ambiguous duplicate independent outcomes", () => {
    const linked = receipt("receipt-a");
    const first = outcome(linked);
    const secondBody = { ...first, id: "second-outcome", integrity: undefined };
    const { integrity: _ignored, ...body } = secondBody;
    const second = { ...body, integrity: { recordHash: hashVerifiedTaskOutcome(body) } } as VerifiedTaskOutcome;
    const corpus = buildPolicyCorpus(corpusInput([linked], [first, second]));
    expect(corpus.rows).toEqual([]);
    expect(corpus.quarantine).toContainEqual(expect.objectContaining({ reason: "duplicate-independent-outcome" }));
  });

  test("quarantines closed-schema-invalid and independently unresolved outcomes", () => {
    const linked = receipt("receipt-a");
    const malformedBody = {
      ...outcome(linked),
      verifier: { ...outcome(linked).verifier, kind: "producer-claim" },
      integrity: undefined,
    };
    const { integrity: _ignored, ...body } = malformedBody;
    const malformed = { ...body, integrity: { recordHash: hashVerifiedTaskOutcome(body as never) } };
    const malformedEvidence = evidenceAuthority.resolveOutcome({
      outcome: malformed,
      artifactContent: artifactFor(linked),
    });
    const unresolvedEvidence = evidenceAuthority.resolveOutcome({
      outcome: outcome(linked),
      artifactContent: "wrong independently resolved artifact",
    });
    for (const evidence of [malformedEvidence, unresolvedEvidence]) {
      const corpus = buildPolicyCorpus({ ...corpusInput([linked], []), outcomes: [evidence] });
      expect(corpus.rows).toEqual([]);
      expect(corpus.quarantine).toContainEqual(expect.objectContaining({
        reason: evidence === malformedEvidence ? "outcome-invalid-shape" : "verifier-artifact-invalid",
      }));
    }
  });

  test("publishes an allowlisted minimized manifest and corpus-scoped pseudonyms", () => {
    const corpus = validCorpus();
    const serialized = JSON.stringify(corpus);
    expect(serialized).not.toContain("workspace-private");
    expect(serialized).not.toContain("agent:producer");
    expect(serialized).not.toContain("trace-private");
    expect(serialized).not.toContain("private-a");
    expect(serialized).not.toContain("useful");
    expect(corpus.manifest).toMatchObject({
      corpusVersion: "sac-policy-corpus-1.0.0",
      provenance: { receiptLedgerRef: "./.metaproject/context-operations/access-receipts.jsonl" },
      selection: { independentOutcomesRequired: true, selfReportedOutcomeAccepted: false },
      redaction: { allowlistOnly: true, pseudonymizationRevision: "hmac-sha256-v1" },
      quarantine: { excludedFromAllSplits: true },
      split: { algorithm: "sha256-modulo-v1", holdoutPercent: 50 },
      adversarial: { required: true },
    });
  });

  test("creates deterministic disjoint train, holdout and adversarial partitions", () => {
    const first = validCorpus();
    const second = validCorpus();
    expect(second).toEqual(first);
    const memberships = new Map<string, string>();
    for (const row of first.rows) {
      expect(memberships.has(row.id)).toBe(false);
      memberships.set(row.id, row.split);
    }
    expect(new Set(first.rows.map((row) => row.split))).toContain("adversarial");
    expect(first.manifest.split.digests.train).not.toBe(first.manifest.split.digests.holdout);
  });

  test("domain-separates pseudonyms by corpus and pseudonymization revision", () => {
    const linked = receipt("receipt-a");
    const first = buildPolicyCorpus(corpusInput([linked], [outcome(linked)]));
    const nextCorpus = buildPolicyCorpus({
      ...corpusInput([linked], [outcome(linked)]),
      corpusVersion: "sac-policy-corpus-2.0.0",
    });
    const nextPseudonymizer = buildPolicyCorpus({
      ...corpusInput([linked], [outcome(linked)]),
      pseudonymizationRevision: "hmac-sha256-v2",
    });
    expect(nextCorpus.rows[0]?.workspacePseudonym).not.toBe(first.rows[0]?.workspacePseudonym);
    expect(nextPseudonymizer.rows[0]?.workspacePseudonym).not.toBe(first.rows[0]?.workspacePseudonym);
  });

  test("published corpus rows resolve their receipt and independent outcome hashes", async () => {
    const root = new URL("../../fixtures/sac-policy-experiment/", import.meta.url);
    const ledger = (await readFile(new URL("receipts.jsonl", root), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as IntegrityLinkedAccessReceipt);
    const corpus = JSON.parse(await readFile(new URL("corpus.json", root), "utf8")) as PolicyCorpus;
    const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
    const evaluation = JSON.parse(await readFile(new URL("evaluation-report.json", root), "utf8"));
    expect(verifyAccessReceiptLedger(ledger)).toEqual({
      ok: true,
      headHash: corpus.manifest.provenance.receiptHeadHash,
      verifiedCount: ledger.length,
    });
    expect(corpus.manifest).toEqual(manifest);
    expect(evaluation).toMatchObject({
      status: "pass",
      corpusDigest: corpus.manifest.corpusDigest,
      holdout: { status: "pass" },
      adversarial: { status: "pass" },
      securityNonRegression: true,
    });
    const receiptHashes = new Set(ledger.map((entry) => entry.integrity.recordHash));
    for (const row of corpus.rows) {
      expect(receiptHashes.has(row.receipt.recordHash)).toBe(true);
      const artifact = JSON.parse(await readFile(new URL(row.outcome.artifactRef.slice(2), new URL("../../", import.meta.url)), "utf8"));
      const artifactHash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
      expect(artifactHash).toBe(row.outcome.artifactHash);
    }
    expect(JSON.stringify(corpus)).not.toMatch(/synthetic-workspace|agent:synthetic-producer|\"outcome\":\"useful\"/);
  });
});

const candidate: PolicyExperimentCandidate = {
  version: "candidate-1.0.0",
  artifactDigest: hex("c"),
};

const sandboxEvidence = (): PolicyExperimentSandboxEvidence => evidenceAuthority.resolveSandboxControls({
  candidateVersion: candidate.version,
  candidateDigest: candidate.artifactDigest,
  profile: POLICY_EXPERIMENT_SANDBOX_PROFILE,
  evidenceRevision: "sandbox-controls-1.0.0",
  allowedControlArtifact: "allowed control completed under containment",
  deniedEscapeArtifact: "escape denied under containment",
});

const sandbox = (select: (ids: readonly string[]) => CandidateSelection, overrides: Partial<PolicyExperimentSandbox> = {}): PolicyExperimentSandbox => ({
  profile: POLICY_EXPERIMENT_SANDBOX_PROFILE,
  controlEvidence: sandboxEvidence(),
  caseTimeoutMs: 100,
  run: async (request) => ({ kind: "completed", selection: select(request.baselineAuthorizedIds) }),
  ...overrides,
});

describe("sandboxed candidate evaluation and activation", () => {
  test("uses a fail-closed read-only, network-off required sandbox profile", () => {
    expect(POLICY_EXPERIMENT_SANDBOX_PROFILE).toEqual({
      mode: "read-only",
      network: "off",
      writableRoots: [],
      readDenyList: [],
      allowedDomains: [],
      required: true,
    });
  });

  test("compares candidate and deterministic baseline without widening selection", async () => {
    const corpus = validCorpus();
    const report = await evaluatePolicyExperiment({
      corpus,
      baselineVersion: "deterministic-context-1.0.0",
      candidate,
      sandbox: sandbox((ids) => ({ selectedIds: ids })),
    });
    expect(report.status).toBe("pass");
    expect(report.holdout.status).toBe("pass");
    expect(report.adversarial.status).toBe("pass");
    expect(report.securityNonRegression).toBe(true);
    expect(formatPolicyEvaluationReport(report)).toBe(formatPolicyEvaluationReport(report));
  });

  test("rejects protected fields, unknown IDs and sandbox/control failure", async () => {
    const corpus = validCorpus();
    for (const selection of [
      { selectedIds: ["unknown-id"] },
      { selectedIds: [], roles: ["owner"] },
      { selectedIds: [], securityGate: "pass" },
      { selectedIds: [], acceptanceCriteria: ["changed"] },
      { selectedIds: [], policyVersion: "self-updated" },
    ] as CandidateSelection[]) {
      const report = await evaluatePolicyExperiment({
        corpus,
        baselineVersion: "deterministic-context-1.0.0",
        candidate,
        sandbox: sandbox(() => selection),
      });
      expect(report.status).toBe("fail");
      expect(report.securityNonRegression).toBe(false);
    }

    const unavailable = await evaluatePolicyExperiment({
      corpus,
      baselineVersion: "deterministic-context-1.0.0",
      candidate,
      sandbox: sandbox(() => ({ selectedIds: [] }), { controlEvidence: {} as PolicyExperimentSandboxEvidence }),
    });
    expect(unavailable.status).toBe("fail");
  });

  test("fails nondeterministic and timed-out candidate executions closed", async () => {
    const corpus = validCorpus();
    let invocation = 0;
    const nondeterministic = sandbox((ids) => (++invocation % 2 === 1 ? { selectedIds: ids } : { selectedIds: [] }));
    const nondeterministicReport = await evaluatePolicyExperiment({
      corpus, baselineVersion: corpus.manifest.baselineVersion, candidate, sandbox: nondeterministic,
    });
    expect(nondeterministicReport.status).toBe("fail");
    expect(nondeterministicReport.reasons).toContainEqual(expect.stringContaining("candidate-nondeterministic"));

    const timedOut = sandbox(() => ({ selectedIds: [] }), {
      caseTimeoutMs: 1,
      run: async () => new Promise(() => undefined),
    });
    const timedOutReport = await evaluatePolicyExperiment({
      corpus, baselineVersion: corpus.manifest.baselineVersion, candidate, sandbox: timedOut,
    });
    expect(timedOutReport.status).toBe("fail");
    expect(timedOutReport.reasons).toContainEqual(expect.stringContaining("candidate-timeout"));
  });

  test("binds evaluation to the corpus baseline", async () => {
    const corpus = validCorpus();
    const report = await evaluatePolicyExperiment({
      corpus,
      baselineVersion: "different-baseline-2.0.0",
      candidate,
      sandbox: sandbox((ids) => ({ selectedIds: ids })),
    });
    expect(report.status).toBe("fail");
    expect(report.reasons).toContain("baseline-pin-mismatch");
  });

  test("is disabled by default and every gate/pin/kill/rollback failure selects baseline", async () => {
    const corpus = validCorpus();
    const evaluation = await evaluatePolicyExperiment({
      corpus,
      baselineVersion: "deterministic-context-1.0.0",
      candidate,
      sandbox: sandbox((ids) => ({ selectedIds: ids })),
    });
    const baseline = { selectedIds: evaluation.candidateSelectedIds, source: "deterministic-baseline" as const };
    const defaults = defaultPolicyExperimentConfig();
    expect(defaults).toMatchObject({ enabled: false, killSwitch: true });
    expect(resolvePolicyExperiment({ config: defaults, evaluation, candidate, corpus, baseline })).toEqual(baseline);

    const enabled = {
      enabled: true,
      killSwitch: false,
      candidateVersion: candidate.version,
      candidateDigest: candidate.artifactDigest,
      corpusVersion: corpus.manifest.corpusVersion,
      corpusDigest: corpus.manifest.corpusDigest,
      baselineVersion: evaluation.baselineVersion,
      evaluationDigest: evaluation.reportDigest,
      rollbackBaselineVersion: evaluation.baselineVersion,
    } as const;
    expect(resolvePolicyExperiment({ config: enabled, evaluation, candidate, corpus, baseline }).source).toBe("candidate");
    expect(resolvePolicyExperiment({ config: { ...enabled, killSwitch: true }, evaluation, candidate, corpus, baseline })).toEqual(baseline);
    expect(resolvePolicyExperiment({ config: { ...enabled, candidateDigest: hex("d") }, evaluation, candidate, corpus, baseline })).toEqual(baseline);
    expect(resolvePolicyExperiment({ config: enabled, evaluation: { ...evaluation, status: "fail" }, candidate, corpus, baseline })).toEqual(baseline);
    expect(rollbackPolicyExperiment(enabled, "operator-request")).toMatchObject({ enabled: false, killSwitch: true });

    const tamperedEvaluation = { ...evaluation, candidateSelectedIds: ["outside-runtime-baseline"] };
    expect(resolvePolicyExperiment({ config: enabled, evaluation: tamperedEvaluation, candidate, corpus, baseline })).toEqual(baseline);
    expect(resolvePolicyExperiment({
      config: enabled,
      evaluation,
      candidate,
      corpus,
      baseline: { selectedIds: [], source: "deterministic-baseline" },
    })).toEqual({ selectedIds: [], source: "deterministic-baseline" });
  });

  test("fails closed for floating versions and non-digest activation pins", async () => {
    const corpus = validCorpus();
    const evaluation = await evaluatePolicyExperiment({
      corpus,
      baselineVersion: "deterministic-context-1.0.0",
      candidate,
      sandbox: sandbox((ids) => ({ selectedIds: ids })),
    });
    const baseline = { selectedIds: ["baseline-a"], source: "deterministic-baseline" as const };
    const enabled = {
      enabled: true,
      killSwitch: false,
      candidateVersion: candidate.version,
      candidateDigest: candidate.artifactDigest,
      corpusVersion: corpus.manifest.corpusVersion,
      corpusDigest: corpus.manifest.corpusDigest,
      baselineVersion: evaluation.baselineVersion,
      evaluationDigest: evaluation.reportDigest,
      rollbackBaselineVersion: evaluation.baselineVersion,
    } as const;

    const floatingCandidate = { version: "latest", artifactDigest: candidate.artifactDigest };
    const floatingEvaluation = { ...evaluation, candidateVersion: "latest" };
    expect(resolvePolicyExperiment({
      config: { ...enabled, candidateVersion: "latest" },
      evaluation: floatingEvaluation,
      candidate: floatingCandidate,
      corpus,
      baseline,
    })).toEqual(baseline);
    expect(resolvePolicyExperiment({
      config: { ...enabled, candidateDigest: "not-a-sha256" },
      evaluation,
      candidate: { ...candidate, artifactDigest: "not-a-sha256" },
      corpus,
      baseline,
    })).toEqual(baseline);
  });
});
