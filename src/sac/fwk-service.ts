import { createHash, randomUUID, type Hash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assembleAndRecordContext, recordNoContentContext, type ContextAssembly, type ContextCandidate, type ContextOverflow } from "../ctx/assembly";
import {
  evaluateStrictSacGuard,
  resolveWorkspaceReference,
  type SacAuthorizationServer,
  type StrictSacGuard,
  type TrustedActorContext,
  validateSacContract,
} from "./index";
import { localWorkspaceAuthorizationServer, WorkspaceService, WorkspaceServiceError } from "./workspace-service";
import { deriveFlowWork, migrateFlow } from "../flow/store";
import type { FlowState } from "../flow/types";
import { withFileLock } from "../lib/fs";
import {
  resolvePolicyExperiment,
  verifyPolicyCorpus,
  type PolicyCorpus,
  type PolicyEvaluationReport,
  type PolicyExperimentCandidate,
  type BaselineSelection,
  type PolicyExperimentConfig,
} from "./policy-experiment";
import {
  sealAccessReceipt,
  verifyAccessReceiptRecord,
  verifyAccessReceiptLedger,
  type AccessReceiptLedgerVerification,
  type IntegrityLinkedAccessReceipt,
} from "./receipt-integrity";

export type FwkEvidence = Readonly<{ id: string; uri: string; revision: string; observedAt: string; expiresAt: string; trust: "primary" | "accepted" | "reviewed"; visible: boolean; statement: string; status?: "fresh" | "stale" | "expired" | "denied" }>;
export type FwkKnowHow = Readonly<{ id: string; kind: "wiki" | "memory" | "skill"; uri: string; revision: string; trust: "accepted" | "reviewed"; status: "fresh" | "stale" | "withdrawn" | "denied"; applicability?: string; accepted: boolean; visible: boolean }>;
export type FwkWork = Readonly<{ flowRef?: { uri: string; snapshot: string; revision: string }; completed?: string[]; next?: string[]; blocked?: string[]; evidence?: FwkEvidence[] }>;
export type FwkSource = Readonly<{ facts: readonly FwkEvidence[]; work?: FwkWork; knowHow: readonly FwkKnowHow[] }>;
export type AccessReceipt = IntegrityLinkedAccessReceipt;
export type FwkResult = Readonly<{ partial: boolean; omittedOptional: string[]; manifest: { facts: unknown[]; work: unknown; knowHow: unknown[]; freshness: "fresh" | "stale" | "partial" | "denied" }; receipt: AccessReceipt }>;
export type FwkReadResult = FwkResult | ContextOverflow;

const metadataOnly = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return true;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["prompt", "transcript", "hiddenReasoning", "secret", "secrets", "rawContent"].includes(key)) return false;
    if (!metadataOnly(child)) return false;
  }
  return true;
};
const nowIso = (now: () => Date) => now().toISOString();
const reportHashPattern = /^[a-f0-9]{64}$/;
const immutableVersionPattern = /(?:^|[-_.:])(?:latest|next|head|main|develop)(?:$|[-_.:])/i;
const workspacePathPattern = /^\.\/(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const policyExperimentConfigPath = [".metaproject", "context-operations", "policy-experiment", "config.json"] as const;
const stableValue = (value: unknown): unknown => {
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
};
const stableJson = (value: unknown): string => JSON.stringify(stableValue(value));
const sha256 = (value: unknown): string => createHash("sha256").update(stableJson(value), "utf8").digest("hex");
const isImmutableVersion = (value: unknown): value is string =>
  typeof value === "string"
  && value.length >= 3
  && value.length <= 256
  && /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value)
  && /\d/.test(value)
  && !immutableVersionPattern.test(value);

/**
 * Checkpoint schema v1.1. `contentDigest` is sha256 over the ledger's first
 * `ledgerBytes` bytes exactly as they stood when a full audit accepted them, so
 * the checkpoint's confidence is derived from the ledger's CONTENT.
 *
 * v1.0 pinned the checkpoint to `stat` metadata instead — `device`, `inode`,
 * `modifiedNs`, `changedNs` — and then re-verified only the tail record. That is
 * not a tamper signal: an in-place same-size rewrite of a historical record
 * leaves every one of those fields identical (measured here: 189 of 200
 * attempts left both `mtimeNs` and `ctimeNs` untouched), the tail record stays
 * internally consistent, and the edit was accepted. The chain in
 * `receipt-integrity` does not rescue the shortcut either: `recordHash`
 * commits to `previousRecordHash`, but a mid-ledger edit leaves every STORED
 * hash in place, so only recomputing a hash from the record's own bytes can
 * expose it. Those stat fields are therefore gone from the checkpoint entirely,
 * not merely unused, so no future fast path can reach for them again.
 */
type CheckpointBody = Readonly<{ schemaVersion: "1.1"; ledgerBytes: number; recordCount: number; headHash: string; tailOffset: number; contentDigest: string }>;
type Checkpoint = CheckpointBody & Readonly<{ integrity: Readonly<{ checkpointHash: string }> }>;
/**
 * `digest` is a sha256 already primed with exactly the `ledgerBytes` verified
 * bytes this state was derived from. The append path folds the appended line
 * into it, so sealing the next checkpoint costs nothing and the ledger is read
 * once per append rather than twice.
 */
type LedgerState = Readonly<{ ledgerBytes: number; recordCount: number; headHash: string; tailOffset: number; digest: Hash }>;
type LedgerVerifier = (receipts: readonly IntegrityLinkedAccessReceipt[]) => AccessReceiptLedgerVerification | Promise<AccessReceiptLedgerVerification>;
const receiptHashPattern = /^[a-f0-9]{64}$/;
const ledgerDigestChunkBytes = 64 * 1024;
const isMissing = (error: unknown): boolean => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
const checkpointHash = (body: CheckpointBody): string => createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");

