import { createHash, createHmac } from "node:crypto";
import type { SandboxProfile } from "../harness/process/sandbox/profile";
import {
  verifyAccessReceiptLedger,
  type IntegrityLinkedAccessReceipt,
} from "./receipt-integrity";

const hashPattern = /^[a-f0-9]{64}$/;
const floatingVersionPattern = /(?:^|[-_.:])(?:latest|next|head|main|develop)(?:$|[-_.:])/i;

function isImmutableVersion(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value)
    && /\d/.test(value)
    && !floatingVersionPattern.test(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

const stableJson = (value: unknown): string => JSON.stringify(stableValue(value));
const sha256 = (value: unknown): string =>
  createHash("sha256").update(stableJson(value), "utf8").digest("hex");
const sha256Content = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const pseudonym = (key: string, value: string): string =>
  createHmac("sha256", key).update(value, "utf8").digest("hex");

const outcomeIdPattern = /^[a-z][a-z0-9-]{2,127}$/;
const subjectPattern = /^(?:user|team|service|agent):[a-z0-9][a-z0-9._-]{0,127}$/;
const workspacePathPattern = /^\.\/(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const strictUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

export type VerifiedTaskOutcomeBody = Readonly<{
  schemaVersion: "1.0";
  id: string;
  receiptHash: string;
  verifier: Readonly<{
    kind: "completion-gate" | "test-report" | "health-report" | "review-report";
    subject: string;
    artifactRef: string;
    artifactRevision: string;
    artifactHash: string;
  }>;
  result: "pass" | "fail";
  expectedSelection: "select" | "omit";
  caseClass: "standard" | "adversarial";
  verifiedAt: string;
}>;

export type VerifiedTaskOutcome = VerifiedTaskOutcomeBody & Readonly<{
  integrity: Readonly<{ recordHash: string }>;
}>;

export type TrustedVerifiedTaskOutcome = Readonly<{
  kind: "trusted-verified-task-outcome";
}>;

export type PolicyExperimentSandboxEvidence = Readonly<{
  kind: "trusted-policy-sandbox-evidence";
}>;

type OutcomeEvidenceRecord = Readonly<{
  receiptHash?: string;
  outcome?: VerifiedTaskOutcome;
  rejection?: "outcome-invalid-shape" | "outcome-hash-mismatch" | "verifier-artifact-invalid" | "verifier-not-independent";
}>;

type SandboxEvidenceRecord = Readonly<{
  allowedControlPassed: boolean;
  deniedEscapePassed: boolean;
  candidateVersion: string;
  candidateDigest: string;
  profileDigest: string;
  evidenceRevision: string;
  deadlineMs: number;
}>;

const trustedOutcomes = new WeakMap<object, OutcomeEvidenceRecord>();
const trustedSandboxEvidence = new WeakMap<object, SandboxEvidenceRecord>();

function isStrictUtcTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && strictUtcPattern.test(value)
    && !Number.isNaN(Date.parse(value));
}

function hasVerifiedTaskOutcomeShape(value: unknown): value is VerifiedTaskOutcome {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion", "id", "receiptHash", "verifier", "result", "expectedSelection",
      "caseClass", "verifiedAt", "integrity",
    ])
    || value.schemaVersion !== "1.0"
    || typeof value.id !== "string"
    || !outcomeIdPattern.test(value.id)
    || typeof value.receiptHash !== "string"
    || !hashPattern.test(value.receiptHash)
    || !["pass", "fail"].includes(value.result as string)
    || !["select", "omit"].includes(value.expectedSelection as string)
    || !["standard", "adversarial"].includes(value.caseClass as string)
    || !isStrictUtcTimestamp(value.verifiedAt)) return false;
  if (!isRecord(value.verifier)
    || !hasExactKeys(value.verifier, ["kind", "subject", "artifactRef", "artifactRevision", "artifactHash"])
    || !["completion-gate", "test-report", "health-report", "review-report"].includes(value.verifier.kind as string)
    || typeof value.verifier.subject !== "string"
    || !subjectPattern.test(value.verifier.subject)
    || typeof value.verifier.artifactRef !== "string"
    || !workspacePathPattern.test(value.verifier.artifactRef)
    || !isImmutableVersion(value.verifier.artifactRevision)
    || typeof value.verifier.artifactHash !== "string"
    || !hashPattern.test(value.verifier.artifactHash)) return false;
  return isRecord(value.integrity)
    && hasExactKeys(value.integrity, ["recordHash"])
    && typeof value.integrity.recordHash === "string"
    && hashPattern.test(value.integrity.recordHash);
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export type PolicyExperimentEvidenceAuthority = Readonly<{
  resolveOutcome(input: Readonly<{
    outcome: unknown;
  }>): TrustedVerifiedTaskOutcome;
  resolveSandboxControls(input: Readonly<{
    candidateVersion: string;
    candidateDigest: string;
    profile: Readonly<SandboxProfile>;
    evidenceRevision: string;
    deadlineMs: number;
  }>): PolicyExperimentSandboxEvidence;
}>;