async function ledgerByteLength(ledger: string): Promise<number> {
  const value = await stat(ledger, { bigint: true });
  if (value.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid access receipt ledger: ledger-too-large");
  return Number(value.size);
}
/**
 * sha256 over the ledger's first `byteLength` bytes, read in bounded chunks so a
 * large ledger is never materialised. Returns `undefined` when the file ends
 * early: a short read is a truncated ledger, and the caller refuses rather than
 * hashing whatever prefix happened to survive.
 */
async function digestLedgerPrefix(handle: FileHandle, byteLength: number): Promise<Hash | undefined> {
  const digest = createHash("sha256");
  if (byteLength === 0) return digest;
  const buffer = Buffer.alloc(Math.min(ledgerDigestChunkBytes, byteLength));
  let position = 0;
  // Bounded by construction, not only by the short-read check below.
  //
  // A mutation pass over this release deleted BOTH the `bytesRead === 0` check
  // here and the size comparison in `fastCheckpointState`, and the suite did not
  // fail — it HUNG. With neither, `position` never advances on a short read and
  // `while (position < byteLength)` spins forever. A test suite that hangs is
  // worse than one that fails: CI reports a timeout, which reads as
  // infrastructure trouble rather than a defect.
  //
  // The chunk count is knowable up front, so the loop is written against it. The
  // short-read check stays and is still correct — but removing it can now only
  // produce a WRONG DIGEST, which a test can catch, instead of a hang, which no
  // test can survive to report.
  const maxChunks = Math.ceil(byteLength / buffer.length);
  for (let chunk = 0; chunk < maxChunks && position < byteLength; chunk += 1) {
    const result = await handle.read(buffer, 0, Math.min(buffer.length, byteLength - position), position);
    if (result.bytesRead === 0) return undefined;
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  // Reached only if the file ended early without a zero-length read ever being
  // observed. Refuse rather than return a digest over a prefix nobody audited.
  if (position < byteLength) return undefined;
  return digest;
}
function parseCheckpoint(value: unknown): Checkpoint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const document = value as Record<string, unknown>;
  const expected = ["schemaVersion", "ledgerBytes", "recordCount", "headHash", "tailOffset", "contentDigest", "integrity"];
  // A v1.0 checkpoint fails here on both shape and version. It carries no
  // content commitment, so it cannot support the new guarantee and is never
  // trusted under it: the caller falls through to a full re-audit.
  if (Object.keys(document).length !== expected.length || !expected.every((key) => Object.hasOwn(document, key)) || document.schemaVersion !== "1.1") return undefined;
  if (![document.ledgerBytes, document.recordCount, document.tailOffset].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)) return undefined;
  if (typeof document.contentDigest !== "string" || !receiptHashPattern.test(document.contentDigest)) return undefined;
  if (typeof document.headHash !== "string" || (document.headHash !== "GENESIS" && !receiptHashPattern.test(document.headHash))) return undefined;
  if (typeof document.integrity !== "object" || document.integrity === null || Array.isArray(document.integrity)) return undefined;
  const integrity = document.integrity as Record<string, unknown>;
  if (Object.keys(integrity).length !== 1 || typeof integrity.checkpointHash !== "string" || !receiptHashPattern.test(integrity.checkpointHash)) return undefined;
  const body: CheckpointBody = { schemaVersion: "1.1", ledgerBytes: document.ledgerBytes as number, recordCount: document.recordCount as number, headHash: document.headHash, tailOffset: document.tailOffset as number, contentDigest: document.contentDigest };
  return checkpointHash(body) === integrity.checkpointHash ? { ...body, integrity: { checkpointHash: integrity.checkpointHash } } : undefined;
}
async function readCheckpoint(checkpointPath: string): Promise<{ present: boolean; checkpoint?: Checkpoint }> {
  try { const raw = await readFile(checkpointPath, "utf8"); try { const checkpoint = parseCheckpoint(JSON.parse(raw)); return checkpoint ? { present: true, checkpoint } : { present: true }; } catch { return { present: true }; } }
  catch (error) { if (isMissing(error)) return { present: false }; throw error; }
}
async function writeCheckpoint(checkpointPath: string, body: CheckpointBody): Promise<void> {
  const temporary = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  const checkpoint: Checkpoint = { ...body, integrity: { checkpointHash: checkpointHash(body) } };
  try { await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, checkpointPath); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
/**
 * Content-derived fast path. The checkpoint is believed only when sha256 over
 * the ledger's on-disk bytes still equals the digest recorded when those exact
 * bytes were fully audited. No `stat` field takes part in the decision, so a
 * same-size in-place rewrite that leaves `mtimeNs` and `ctimeNs` untouched is
 * still caught — and caught wherever it lands, because the digest covers the
 * whole audited prefix rather than the tail record alone.
 *
 * What the shortcut assumes, and why the assumption holds: identical bytes
 * yield identical records, because `auditLedger` derives its records from the
 * ledger by splitting on "\n" and `JSON.parse`-ing each line, both
 * deterministic. Byte equality with an audited snapshot is therefore exactly as
 * strong as re-running that audit, at the cost of one sequential read and one
 * sha256 instead of N JSON parses and N schema validations.
 *
 * Divergence from the committed bytes is a refusal, not a retry: a short file or
 * a digest mismatch throws. Falling back to a full audit there would let a clean
 * truncation to a valid prefix pass as a healthy — merely shorter — ledger.
 * Checkpoint-internal inconsistencies that say nothing about the ledger's
 * content return `undefined` instead, which re-audits.
 */
async function fastCheckpointState(ledger: string, checkpoint: Checkpoint, ledgerBytes: number): Promise<LedgerState | undefined> {
  if (ledgerBytes < checkpoint.ledgerBytes) throw new Error("invalid access receipt ledger: truncated-ledger");
  const handle = await open(ledger, "r");
  try {
    const digest = await digestLedgerPrefix(handle, checkpoint.ledgerBytes);
    if (!digest) throw new Error("invalid access receipt ledger: truncated-ledger");
    if (digest.copy().digest("hex") !== checkpoint.contentDigest) throw new Error("invalid access receipt ledger: checkpoint-content-mismatch");
    // Committed bytes intact but the ledger grew past them: an append that
    // landed without its checkpoint refresh. The extra records were never
    // audited, so re-audit rather than adopt them.
    if (ledgerBytes !== checkpoint.ledgerBytes) return undefined;
    if (checkpoint.recordCount === 0) return checkpoint.ledgerBytes === 0 && checkpoint.headHash === "GENESIS" && checkpoint.tailOffset === 0 ? { ledgerBytes, recordCount: 0, headHash: "GENESIS", tailOffset: 0, digest } : undefined;
    const tailBytes = checkpoint.ledgerBytes - checkpoint.tailOffset;
    if (checkpoint.tailOffset < 0 || tailBytes <= 1 || tailBytes > 1024 * 1024) return undefined;
    const buffer = Buffer.alloc(tailBytes); let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, checkpoint.tailOffset + offset); if (result.bytesRead === 0) return undefined; offset += result.bytesRead; }
    if (buffer.at(-1) !== 0x0a || buffer.subarray(0, -1).includes(0x0a)) return undefined;
    let receipt: IntegrityLinkedAccessReceipt;
    try { receipt = JSON.parse(buffer.subarray(0, -1).toString("utf8")) as IntegrityLinkedAccessReceipt; } catch { return undefined; }
    // The digest already vouches for these bytes; this only holds the
    // checkpoint's own `headHash`/`tailOffset` claims against them.
    if (!verifyAccessReceiptRecord(receipt) || receipt.integrity.recordHash !== checkpoint.headHash) return undefined;
    return { ledgerBytes, recordCount: checkpoint.recordCount, headHash: checkpoint.headHash, tailOffset: checkpoint.tailOffset, digest };
  } finally { await handle.close(); }
}
async function auditLedger(ledger: string, checkpointPath: string, verifier: LedgerVerifier): Promise<LedgerState> {
  const bytes = await readFile(ledger);
  const raw = bytes.toString("utf8");
  if (raw.length > 0 && !raw.endsWith("\n")) throw new Error("invalid access receipt ledger: unterminated-record");
  const lines = raw.length === 0 ? [] : raw.slice(0, -1).split("\n"); let receipts: IntegrityLinkedAccessReceipt[];
  try { receipts = lines.map((line) => JSON.parse(line) as IntegrityLinkedAccessReceipt); } catch { throw new Error("invalid access receipt ledger: malformed-json"); }
  const verification = await verifier(receipts);
  if (!verification.ok) throw new Error(`invalid access receipt ledger: ${verification.reason} at record ${verification.firstInvalidIndex}`);
  // The digest commits to the same buffer the audit just accepted, so the
  // checkpoint can never vouch for bytes nobody verified.
  const digest = createHash("sha256").update(bytes);
  const tailOffset = receipts.length === 0 ? 0 : bytes.lastIndexOf(0x0a, bytes.length - 2) + 1;
  const state: LedgerState = { ledgerBytes: bytes.length, recordCount: receipts.length, headHash: verification.headHash, tailOffset, digest };
  await writeCheckpoint(checkpointPath, { schemaVersion: "1.1", ledgerBytes: state.ledgerBytes, recordCount: state.recordCount, headHash: state.headHash, tailOffset, contentDigest: digest.copy().digest("hex") });
  return state;
}
async function resolveLedgerState(ledger: string, checkpointPath: string, verifier: LedgerVerifier): Promise<LedgerState> {
  const document = await readCheckpoint(checkpointPath); let ledgerBytes: number;
  try { ledgerBytes = await ledgerByteLength(ledger); } catch (error) {
    if (!isMissing(error)) throw error;
    if (document.present) throw new Error("invalid access receipt ledger: orphaned-checkpoint");
    return { ledgerBytes: 0, recordCount: 0, headHash: "GENESIS", tailOffset: 0, digest: createHash("sha256") };
  }
  if (document.checkpoint) { const fast = await fastCheckpointState(ledger, document.checkpoint, ledgerBytes); if (fast) return fast; }
  return auditLedger(ledger, checkpointPath, verifier);
}

type PolicyRuntimeSelection = Readonly<{ policyRef: string; policyRevision: string }>;
type UnknownRecord = Record<string, unknown>;

type RuntimePolicyArtifactConfig = Readonly<{
  enabled: boolean;
  killSwitch: boolean;
  candidateArtifactRef?: string;
  candidateArtifactDigest?: string;
  candidateVersion?: string;
  baselineArtifactRef?: string;
  baselineArtifactDigest?: string;
  baselineVersion?: string;
  corpusVersion?: string;
  corpusDigest?: string;
  corpusRef?: string;
  evaluationDigest?: string;
  evaluationReportRef?: string;
  rollbackBaselineVersion?: string;
  rollbackReason?: string;
  [key: string]: unknown;
}>;

const policyRefPattern = /^\.\/.+/;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isBaselineArtifact = (artifact: UnknownRecord): artifact is { schemaVersion: "1.0"; kind: "deterministic-baseline"; version: string; selection: "eligible-ids-in-input-order" } =>
  artifact.schemaVersion === "1.0"
  && artifact.kind === "deterministic-baseline"
  && isImmutableVersion(artifact.version)
  && artifact.selection === "eligible-ids-in-input-order";
const isCandidateArtifact = (artifact: UnknownRecord): artifact is { schemaVersion: "1.0"; kind: "offline-selection-advisor"; version: string } =>
  artifact.schemaVersion === "1.0"
  && artifact.kind === "offline-selection-advisor"
  && isImmutableVersion(artifact.version)
  && asString(artifact.output)
  && typeof artifact.mutations === "boolean";

const isEvaluationReport = (report: UnknownRecord): report is PolicyEvaluationReport =>
  report.schemaVersion === "1.0"
  && asString(report.status)
  && asString(report.baselineVersion)
  && asString(report.baselineDigest) && reportHashPattern.test(report.baselineDigest)
  && asString(report.candidateVersion)
  && asString(report.candidateDigest) && reportHashPattern.test(report.candidateDigest)
  && asString(report.corpusVersion)
  && asString(report.corpusDigest) && reportHashPattern.test(report.corpusDigest)
  && asString(report.reportDigest) && reportHashPattern.test(report.reportDigest)
  && asString(report.sandboxProfileDigest)
  && reportHashPattern.test(report.sandboxProfileDigest)
  && isRecord(report.train) && typeof report.train.status === "string" && typeof report.train.cases === "number"
  && isRecord(report.holdout) && typeof report.holdout.status === "string" && typeof report.holdout.cases === "number"
  && isRecord(report.adversarial) && typeof report.adversarial.status === "string" && typeof report.adversarial.cases === "number"
  && Array.isArray(report.candidateSelectedIds)
  && Array.isArray(report.reasons);
const isConfigRecord = (value: UnknownRecord): value is RuntimePolicyArtifactConfig =>
  typeof value.enabled === "boolean" && typeof value.killSwitch === "boolean";

async function readPinnedJson<T extends UnknownRecord>(input: { workspaceRoot: string; uri: string; digest: string; }): Promise<{ artifact: T; digest: string }> {
  const ref = await resolveWorkspaceReference({ workspaceRoot: input.workspaceRoot, kind: "artifact", uri: input.uri });
  const raw = await readFile(ref, "utf8");
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== input.digest) throw new Error("policy experiment pinned artifact digest mismatch");
  return { artifact: JSON.parse(raw) as T, digest };
}
async function readWorkspaceJson<T extends UnknownRecord>(input: { workspaceRoot: string; uri: string; }): Promise<{ artifact: T; raw: string; }> {
  const ref = await resolveWorkspaceReference({ workspaceRoot: input.workspaceRoot, kind: "artifact", uri: input.uri });
  const raw = await readFile(ref, "utf8");
  return { artifact: JSON.parse(raw) as T, raw };
}