export type OwnerResolvedOutcomeArtifact = Readonly<{
  authenticated: boolean;
  kind: VerifiedTaskOutcomeBody["verifier"]["kind"];
  subject: string;
  producerSubject: string;
  receiptHash: string;
  artifactRef: string;
  artifactRevision: string;
  artifactContent: string | Uint8Array;
  verifiedOutcome: VerifiedTaskOutcome;
}>;

export type OutcomeArtifactReference = Readonly<{
  kind: VerifiedTaskOutcomeBody["verifier"]["kind"];
  subject: string;
  receiptHash: string;
  artifactRef: string;
  artifactRevision: string;
  artifactHash: string;
}>;

export type OwnerSandboxControlObservation = Readonly<{
  control: "allowed-control" | "denied-escape-control";
  attempted: boolean;
  outcome: "completed" | "blocked" | "failed" | "timeout";
  exitCode: number | null;
  enforcement: "sandbox-allow" | "sandbox-deny" | "none";
  artifactContent: string | Uint8Array;
  artifactHash: string;
}>;

export type OwnerResolvedSandboxControls = Readonly<{
  authenticated: boolean;
  candidateVersion: string;
  candidateDigest: string;
  profileDigest: string;
  evidenceRevision: string;
  deadlineMs: number;
  allowed: OwnerSandboxControlObservation;
  denied: OwnerSandboxControlObservation;
}>;

export type PolicyExperimentEvidenceOwner = Readonly<{
  resolveOutcome(reference: OutcomeArtifactReference): OwnerResolvedOutcomeArtifact | undefined;
  resolveSandboxControls(input: Readonly<{
    candidateVersion: string;
    candidateDigest: string;
    profileDigest: string;
    evidenceRevision: string;
    deadlineMs: number;
  }>): OwnerResolvedSandboxControls | undefined;
}>;

/**
 * Create the owner-side evidence mint. Returned evidence is recognized through
 * module-private WeakMaps, so copying its public marker cannot forge trust.
 */
export function createPolicyExperimentEvidenceAuthority(owner: PolicyExperimentEvidenceOwner): PolicyExperimentEvidenceAuthority {
  return Object.freeze({
    resolveOutcome(input): TrustedVerifiedTaskOutcome {
      const snapshot = cloneJsonValue(input.outcome);
      const receiptHash = isRecord(snapshot) && typeof snapshot.receiptHash === "string"
        ? snapshot.receiptHash
        : undefined;
      let record: OutcomeEvidenceRecord;
      if (!hasVerifiedTaskOutcomeShape(snapshot)) {
        record = { ...(receiptHash ? { receiptHash } : {}), rejection: "outcome-invalid-shape" };
      } else {
        const { integrity, ...body } = snapshot;
        if (hashVerifiedTaskOutcome(body) !== integrity.recordHash) {
          record = { receiptHash: snapshot.receiptHash, rejection: "outcome-hash-mismatch" };
        } else {
          let resolved: OwnerResolvedOutcomeArtifact | undefined;
          try {
            resolved = owner.resolveOutcome({
              kind: snapshot.verifier.kind,
              subject: snapshot.verifier.subject,
              receiptHash: snapshot.receiptHash,
              artifactRef: snapshot.verifier.artifactRef,
              artifactRevision: snapshot.verifier.artifactRevision,
              artifactHash: snapshot.verifier.artifactHash,
            });
          } catch { resolved = undefined; }
          if (!resolved
            || resolved.authenticated !== true
            || resolved.kind !== snapshot.verifier.kind
            || resolved.subject !== snapshot.verifier.subject
            || resolved.receiptHash !== snapshot.receiptHash
            || resolved.artifactRef !== snapshot.verifier.artifactRef
            || resolved.artifactRevision !== snapshot.verifier.artifactRevision
            || sha256Content(resolved.artifactContent) !== snapshot.verifier.artifactHash
            || !hasVerifiedTaskOutcomeShape(resolved.verifiedOutcome)
            || stableJson(resolved.verifiedOutcome) !== stableJson(snapshot)) {
            record = { receiptHash: snapshot.receiptHash, rejection: "verifier-artifact-invalid" };
          } else if (resolved.producerSubject === resolved.subject) {
            record = { receiptHash: snapshot.receiptHash, rejection: "verifier-not-independent" };
          } else {
            record = { receiptHash: snapshot.receiptHash, outcome: snapshot };
          }
        }
      }
      const evidence = Object.freeze({ kind: "trusted-verified-task-outcome" as const });
      trustedOutcomes.set(evidence, record);
      return evidence;
    },
    resolveSandboxControls(input): PolicyExperimentSandboxEvidence {
      const profileDigest = sha256(input.profile);
      let resolved: OwnerResolvedSandboxControls | undefined;
      try {
        resolved = owner.resolveSandboxControls({
          candidateVersion: input.candidateVersion,
          candidateDigest: input.candidateDigest,
          profileDigest,
          evidenceRevision: input.evidenceRevision,
          deadlineMs: input.deadlineMs,
        });
      } catch { resolved = undefined; }
      const bindingValid = resolved?.authenticated === true
        && resolved.candidateVersion === input.candidateVersion
        && resolved.candidateDigest === input.candidateDigest
        && resolved.profileDigest === profileDigest
        && resolved.evidenceRevision === input.evidenceRevision
        && resolved.deadlineMs === input.deadlineMs;
      const allowedHashValid = resolved !== undefined
        && hashPattern.test(resolved.allowed.artifactHash)
        && sha256Content(resolved.allowed.artifactContent) === resolved.allowed.artifactHash;
      const deniedHashValid = resolved !== undefined
        && hashPattern.test(resolved.denied.artifactHash)
        && sha256Content(resolved.denied.artifactContent) === resolved.denied.artifactHash;
      const inputValid = isImmutableVersion(input.candidateVersion)
        && hashPattern.test(input.candidateDigest)
        && isImmutableVersion(input.evidenceRevision)
        && Number.isInteger(input.deadlineMs)
        && input.deadlineMs > 0;
      const record: SandboxEvidenceRecord = {
        allowedControlPassed: Boolean(inputValid && bindingValid
          && allowedHashValid
          && resolved?.allowed.control === "allowed-control"
          && resolved?.allowed.attempted === true
          && resolved.allowed.outcome === "completed"
          && resolved.allowed.exitCode === 0
          && resolved.allowed.enforcement === "sandbox-allow"),
        deniedEscapePassed: Boolean(inputValid && bindingValid
          && deniedHashValid
          && resolved?.denied.control === "denied-escape-control"
          && resolved?.denied.attempted === true
          && resolved.denied.outcome === "blocked"
          && resolved.denied.exitCode === null
          && resolved.denied.enforcement === "sandbox-deny"),
        candidateVersion: input.candidateVersion,
        candidateDigest: input.candidateDigest,
        profileDigest,
        evidenceRevision: input.evidenceRevision,
        deadlineMs: input.deadlineMs,
      };
      const evidence = Object.freeze({ kind: "trusted-policy-sandbox-evidence" as const });
      trustedSandboxEvidence.set(evidence, record);
      return evidence;
    },
  });
}