function hasReportIntegrity(report: PolicyEvaluationReport): boolean {
  const { reportDigest, ...body } = report;
  return reportHashPattern.test(reportDigest) && sha256(body) === reportDigest;
}

export async function resolvePolicySelection(workspaceRoot: string, canonicalFallback: PolicyRuntimeSelection): Promise<PolicyRuntimeSelection> {
  const configPath = path.join(workspaceRoot, ...policyExperimentConfigPath);
  let configJson: RuntimePolicyArtifactConfig;
  try {
    const raw = await readFile(configPath, "utf8").catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (raw === undefined) return canonicalFallback;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isConfigRecord(parsed)) return canonicalFallback;
    configJson = parsed;
  } catch {
    return canonicalFallback;
  }

  if (configJson.enabled !== true || configJson.killSwitch !== false) return canonicalFallback;
  const required = ["candidateArtifactRef", "candidateArtifactDigest", "candidateVersion", "baselineArtifactRef", "baselineArtifactDigest", "baselineVersion", "corpusRef", "corpusDigest", "corpusVersion", "evaluationReportRef", "evaluationDigest"] as const;
  if (!required.every((name) => typeof configJson[name] === "string")) return canonicalFallback;

  const candidateRef = configJson.candidateArtifactRef;
  const candidateDigest = configJson.candidateArtifactDigest;
  const baselineRef = configJson.baselineArtifactRef;
  const baselineDigest = configJson.baselineArtifactDigest;
  const corpusRef = configJson.corpusRef;
  const corpusDigest = configJson.corpusDigest;
  const evaluationRef = configJson.evaluationReportRef;
  const evaluationDigest = configJson.evaluationDigest;
  if (!asString(candidateRef) || !asString(candidateDigest) || !asString(baselineRef) || !asString(baselineDigest) || !asString(corpusRef) || !asString(corpusDigest) || !asString(evaluationRef) || !asString(evaluationDigest)) return canonicalFallback;
  if (!workspacePathPattern.test(candidateRef) || !workspacePathPattern.test(baselineRef) || !workspacePathPattern.test(corpusRef) || !workspacePathPattern.test(evaluationRef)) return canonicalFallback;
  if (!validHash(candidateDigest) || !validHash(baselineDigest) || !validHash(corpusDigest) || !validHash(evaluationDigest)) return canonicalFallback;
  if (!isImmutableVersion(configJson.candidateVersion) || !isImmutableVersion(configJson.baselineVersion) || !isImmutableVersion(configJson.corpusVersion)) return canonicalFallback;
  if (!policyRefPattern.test(candidateRef) || !policyRefPattern.test(baselineRef)) return canonicalFallback;
  const baselineVersionPin = configJson.baselineVersion;

  try {
    const baselineArtifact = await readPinnedJson<UnknownRecord>({ workspaceRoot, uri: baselineRef, digest: baselineDigest });
    const candidateArtifact = await readPinnedJson<UnknownRecord>({ workspaceRoot, uri: candidateRef, digest: candidateDigest });
    const corpusPayload = await readWorkspaceJson<PolicyCorpus>({ workspaceRoot, uri: corpusRef });
    const evaluationPayload = await readWorkspaceJson<PolicyEvaluationReport>({ workspaceRoot, uri: evaluationRef });
    if (!isBaselineArtifact(baselineArtifact.artifact) || !isCandidateArtifact(candidateArtifact.artifact)) return canonicalFallback;
    if (!isCompleteCorpus(corpusPayload.artifact)) return canonicalFallback;
    if (corpusPayload.artifact.manifest.corpusVersion !== configJson.corpusVersion || corpusPayload.artifact.manifest.corpusDigest !== corpusDigest) return canonicalFallback;
    if (!isEvaluationReport(evaluationPayload.artifact) || !hasReportIntegrity(evaluationPayload.artifact)) return canonicalFallback;
    if (evaluationPayload.artifact.reportDigest !== evaluationDigest) return canonicalFallback;
    const config = {
      ...configJson,
      candidateArtifactDigest: candidateArtifact.digest,
      candidateDigest: candidateArtifact.digest,
      baselineArtifactDigest: baselineArtifact.digest,
      baselineDigest: baselineArtifact.digest,
      corpusDigest: corpusDigest,
      evaluationDigest: evaluationDigest,
      candidateVersion: configJson.candidateVersion,
      baselineVersion: configJson.baselineVersion,
      corpusVersion: configJson.corpusVersion,
      rollbackBaselineVersion: configJson.rollbackBaselineVersion ?? configJson.baselineVersion,
    } as PolicyExperimentConfig;
    const baseline: BaselineSelection = {
      selectedIds: evaluationPayload.artifact.candidateSelectedIds,
      source: "deterministic-baseline",
      version: baselineArtifact.artifact.version,
      artifactDigest: baselineArtifact.digest,
    };
    const candidate: PolicyExperimentCandidate = { version: candidateArtifact.artifact.version, artifactDigest: candidateDigest };
    const outcome = resolvePolicyExperiment({ config, evaluation: evaluationPayload.artifact, candidate, corpus: corpusPayload.artifact, baseline });
    return outcome.source === "candidate"
      ? { policyRef: candidateRef, policyRevision: outcome.candidateVersion }
      : { policyRef: baselineRef, policyRevision: baselineVersionPin };
  } catch {
    return canonicalFallback;
  }
}

export async function resolvePolicySelectionSafely(workspaceRoot: string, canonicalFallback: PolicyRuntimeSelection): Promise<PolicyRuntimeSelection> {
  try {
    return await resolvePolicySelection(workspaceRoot, canonicalFallback);
  } catch {
    return canonicalFallback;
  }
}

export type PolicyReadinessStep = Readonly<{ step: string; status: "pass" | "fail"; detail?: string }>;
export type PolicyReadinessReport = Readonly<{
  configPresent: boolean;
  enabled: boolean;
  killSwitch: boolean;
  integrityReady: boolean;
  candidateWouldActivate: boolean;
  steps: readonly PolicyReadinessStep[];
}>;

/**
 * Phase 6b operator readiness check for the opt-in policy guard. It mirrors the
 * gates in `resolvePolicySelection` but records each gate's pass/fail and
 * validates the pinned artifacts even when the experiment is disabled, so an
 * owner can prove real-data readiness BEFORE flipping `enabled: true`. It is
 * read-only: it never selects the candidate and never mutates anything. The
 * activation gate is evaluated as if the flags were on, so it reports whether
 * the evidence (security non-regression, holdout, adversarial, pins, subset)
 * would pass independently of the operator's enable/kill-switch flags.
 */
export async function diagnosePolicyReadiness(workspaceRoot: string): Promise<PolicyReadinessReport> {
  const steps: PolicyReadinessStep[] = [];
  const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const pass = (step: string, detail?: string): void => { steps.push(detail === undefined ? { step, status: "pass" } : { step, status: "pass", detail }); };
  const fail = (step: string, detail: string): void => { steps.push({ step, status: "fail", detail }); };
  const finalize = (configPresent: boolean, enabled: boolean, killSwitch: boolean): PolicyReadinessReport => {
    const integrityReady = steps.every((entry) => entry.step === "activation-flags" || entry.status === "pass");
    return Object.freeze({ configPresent, enabled, killSwitch, integrityReady, candidateWouldActivate: integrityReady && enabled && !killSwitch, steps: Object.freeze([...steps]) });
  };

  const configPath = path.join(workspaceRoot, ...policyExperimentConfigPath);
  let configJson: RuntimePolicyArtifactConfig;
  try {
    const raw = await readFile(configPath, "utf8").catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (raw === undefined) { fail("config", "no policy-experiment config at .metaproject/context-operations/policy-experiment/config.json"); return finalize(false, false, true); }
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isConfigRecord(parsed)) { fail("config", "config is not a valid policy-experiment record (needs boolean enabled + killSwitch)"); return finalize(true, false, true); }
    configJson = parsed;
  } catch (error) {
    fail("config", `config could not be read or parsed: ${msg(error)}`);
    return finalize(true, false, true);
  }
  pass("config");
  const enabled = configJson.enabled === true;
  const killSwitch = configJson.killSwitch !== false;
  if (enabled && !killSwitch) pass("activation-flags", "enabled and kill-switch released");
  else fail("activation-flags", `candidate stays off by config: enabled=${String(configJson.enabled)}, killSwitch=${String(configJson.killSwitch)}`);

  const requiredPins = ["candidateArtifactRef", "candidateArtifactDigest", "candidateVersion", "baselineArtifactRef", "baselineArtifactDigest", "baselineVersion", "corpusRef", "corpusDigest", "corpusVersion", "evaluationReportRef", "evaluationDigest"] as const;
  const missing = requiredPins.filter((name) => typeof configJson[name] !== "string");
  if (missing.length > 0) { fail("config-pins", `missing or non-string pins: ${missing.join(", ")}`); return finalize(true, enabled, killSwitch); }

  const candidateRef = configJson.candidateArtifactRef;
  const candidateDigest = configJson.candidateArtifactDigest;
  const baselineRef = configJson.baselineArtifactRef;
  const baselineDigest = configJson.baselineArtifactDigest;
  const corpusRef = configJson.corpusRef;
  const corpusDigest = configJson.corpusDigest;
  const evaluationRef = configJson.evaluationReportRef;
  const evaluationDigest = configJson.evaluationDigest;
  if (!asString(candidateRef) || !asString(candidateDigest) || !asString(baselineRef) || !asString(baselineDigest) || !asString(corpusRef) || !asString(corpusDigest) || !asString(evaluationRef) || !asString(evaluationDigest)) { fail("config-pins", "pins are present but not non-empty strings"); return finalize(true, enabled, killSwitch); }
  pass("config-pins");

  const refsOk = workspacePathPattern.test(candidateRef) && workspacePathPattern.test(baselineRef) && workspacePathPattern.test(corpusRef) && workspacePathPattern.test(evaluationRef);
  if (refsOk) pass("reference-paths"); else fail("reference-paths", "one or more artifact refs are not contained workspace-relative './…' paths");
  const hashesOk = validHash(candidateDigest) && validHash(baselineDigest) && validHash(corpusDigest) && validHash(evaluationDigest);
  if (hashesOk) pass("digest-format"); else fail("digest-format", "one or more pinned digests are not sha256 hex");
  const versionsOk = isImmutableVersion(configJson.candidateVersion) && isImmutableVersion(configJson.baselineVersion) && isImmutableVersion(configJson.corpusVersion);
  if (versionsOk) pass("immutable-versions"); else fail("immutable-versions", "candidate/baseline/corpus versions must be immutable (no latest/main/head/…)");
  const policyRefsOk = policyRefPattern.test(candidateRef) && policyRefPattern.test(baselineRef);
  if (policyRefsOk) pass("policy-refs"); else fail("policy-refs", "candidate/baseline refs must be './…' policy references");
  if (!(refsOk && hashesOk && versionsOk && policyRefsOk)) return finalize(true, enabled, killSwitch);

  let baselineArtifact: { artifact: UnknownRecord; digest: string } | undefined;
  let candidateArtifact: { artifact: UnknownRecord; digest: string } | undefined;
  let corpusPayload: { artifact: PolicyCorpus; raw: string } | undefined;
  let evaluationPayload: { artifact: PolicyEvaluationReport; raw: string } | undefined;

  try { baselineArtifact = await readPinnedJson<UnknownRecord>({ workspaceRoot, uri: baselineRef, digest: baselineDigest }); if (isBaselineArtifact(baselineArtifact.artifact)) pass("baseline-artifact"); else fail("baseline-artifact", "not a valid deterministic-baseline artifact"); }
  catch (error) { fail("baseline-artifact", `unreadable or digest mismatch: ${msg(error)}`); }
  try { candidateArtifact = await readPinnedJson<UnknownRecord>({ workspaceRoot, uri: candidateRef, digest: candidateDigest }); if (isCandidateArtifact(candidateArtifact.artifact)) pass("candidate-artifact"); else fail("candidate-artifact", "not a valid offline-selection-advisor artifact"); }
  catch (error) { fail("candidate-artifact", `unreadable or digest mismatch: ${msg(error)}`); }
  try {
    corpusPayload = await readWorkspaceJson<PolicyCorpus>({ workspaceRoot, uri: corpusRef });
    if (!isCompleteCorpus(corpusPayload.artifact)) fail("corpus", "corpus failed structural / manifest verification");
    else if (corpusPayload.artifact.manifest.corpusVersion !== configJson.corpusVersion || corpusPayload.artifact.manifest.corpusDigest !== corpusDigest) fail("corpus", "corpus manifest version/digest does not match pins");
    else pass("corpus");
  } catch (error) { fail("corpus", `unreadable: ${msg(error)}`); }
  try {
    evaluationPayload = await readWorkspaceJson<PolicyEvaluationReport>({ workspaceRoot, uri: evaluationRef });
    if (!isEvaluationReport(evaluationPayload.artifact) || !hasReportIntegrity(evaluationPayload.artifact)) fail("evaluation-report", "report is malformed or its recomputed digest does not match");
    else if (evaluationPayload.artifact.reportDigest !== evaluationDigest) fail("evaluation-report", "report digest does not match pin");
    else pass("evaluation-report");
  } catch (error) { fail("evaluation-report", `unreadable: ${msg(error)}`); }

  if (baselineArtifact && candidateArtifact && corpusPayload && evaluationPayload
    && isBaselineArtifact(baselineArtifact.artifact) && isCandidateArtifact(candidateArtifact.artifact)
    && isCompleteCorpus(corpusPayload.artifact) && isEvaluationReport(evaluationPayload.artifact) && hasReportIntegrity(evaluationPayload.artifact)
    && corpusPayload.artifact.manifest.corpusVersion === configJson.corpusVersion && corpusPayload.artifact.manifest.corpusDigest === corpusDigest
    && evaluationPayload.artifact.reportDigest === evaluationDigest) {
    try {
      const config = {
        ...configJson,
        enabled: true,
        killSwitch: false,
        candidateArtifactDigest: candidateArtifact.digest,
        candidateDigest: candidateArtifact.digest,
        baselineArtifactDigest: baselineArtifact.digest,
        baselineDigest: baselineArtifact.digest,
        corpusDigest,
        evaluationDigest,
        candidateVersion: configJson.candidateVersion,
        baselineVersion: configJson.baselineVersion,
        corpusVersion: configJson.corpusVersion,
        rollbackBaselineVersion: configJson.rollbackBaselineVersion ?? configJson.baselineVersion,
      } as PolicyExperimentConfig;
      const baseline: BaselineSelection = { selectedIds: evaluationPayload.artifact.candidateSelectedIds, source: "deterministic-baseline", version: baselineArtifact.artifact.version, artifactDigest: baselineArtifact.digest };
      const candidate: PolicyExperimentCandidate = { version: candidateArtifact.artifact.version, artifactDigest: candidateArtifact.digest };
      const outcome = resolvePolicyExperiment({ config, evaluation: evaluationPayload.artifact, candidate, corpus: corpusPayload.artifact, baseline });
      if (outcome.source === "candidate") pass("activation-gate", "evidence gates pass: security non-regression, holdout, adversarial, pins and candidate subset");
      else fail("activation-gate", `evidence gates reject candidate; report reasons: ${evaluationPayload.artifact.reasons.join(", ") || "none"}`);
    } catch (error) { fail("activation-gate", `activation check errored: ${msg(error)}`); }
  } else {
    fail("activation-gate", "skipped: one or more prerequisite artifact checks did not pass");
  }

  return finalize(true, enabled, killSwitch);
}