export function hashVerifiedTaskOutcome(
  outcome: VerifiedTaskOutcomeBody | Omit<VerifiedTaskOutcome, "integrity">,
): string {
  return sha256(outcome);
}

export type PolicyCorpusSplit = "train" | "holdout" | "adversarial";

export type PolicyCorpusRow = Readonly<{
  id: string;
  scenarioPseudonym: string;
  workspacePseudonym: string;
  producerPseudonym: string;
  receipt: Readonly<{
    ledgerRef: string;
    recordHash: string;
    previousRecordHash: string;
    configurationRevision: string;
    policyRevision: string;
  }>;
  outcome: Readonly<{
    artifactRef: string;
    artifactRevision: string;
    artifactHash: string;
    recordHash: string;
    result: "pass" | "fail";
  }>;
  features: Readonly<{
    action: IntegrityLinkedAccessReceipt["action"];
    decision: IntegrityLinkedAccessReceipt["decision"];
    tokenBucket: number;
    toolCallBucket: number;
    elapsedMsBucket: number;
    selectedCount: number;
    omittedOptionalCount: number;
  }>;
  expectedSelection: "select" | "omit";
  split: PolicyCorpusSplit;
}>;

export type QuarantineReason =
  | "receipt-ledger-invalid"
  | "independent-outcome-missing"
  | "duplicate-independent-outcome"
  | "outcome-invalid-shape"
  | "outcome-hash-mismatch"
  | "outcome-receipt-mismatch"
  | "verifier-not-independent"
  | "verifier-artifact-invalid"
  | "unknown-configuration-revision"
  | "unknown-policy-revision";

export type PolicyCorpusQuarantine = Readonly<{
  receiptHash: string;
  reason: QuarantineReason;
}>;