function isCompleteCorpus(value: UnknownRecord): value is PolicyCorpus {
  return isRecord(value) && isRecord(value.manifest) && Array.isArray(value.rows) && Array.isArray(value.quarantine) && verifyPolicyCorpus(value as PolicyCorpus);
}

const validHash = (value: string): boolean => reportHashPattern.test(value);

/** Read-only SAC facade; all sources are adapters owned by their source module. */
export class FwkReadService {
  constructor(private readonly options: {
    guard: StrictSacGuard;
    authorizationServer: SacAuthorizationServer;
    source: (input: { workspaceId: string; actorContext: TrustedActorContext }) => Promise<FwkSource>;
    canonical: { workspaceRoot: string; configurationRevision: string; policyRef: string; policyRevision: string };
    policySelection?: () => Promise<PolicyRuntimeSelection>;
    now?: () => Date;
    verifyReceiptLedger?: LedgerVerifier;
    refreshReceiptCheckpoint?: (checkpointPath: string, body: CheckpointBody) => Promise<void>;
    receiptLockOptions?: { timeoutMs?: number; retryMs?: number; staleMs?: number; heartbeatMs?: number };
  }) {}

  async overview(input: { workspaceId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number }; required?: string[]; optional?: string[] }): Promise<FwkReadResult> {
    return this.resolve(input, "overview");
  }

  /** Progressive, read-only detail operation over a single previously discoverable ID. */
  async read(input: { workspaceId: string; itemId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number } }): Promise<FwkReadResult> {
    return this.resolve({ ...input, required: [input.itemId], optional: [] }, "resource", input.itemId);
  }

  private async resolve(input: { workspaceId: string; request: unknown; requestCorrelationId: string; budget: { maxItems: number; maxTokens: number }; required?: string[]; optional?: string[] }, action: "overview" | "resource", itemId?: string): Promise<FwkReadResult> {
    const policy = await (this.options.policySelection?.() ?? Promise.resolve(this.options.canonical));
    // Actor identity is intentionally absent from the public payload.  Only a
    // transport-owned authorization server may issue the WeakSet-trusted
    // context carried into source resolution.
    const actor = await this.options.authorizationServer.actorContextFor(input.request, input.requestCorrelationId);
    if (!actor) return this.denied(input.workspaceId, "service:untrusted", input.requestCorrelationId);
    const guard = await evaluateStrictSacGuard({ guard: this.options.guard, operation: "read" });
    if (!guard.allowed) return this.denied(input.workspaceId, actor.subject, input.requestCorrelationId);
    let source: FwkSource;
    try {
      // The source adapter must authorize/revalidate while opening its source,
      // so a role revoked after actor issuance cannot disclose a reference.
      source = await this.options.source({ workspaceId: input.workspaceId, actorContext: actor });
    } catch (error) {
      // Do not turn source existence, cross-workspace, or revoked-role errors
      // into a discovery oracle.  All are represented as the same receipt.
      if (error instanceof WorkspaceServiceError && (error.code === "access_denied" || error.code === "not_found" || error.code === "invalid_reference")) return this.denied(input.workspaceId, actor.subject, input.requestCorrelationId);
      throw error;
    }
    const now = this.options.now ?? (() => new Date());
    const required = new Set(input.required ?? []); const optional = new Set(input.optional ?? []);
    const facts = source.facts.map((fact) => ({ ...fact, freshness: !fact.visible ? "denied" as const : fact.status === "stale" ? "stale" as const : new Date(fact.expiresAt) <= now() ? "expired" as const : "fresh" as const }));
    const knowHow = source.knowHow.map((item) => ({ ...item, status: !item.visible ? "denied" as const : !item.accepted ? "denied" as const : item.status }));
    const work = source.work?.flowRef ? { state: "bound" as const, ...source.work } : { state: "unbound" as const };
    const visibleFacts = facts.filter((fact) => fact.visible);
    const acceptedKnowHow = knowHow.filter((entry) => entry.visible && entry.accepted && entry.status !== "withdrawn" && entry.status !== "denied");
    const withheld = [...facts.filter((fact) => !fact.visible).map((fact) => fact.id), ...knowHow.filter((entry) => !entry.visible || !entry.accepted || entry.status === "withdrawn" || entry.status === "denied").map((entry) => entry.id)];
    const select = <T extends { id: string }>(items: T[]): T[] => itemId ? items.filter((entry) => entry.id === itemId) : items;
    const candidates: ContextCandidate[] = [
      ...select(visibleFacts).map((fact) => ({ id: fact.id, required: required.has(fact.id) || !optional.has(fact.id), tokens: Math.ceil(fact.statement.length / 4) })),
      ...(work.state === "bound" && (!itemId || itemId === "work") ? [{ id: "work", required: required.has("work") || !optional.has("work"), tokens: 32 }] : []),
      ...select(acceptedKnowHow).map((item) => ({ id: item.id, required: required.has(item.id) || !optional.has(item.id), tokens: 16 })),
    ];
    const assembly = await assembleAndRecordContext({ workspaceRoot: this.options.canonical.workspaceRoot, correlationId: input.requestCorrelationId, ...input.budget, candidates, omittedOptional: withheld, configurationRevision: this.options.canonical.configurationRevision, policyRef: policy.policyRef, policyRevision: policy.policyRevision });
    if ("code" in assembly) return assembly;
    return this.success(input.workspaceId, actor.subject, assembly, facts, work, acceptedKnowHow, now, action, itemId);
  }

  private async success(workspaceId: string, actor: string, assembly: ContextAssembly, facts: Array<FwkEvidence & { freshness: "fresh" | "stale" | "expired" | "denied" }>, work: unknown, knowHow: FwkKnowHow[], now: () => Date, action: "overview" | "resource", resourceId?: string): Promise<FwkResult> {
    const selected = new Set(assembly.selected);
    const selectedFacts = facts.filter((fact) => selected.has(fact.id));
    const selectedKnowHow = knowHow.filter((item) => selected.has(item.id));
    const stale = selectedFacts.some((fact) => fact.freshness !== "fresh") || selectedKnowHow.some((item) => item.status !== "fresh");
    const manifest = { schemaVersion: "1.0" as const, workspaceId, generatedAt: nowIso(now), facts: selectedFacts.map((fact) => ({ statement: fact.statement, evidence: [{ kind: "artifact" as const, uri: fact.uri, revision: fact.revision, observedAt: fact.observedAt, trust: fact.trust }], observedAt: fact.observedAt, expiresAt: fact.expiresAt, freshness: fact.freshness })), work: selected.has("work") ? work : { state: "unbound" }, knowHow: selectedKnowHow.map(({ id, accepted, visible, ...item }) => item), freshness: stale ? "stale" as const : assembly.partial ? "partial" as const : "fresh" as const };
    const fwk = await validateSacContract({ schema: "fwk-receipt", document: manifest });
    if (!fwk.valid) throw new Error(`invalid FWK manifest: ${fwk.errors.map((error) => error.code).join(",")}`);
    const receipt = await this.receipt(workspaceId, actor, stale ? "stale" : "allowed", assembly, now, action, resourceId);
    if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
    const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
    if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
    return { partial: assembly.partial, omittedOptional: assembly.omittedOptional, manifest, receipt };
  }

  private async denied(workspaceId: string, actor: string, correlationId: string): Promise<FwkResult> {
    const policy = this.options.canonical;
    const now = this.options.now ?? (() => new Date());
    const assembly = await recordNoContentContext({ workspaceRoot: this.options.canonical.workspaceRoot, correlationId, configurationRevision: this.options.canonical.configurationRevision, policyRef: policy.policyRef, policyRevision: policy.policyRevision, outcome: "denied" });
    const receipt = await this.receipt(workspaceId, actor, "denied", assembly, now);
    if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
    const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
    if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
    return { partial: false, omittedOptional: [], manifest: { facts: [], work: { state: "unbound" }, knowHow: [], freshness: "denied" }, receipt };
  }

  private async receipt(workspaceId: string, actor: string, decision: AccessReceipt["decision"], assembly: ContextAssembly, now: () => Date, action: "overview" | "resource" = "overview", resourceId?: string): Promise<AccessReceipt> {
    const recordedAt = nowIso(now); const id = `receipt-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const base = { schemaVersion: "1.0" as const, id, workspaceId, actor, action, decision, recordedAt, cost: { tokens: 0, toolCalls: 1, elapsedMs: 0 }, contextAssembly: { traceRef: assembly.traceRef, configurationRevision: assembly.configurationRevision, selected: assembly.selected.map((id) => `./ids/${id}`), omittedOptional: assembly.omittedOptional.map((id) => `./ids/${id}`) }, policy: { ref: assembly.policyRef, revision: assembly.policyRevision }, ...(action === "resource" ? { resourceRef: `./ids/${resourceId ?? "unknown"}` } : {}) };
    const ledger = path.join(this.options.canonical.workspaceRoot, ".metaproject", "context-operations", "access-receipts.jsonl");
    const checkpointPath = path.join(path.dirname(ledger), "access-receipts.checkpoint.json");
    await mkdir(path.dirname(ledger), { recursive: true, mode: 0o700 });
    return withFileLock(`${ledger}.lock`, async () => {
      const state = await resolveLedgerState(ledger, checkpointPath, this.options.verifyReceiptLedger ?? verifyAccessReceiptLedger);
      const receipt = sealAccessReceipt(base, state.headHash) as AccessReceipt;
      if (!metadataOnly(receipt)) throw new Error("receipt metadata contract violated");
      const validation = await validateSacContract({ schema: "access-receipt", document: receipt });
      if (!validation.valid) throw new Error(`invalid access receipt: ${validation.errors.map((error) => error.code).join(",")}`);
      const line = `${JSON.stringify(receipt)}\n`;
      await appendFile(ledger, line, { mode: 0o600 });
      try {
        // `state.digest` already holds the verified pre-append bytes, so folding
        // in the line just written yields the digest of the whole new ledger
        // without reading it back. The size check keeps that claim honest: if
        // the file is not exactly the audited prefix plus this line, the
        // checkpoint would vouch for bytes it never saw, so drop it instead.
        const appendedBytes = Buffer.byteLength(line, "utf8");
        const ledgerBytes = state.ledgerBytes + appendedBytes;
        if (await ledgerByteLength(ledger) !== ledgerBytes) throw new Error("invalid access receipt ledger: unexpected-append-size");
        await (this.options.refreshReceiptCheckpoint ?? writeCheckpoint)(checkpointPath, {
          schemaVersion: "1.1", ledgerBytes, recordCount: state.recordCount + 1,
          headHash: receipt.integrity.recordHash, tailOffset: state.ledgerBytes,
          contentDigest: state.digest.update(line).digest("hex"),
        });
      } catch {
        // The ledger append is the commit point. A checkpoint is only a bounded
        // verification cache, so invalidate it and rebuild under the next lock.
        await rm(checkpointPath, { force: true }).catch(() => undefined);
      }
      return receipt;
    }, this.options.receiptLockOptions);
  }
}

/** Local-only composition for the CLI and stdio MCP adapters. */
export function createLocalFwkReadService(
  cwd: string,
  /**
   * Test seam: `beforeResourceOpen` is threaded straight into the internal
   * `WorkspaceService` (see its own doc comment — "runs after
   * authorization/containment but before the safe FD open"). Lets tests
   * reproduce an ACL change landing in the real re-authorize-at-use window
   * without needing a second real client/process.
   */
  opts?: { beforeResourceOpen?: () => Promise<void> | void },
): FwkReadService {
  const authorizationServer = localWorkspaceAuthorizationServer();
  const workspaces = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer,
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    ...(opts?.beforeResourceOpen ? { beforeResourceOpen: opts.beforeResourceOpen } : {}),
  });
  const canonical = Object.freeze({ workspaceRoot: cwd, configurationRevision: "context-operations-v1", policyRef: "./security/policy/local", policyRevision: "local-offline-v1" });
  return new FwkReadService({
    guard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    authorizationServer,
    source: async ({ workspaceId, actorContext }) => {
      const manifest = await workspaces.showForActor({ actorContext, workspaceId });
      const flow = manifest.resources.find((resource) => resource.kind === "flow");
      const facts = await Promise.all(manifest.resources.filter((resource) => resource.kind === "evidence").map(async (resource, index) => {
        const raw = await workspaces.readResourceForActor({ actorContext, workspaceId, resource }) as Buffer;
        const revision = createHash("sha256").update(raw).digest("hex");
        return { id: `fact-${index}`, uri: resource.uri, revision: resource.revision ?? revision, observedAt: manifest.updatedAt, expiresAt: "9999-12-31T23:59:59Z", trust: "primary" as const, visible: true, statement: `Evidence reference ${resource.uri}`, status: resource.revision === revision || resource.revision === undefined ? "fresh" as const : "stale" as const };
      }));
      const knowHow = await Promise.all(manifest.resources.filter((resource) => resource.kind === "wiki" || resource.kind === "memory" || resource.kind === "skill").map(async (resource, index) => {
        const raw = await workspaces.readResourceForActor({ actorContext, workspaceId, resource, encoding: "utf8" }) as string;
        const revision = createHash("sha256").update(raw).digest("hex");
        const accepted = /^Status:\s*(accepted|reviewed)\s*$/mi.test(raw);
        return { id: `knowhow-${index}`, kind: resource.kind as "wiki" | "memory" | "skill", uri: resource.uri, revision: resource.revision ?? revision, trust: "accepted" as const, status: resource.revision === revision || resource.revision === undefined ? "fresh" as const : "stale" as const, accepted, visible: true };
      }));
      const work = flow ? await (async () => {
        // A deleted flow resource entry, an unsafe/broken reference, or
        // malformed JSON must not break the whole Facts+Work+Know-how
        // assembly for overview/read: any CONTENT-class failure here yields
        // `undefined`, which `FwkReadService.resolve()` already maps to
        // `work.state === "unbound"` rather than throwing.
        try {
          const raw = await workspaces.readResourceForActor({ actorContext, workspaceId, resource: flow, encoding: "utf8" }) as string;
          const snapshot = JSON.parse(raw) as FlowState;
          if (!snapshot.id || !snapshot.status || !snapshot.updatedAt || !Array.isArray(snapshot.tasks)) return undefined;
          // Same read-time normalization `src/flow/store.ts`'s `readFlow` applies
          // (v1 -> v2 in-memory only) before handing off to the shared
          // completed/next/blocked formula (`deriveFlowWork`) — the same one
          // `src/session/slate-course.ts`'s `readCourse` uses. An unsupported/
          // missing schemaVersion throws here and is swallowed by the catch
          // below exactly like malformed JSON already is.
          return deriveFlowWork(migrateFlow(snapshot), flow.uri);
        } catch (error) {
          // Only a content-unreadable/malformed failure collapses to
          // "unbound" here: a deleted flow resource entry (`not_found`), a
          // broken/unsafe reference or safe-read failure (`invalid_reference`
          // — including a platform-unavailable safe-read bridge), or
          // genuinely malformed JSON (`SyntaxError`; the shape check above
          // already returns `undefined` directly without throwing). A
          // `WorkspaceServiceError` whose code is `access_denied` is an
          // AUTHORIZATION denial, not a content problem — most commonly the
          // actor's role being revoked between the workspace manifest read
          // and this specific resource's re-authorization at use
          // (`WorkspaceService.readResourceForActor`'s own TOCTOU-closing
          // re-check; see workspace-service.ts). Swallowing it here would
          // silently downgrade a full authorization denial into a partial
          // disclosure: facts/knowHow already resolved successfully moments
          // earlier would still be returned, with only `work` hidden. It
          // must propagate out of this composition so
          // `FwkReadService.resolve()`'s existing catch (~line 493) maps it
          // to a full `denied()` receipt instead — exactly like it already
          // does when `access_denied` surfaces from the facts/knowHow reads
          // above, which were never wrapped in a local catch at all.
          if (error instanceof WorkspaceServiceError && error.code === "access_denied") throw error;
          return undefined;
        }
      })() : undefined;
      return {
        facts: facts.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
        ...(work ? { work } : {}),
        knowHow: knowHow.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
      };
    },
    canonical,
    policySelection: async () => resolvePolicySelectionSafely(
      cwd,
      canonical,
    ),
  });
}

/** The only transport serialization contract used by both CLI and MCP. */
export function normalizeFwkResult(result: FwkReadResult): FwkReadResult { return JSON.parse(JSON.stringify(result)) as FwkReadResult; }