export type PolicyCorpusManifest = Readonly<{
  schemaVersion: "1.0";
  corpusVersion: string;
  corpusDigest: string;
  baselineVersion: string;
  baselineDigest: string;
  candidateVersion: string;
  provenance: Readonly<{
    receiptLedgerRef: string;
    receiptHeadHash: string;
    verifiedReceiptCount: number;
    independentlyVerifiedOutcomeCount: number;
  }>;
  selection: Readonly<{
    independentOutcomesRequired: true;
    selfReportedOutcomeAccepted: false;
    knownConfigurationRevisions: readonly string[];
    knownPolicyRevisions: readonly string[];
  }>;
  redaction: Readonly<{
    allowlistOnly: true;
    pseudonymizationRevision: string;
    omittedFields: readonly string[];
  }>;
  quarantine: Readonly<{
    excludedFromAllSplits: true;
    count: number;
    reasons: Readonly<Record<string, number>>;
  }>;
  split: Readonly<{
    algorithm: "sha256-modulo-v1";
    seedDigest: string;
    holdoutPercent: number;
    digests: Readonly<Record<PolicyCorpusSplit, string>>;
  }>;
  adversarial: Readonly<{ required: true; count: number }>;
}>;

export type PolicyCorpus = Readonly<{
  rows: readonly PolicyCorpusRow[];
  quarantine: readonly PolicyCorpusQuarantine[];
  manifest: PolicyCorpusManifest;
}>;

export type BuildPolicyCorpusInput = Readonly<{
  receipts: readonly IntegrityLinkedAccessReceipt[];
  outcomes: readonly TrustedVerifiedTaskOutcome[];
  receiptLedgerRef: string;
  corpusVersion: string;
  baselineVersion: string;
  baselineDigest: string;
  candidateVersion: string;
  pseudonymKey: string;
  pseudonymizationRevision: string;
  knownConfigurationRevisions: readonly string[];
  knownPolicyRevisions: readonly string[];
  split: Readonly<{
    algorithm: "sha256-modulo-v1";
    seed: string;
    holdoutPercent: number;
  }>;
}>;

const bucket = (value: number | undefined, width: number): number =>
  Math.max(0, Math.floor((value ?? 0) / width) * width);

function splitFor(
  receiptHash: string,
  outcome: VerifiedTaskOutcome,
  split: BuildPolicyCorpusInput["split"],
): PolicyCorpusSplit {
  if (outcome.caseClass === "adversarial") return "adversarial";
  const byte = Number.parseInt(createHash("sha256").update(`${split.seed}\0${receiptHash}`).digest("hex").slice(0, 2), 16);
  return (byte / 256) * 100 < split.holdoutPercent ? "holdout" : "train";
}

function quarantineCounts(entries: readonly PolicyCorpusQuarantine[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildPolicyCorpus(input: BuildPolicyCorpusInput): PolicyCorpus {
  const ledger = verifyAccessReceiptLedger(input.receipts);
  const validCount = ledger.ok ? input.receipts.length : ledger.validPrefixLength;
  const quarantine: PolicyCorpusQuarantine[] = [];
  if (!ledger.ok) {
    for (const receipt of input.receipts.slice(ledger.firstInvalidIndex)) {
      quarantine.push({ receiptHash: receipt.integrity?.recordHash ?? sha256(receipt), reason: "receipt-ledger-invalid" });
    }
  }

  const outcomesByReceipt = new Map<string, OutcomeEvidenceRecord[]>();
  for (const evidence of input.outcomes) {
    const record = trustedOutcomes.get(evidence);
    if (!record?.receiptHash) continue;
    const linked = outcomesByReceipt.get(record.receiptHash) ?? [];
    linked.push(record);
    outcomesByReceipt.set(record.receiptHash, linked);
  }
  let rows: PolicyCorpusRow[] = [];
  for (const receipt of input.receipts.slice(0, validCount)) {
    const receiptHash = receipt.integrity.recordHash;
    const reject = (reason: QuarantineReason): void => { quarantine.push({ receiptHash, reason }); };
    if (!input.knownConfigurationRevisions.includes(receipt.contextAssembly.configurationRevision)) {
      reject("unknown-configuration-revision");
      continue;
    }
    if (!input.knownPolicyRevisions.includes(receipt.policy.revision)) {
      reject("unknown-policy-revision");
      continue;
    }
    const linkedOutcomes = outcomesByReceipt.get(receiptHash) ?? [];
    if (linkedOutcomes.length === 0) {
      reject("independent-outcome-missing");
      continue;
    }
    if (linkedOutcomes.length !== 1) {
      reject("duplicate-independent-outcome");
      continue;
    }
    const evidence = linkedOutcomes[0]!;
    if (evidence.rejection) {
      reject(evidence.rejection);
      continue;
    }
    const verified = evidence.outcome;
    if (!verified) {
      reject("independent-outcome-missing");
      continue;
    }
    if (verified.receiptHash !== receiptHash) {
      reject("outcome-receipt-mismatch");
      continue;
    }
    if (verified.verifier.subject === receipt.actor) {
      reject("verifier-not-independent");
      continue;
    }
    if (!verified.verifier.artifactRef.startsWith("./")
      || !verified.verifier.artifactRevision
      || !hashPattern.test(verified.verifier.artifactHash)) {
      reject("verifier-artifact-invalid");
      continue;
    }
    const pseudonymScope = `${input.corpusVersion}\0${input.pseudonymizationRevision}`;
    const id = pseudonym(input.pseudonymKey, `${pseudonymScope}\0row\0${receiptHash}`);
    rows.push({
      id,
      scenarioPseudonym: pseudonym(input.pseudonymKey, `${pseudonymScope}\0scenario\0${verified.id}`),
      workspacePseudonym: pseudonym(input.pseudonymKey, `${pseudonymScope}\0workspace\0${receipt.workspaceId}`),
      producerPseudonym: pseudonym(input.pseudonymKey, `${pseudonymScope}\0producer\0${receipt.actor}`),
      receipt: {
        ledgerRef: input.receiptLedgerRef,
        recordHash: receiptHash,
        previousRecordHash: receipt.integrity.previousRecordHash,
        configurationRevision: receipt.contextAssembly.configurationRevision,
        policyRevision: receipt.policy.revision,
      },
      outcome: {
        artifactRef: verified.verifier.artifactRef,
        artifactRevision: verified.verifier.artifactRevision,
        artifactHash: verified.verifier.artifactHash,
        recordHash: verified.integrity.recordHash,
        result: verified.result,
      },
      features: {
        action: receipt.action,
        decision: receipt.decision,
        tokenBucket: bucket(receipt.cost.tokens, 64),
        toolCallBucket: bucket(receipt.cost.toolCalls, 2),
        elapsedMsBucket: bucket(receipt.cost.elapsedMs, 10),
        selectedCount: receipt.contextAssembly.selected.length,
        omittedOptionalCount: receipt.contextAssembly.omittedOptional.length,
      },
      expectedSelection: verified.expectedSelection,
      split: splitFor(receiptHash, verified, input.split),
    });
  }
  rows = rows.sort((a, b) => a.id.localeCompare(b.id));
  const splitDigests = Object.fromEntries(
    (["train", "holdout", "adversarial"] as const).map((split) => [
      split,
      sha256(rows.filter((row) => row.split === split).map((row) => row.id)),
    ]),
  ) as Record<PolicyCorpusSplit, string>;
  const corpusDigest = sha256({
    corpusVersion: input.corpusVersion,
    baselineVersion: input.baselineVersion,
    baselineDigest: input.baselineDigest,
    candidateVersion: input.candidateVersion,
    rows,
  });
  const headHash = ledger.ok ? ledger.headHash : validCount === 0
    ? "GENESIS"
    : input.receipts[validCount - 1]!.integrity.recordHash;
  const manifest: PolicyCorpusManifest = {
    schemaVersion: "1.0",
    corpusVersion: input.corpusVersion,
    corpusDigest,
    baselineVersion: input.baselineVersion,
    baselineDigest: input.baselineDigest,
    candidateVersion: input.candidateVersion,
    provenance: {
      receiptLedgerRef: input.receiptLedgerRef,
      receiptHeadHash: headHash,
      verifiedReceiptCount: validCount,
      independentlyVerifiedOutcomeCount: rows.length,
    },
    selection: {
      independentOutcomesRequired: true,
      selfReportedOutcomeAccepted: false,
      knownConfigurationRevisions: [...input.knownConfigurationRevisions].sort(),
      knownPolicyRevisions: [...input.knownPolicyRevisions].sort(),
    },
    redaction: {
      allowlistOnly: true,
      pseudonymizationRevision: input.pseudonymizationRevision,
      omittedFields: ["actor", "workspaceId", "traceRef", "selectedIds", "resourceRef", "outcome", "rawContent"],
    },
    quarantine: {
      excludedFromAllSplits: true,
      count: quarantine.length,
      reasons: quarantineCounts(quarantine),
    },
    split: {
      algorithm: input.split.algorithm,
      seedDigest: sha256(input.split.seed),
      holdoutPercent: input.split.holdoutPercent,
      digests: splitDigests,
    },
    adversarial: { required: true, count: rows.filter((row) => row.split === "adversarial").length },
  };
  return { rows, quarantine, manifest };
}

export const POLICY_EXPERIMENT_SANDBOX_PROFILE: Readonly<SandboxProfile> = Object.freeze({
  mode: "read-only",
  network: "off",
  writableRoots: [],
  readDenyList: [],
  allowedDomains: [],
  required: true,
});

export type CandidateSelection = Readonly<{
  selectedIds: readonly string[];
  roles?: unknown;
  acl?: unknown;
  securityGate?: unknown;
  acceptanceCriteria?: unknown;
  flowState?: unknown;
  policyVersion?: unknown;
  configuration?: unknown;
  candidate?: unknown;
}>;

export type PolicyExperimentCandidate = Readonly<{
  version: string;
  artifactDigest: string;
}>;

export type PolicyExperimentBaselineRequest = Readonly<{
  rowId: string;
  eligibleIds: readonly string[];
  features: PolicyCorpusRow["features"];
}>;

export type PolicyExperimentBaseline = Readonly<{
  version: string;
  artifactDigest: string;
  select: (request: PolicyExperimentBaselineRequest) => CandidateSelection;
}>;

export type PolicyExperimentSandboxRequest = Readonly<{
  candidateVersion: string;
  candidateDigest: string;
  rowId: string;
  baselineAuthorizedIds: readonly string[];
  features: PolicyCorpusRow["features"];
}>;

export type PolicyExperimentSandbox = Readonly<{
  profile: Readonly<SandboxProfile>;
  controlEvidence: PolicyExperimentSandboxEvidence;
  caseTimeoutMs: number;
  run: (request: PolicyExperimentSandboxRequest, signal: AbortSignal) => Promise<Readonly<{
    kind: "completed" | "blocked" | "failed";
    selection?: CandidateSelection;
  }>>;
  terminate: () => Promise<void>;
}>;

export type PolicyPartitionEvaluation = Readonly<{
  status: "pass" | "fail";
  cases: number;
  baselineCorrect: number;
  candidateCorrect: number;
}>;

export type PolicyEvaluationReport = Readonly<{
  schemaVersion: "1.0";
  status: "pass" | "fail";
  baselineVersion: string;
  baselineDigest: string;
  candidateVersion: string;
  candidateDigest: string;
  corpusVersion: string;
  corpusDigest: string;
  sandboxProfileDigest: string;
  allowedControlPassed: boolean;
  deniedEscapePassed: boolean;
  securityNonRegression: boolean;
  train: PolicyPartitionEvaluation;
  holdout: PolicyPartitionEvaluation;
  adversarial: PolicyPartitionEvaluation;
  candidateSelectedIds: readonly string[];
  reasons: readonly string[];
  reportDigest: string;
}>;

function sandboxControlStatus(
  sandbox: PolicyExperimentSandbox,
  candidate: PolicyExperimentCandidate,
): Readonly<{ allowed: boolean; denied: boolean }> {
  const evidence = trustedSandboxEvidence.get(sandbox.controlEvidence);
  const bindingValid = evidence !== undefined
    && stableJson(sandbox.profile) === stableJson(POLICY_EXPERIMENT_SANDBOX_PROFILE)
    && Number.isInteger(sandbox.caseTimeoutMs)
    && sandbox.caseTimeoutMs > 0
    && sandbox.caseTimeoutMs <= 60_000
    && evidence.candidateVersion === candidate.version
    && evidence.candidateDigest === candidate.artifactDigest
    && evidence.profileDigest === sha256(sandbox.profile)
    && evidence.deadlineMs === sandbox.caseTimeoutMs;
  return {
    allowed: Boolean(bindingValid && evidence?.allowedControlPassed),
    denied: Boolean(bindingValid && evidence?.deniedEscapePassed),
  };
}

function validSelection(selection: CandidateSelection, authorized: readonly string[]): boolean {
  const keys = Object.keys(selection);
  if (keys.length !== 1 || keys[0] !== "selectedIds" || !Array.isArray(selection.selectedIds)) return false;
  const allowed = new Set(authorized);
  return new Set(selection.selectedIds).size === selection.selectedIds.length
    && selection.selectedIds.every((id) => allowed.has(id));
}

type SandboxObservation = Awaited<ReturnType<PolicyExperimentSandbox["run"]>>;
type CandidateRunResult = Readonly<{ timedOut: boolean; observation: SandboxObservation }>;

async function runCandidateWithDeadline(
  sandbox: PolicyExperimentSandbox,
  request: PolicyExperimentSandboxRequest,
): Promise<Readonly<{ timedOut: boolean; observation: SandboxObservation }>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deadlineTriggered = false;
  const deadline = new Promise<CandidateRunResult>((resolve) => {
    timeout = setTimeout(() => {
      deadlineTriggered = true;
      controller.abort();
      void sandbox.terminate()
        .catch(() => undefined)
        .then(() => resolve({ timedOut: true, observation: { kind: "failed" } }));
    }, sandbox.caseTimeoutMs);
  });
  const execution = Promise.resolve()
    .then(() => sandbox.run(request, controller.signal))
    .then<CandidateRunResult, CandidateRunResult>(
      (observation) => deadlineTriggered
        ? new Promise<CandidateRunResult>(() => undefined)
        : { timedOut: false, observation },
      () => deadlineTriggered
        ? new Promise<CandidateRunResult>(() => undefined)
        : { timedOut: false, observation: { kind: "failed" } },
    );
  try {
    return await Promise.race([execution, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function evaluatePolicyExperiment(input: Readonly<{
  corpus: PolicyCorpus;
  baseline: PolicyExperimentBaseline;
  candidate: PolicyExperimentCandidate;
  sandbox: PolicyExperimentSandbox;
}>): Promise<PolicyEvaluationReport> {
  const reasons: string[] = [];
  const outcomes = new Map<string, { baseline: boolean; candidate: boolean }>();
  const selected = new Set<string>();
  const controls = sandboxControlStatus(input.sandbox, input.candidate);
  const baselineBound = input.baseline.version === input.corpus.manifest.baselineVersion
    && input.baseline.artifactDigest === input.corpus.manifest.baselineDigest
    && isImmutableVersion(input.baseline.version)
    && hashPattern.test(input.baseline.artifactDigest);
  let securityNonRegression = controls.allowed && controls.denied && baselineBound;
  if (!baselineBound) reasons.push("baseline-pin-mismatch");
  if (!controls.allowed || !controls.denied) reasons.push("sandbox-controls-failed");

  if (securityNonRegression) {
    for (const row of input.corpus.rows) {
      const baselineRequest: PolicyExperimentBaselineRequest = {
        rowId: row.id,
        eligibleIds: [row.id],
        features: row.features,
      };
      let firstBaseline: CandidateSelection;
      let secondBaseline: CandidateSelection;
      try {
        firstBaseline = input.baseline.select(baselineRequest);
        secondBaseline = input.baseline.select(baselineRequest);
      } catch {
        securityNonRegression = false;
        reasons.push(`baseline-failed:${row.id}`);
        outcomes.set(row.id, { baseline: false, candidate: false });
        continue;
      }
      if (stableJson(firstBaseline) !== stableJson(secondBaseline)) {
        securityNonRegression = false;
        reasons.push(`baseline-nondeterministic:${row.id}`);
        outcomes.set(row.id, { baseline: false, candidate: false });
        continue;
      }
      if (!validSelection(firstBaseline, baselineRequest.eligibleIds)) {
        securityNonRegression = false;
        reasons.push(`invalid-baseline-output:${row.id}`);
        outcomes.set(row.id, { baseline: false, candidate: false });
        continue;
      }
      const baselineAuthorizedIds = [...firstBaseline.selectedIds];
      const baselineCorrect = baselineAuthorizedIds.includes(row.id) === (row.expectedSelection === "select");
      const request: PolicyExperimentSandboxRequest = {
        candidateVersion: input.candidate.version,
        candidateDigest: input.candidate.artifactDigest,
        rowId: row.id,
        baselineAuthorizedIds,
        features: row.features,
      };
      const firstRun = await runCandidateWithDeadline(input.sandbox, request);
      if (firstRun.timedOut) {
        securityNonRegression = false;
        reasons.push(`candidate-timeout:${row.id}`);
        outcomes.set(row.id, { baseline: baselineCorrect, candidate: false });
        break;
      }
      const secondRun = await runCandidateWithDeadline(input.sandbox, request);
      if (secondRun.timedOut) {
        securityNonRegression = false;
        reasons.push(`candidate-timeout:${row.id}`);
        outcomes.set(row.id, { baseline: baselineCorrect, candidate: false });
        break;
      }
      const observation = firstRun.observation;
      if (stableJson(observation) !== stableJson(secondRun.observation)) {
        securityNonRegression = false;
        reasons.push(`candidate-nondeterministic:${row.id}`);
        outcomes.set(row.id, { baseline: baselineCorrect, candidate: false });
        continue;
      }
      const selection = observation.selection;
      if (observation.kind !== "completed" || !selection || !validSelection(selection, baselineAuthorizedIds)) {
        securityNonRegression = false;
        reasons.push(`invalid-candidate-output:${row.id}`);
        outcomes.set(row.id, { baseline: baselineCorrect, candidate: false });
        continue;
      }
      for (const id of selection.selectedIds) selected.add(id);
      const candidateSelected = selection.selectedIds.includes(row.id);
      outcomes.set(row.id, {
        baseline: baselineCorrect,
        candidate: candidateSelected === (row.expectedSelection === "select"),
      });
    }
  }

  const partition = (split: PolicyCorpusSplit): PolicyPartitionEvaluation => {
    const ids = input.corpus.rows.filter((row) => row.split === split).map((row) => row.id);
    const values = ids.map((id) => outcomes.get(id));
    const baselineCorrect = values.filter((entry) => entry?.baseline).length;
    const candidateCorrect = values.filter((entry) => entry?.candidate).length;
    const required = split === "holdout" || split === "adversarial";
    return {
      status: (!required || ids.length > 0) && candidateCorrect >= baselineCorrect && candidateCorrect === ids.length
        ? "pass"
        : "fail",
      cases: ids.length,
      baselineCorrect,
      candidateCorrect,
    };
  };
  const train = partition("train");
  const holdout = partition("holdout");
  const adversarial = partition("adversarial");
  if (holdout.status !== "pass") reasons.push("holdout-gate-failed");
  if (adversarial.status !== "pass") reasons.push("adversarial-gate-failed");
  const status: PolicyEvaluationReport["status"] = securityNonRegression && holdout.status === "pass" && adversarial.status === "pass" ? "pass" : "fail";
  const reportBody = {
    schemaVersion: "1.0" as const,
    status,
    baselineVersion: input.baseline.version,
    baselineDigest: input.baseline.artifactDigest,
    candidateVersion: input.candidate.version,
    candidateDigest: input.candidate.artifactDigest,
    corpusVersion: input.corpus.manifest.corpusVersion,
    corpusDigest: input.corpus.manifest.corpusDigest,
    sandboxProfileDigest: sha256(input.sandbox.profile),
    allowedControlPassed: controls.allowed,
    deniedEscapePassed: controls.denied,
    securityNonRegression,
    train,
    holdout,
    adversarial,
    candidateSelectedIds: [...selected].sort(),
    reasons: [...new Set(reasons)].sort(),
  };
  return { ...reportBody, reportDigest: sha256(reportBody) };
}

export function formatPolicyEvaluationReport(report: PolicyEvaluationReport): string {
  return `${stableJson(report)}\n`;
}

export type PolicyExperimentConfig = Readonly<{
  enabled: boolean;
  killSwitch: boolean;
  candidateVersion?: string;
  candidateDigest?: string;
  corpusVersion?: string;
  corpusDigest?: string;
  baselineVersion?: string;
  baselineDigest?: string;
  evaluationDigest?: string;
  rollbackBaselineVersion?: string;
  rollbackReason?: string;
}>;

export function defaultPolicyExperimentConfig(): PolicyExperimentConfig {
  return Object.freeze({ enabled: false, killSwitch: true });
}

export type BaselineSelection = Readonly<{
  selectedIds: readonly string[];
  source: "deterministic-baseline";
  version: string;
  artifactDigest: string;
}>;

export type ResolvedPolicySelection = BaselineSelection | Readonly<{
  selectedIds: readonly string[];
  source: "candidate";
  candidateVersion: string;
}>;

function hasValidEvaluationDigest(evaluation: PolicyEvaluationReport): boolean {
  const { reportDigest, ...body } = evaluation;
  return hashPattern.test(reportDigest) && sha256(body) === reportDigest;
}

export function resolvePolicyExperiment(input: Readonly<{
  config: PolicyExperimentConfig;
  evaluation: PolicyEvaluationReport;
  candidate: PolicyExperimentCandidate;
  corpus: PolicyCorpus;
  baseline: BaselineSelection;
}>): ResolvedPolicySelection {
  const { config, evaluation, candidate, corpus } = input;
  const baselineIds = new Set(input.baseline.selectedIds);
  const candidateIsRuntimeSubset = new Set(evaluation.candidateSelectedIds).size === evaluation.candidateSelectedIds.length
    && evaluation.candidateSelectedIds.every((id) => baselineIds.has(id));
  const eligible = config.enabled === true
    && config.killSwitch === false
    && isImmutableVersion(candidate.version)
    && hashPattern.test(candidate.artifactDigest)
    && isImmutableVersion(corpus.manifest.corpusVersion)
    && hashPattern.test(corpus.manifest.corpusDigest)
    && isImmutableVersion(evaluation.baselineVersion)
    && hasValidEvaluationDigest(evaluation)
    && evaluation.status === "pass"
    && evaluation.securityNonRegression
    && evaluation.holdout.status === "pass"
    && evaluation.adversarial.status === "pass"
    && config.candidateVersion === candidate.version
    && config.candidateDigest === candidate.artifactDigest
    && config.corpusVersion === corpus.manifest.corpusVersion
    && config.corpusDigest === corpus.manifest.corpusDigest
    && config.baselineVersion === evaluation.baselineVersion
    && config.baselineDigest === evaluation.baselineDigest
    && config.rollbackBaselineVersion === evaluation.baselineVersion
    && config.evaluationDigest === evaluation.reportDigest
    && evaluation.candidateVersion === candidate.version
    && evaluation.candidateDigest === candidate.artifactDigest
    && evaluation.corpusVersion === corpus.manifest.corpusVersion
    && evaluation.corpusDigest === corpus.manifest.corpusDigest
    && evaluation.baselineVersion === corpus.manifest.baselineVersion
    && evaluation.baselineDigest === corpus.manifest.baselineDigest
    && input.baseline.version === evaluation.baselineVersion
    && input.baseline.artifactDigest === evaluation.baselineDigest
    && candidateIsRuntimeSubset;
  return eligible
    ? { selectedIds: evaluation.candidateSelectedIds, source: "candidate", candidateVersion: candidate.version }
    : input.baseline;
}

export function rollbackPolicyExperiment(
  config: PolicyExperimentConfig,
  reason: string,
): PolicyExperimentConfig {
  return Object.freeze({ ...config, enabled: false, killSwitch: true, rollbackReason: reason });
}
