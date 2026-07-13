// Completion gate (flow 009, W7 / S4, task-R0-02).
//
// `evaluateCompletion` produces the typed `CompletionGateResult` evidence
// artifact consumed by Task Manager. It NEVER changes managed-flow completion
// itself; it only reports whether the standalone-run completion conditions hold
// (`specification.md` §Completion Gates and the frozen
// `completion-gate-result.schema.json`).
//
// The gate reaches `status: "pass"` only when ALL of the following hold — a
// final message alone never passes (@SC_R10_EVIDENCE_FREE_COMPLETION_REJECTED):
//   1. every required gate reports `pass` (not fail/skipped/unknown),
//   2. every required evidence ref is present, and
//   3. no undisposed blocker remains (@SC_R10_UNDISPOSED_BLOCKER_REJECTED),
// together with a final message having been emitted. Otherwise it is `blocked`
// (undisposed blockers present) or `fail`.
//
// Determinism: `deps.clock`/`deps.idSeq` are the only sources of the
// `evaluatedAt` timestamp and `gateId`; there is NO `Date.now`, `Math.random`,
// network, or filesystem access. `idSeq` is called exactly once (for the
// gateId) so repeated evaluations of identical input with fresh identical deps
// are byte-identical.

/** One required verification gate reported into the completion check. */
export interface RequiredGate {
  name: string;
  status: "pass" | "fail" | "skipped" | "unknown";
}

/** Inputs to a single completion evaluation. */
export interface CompletionInput {
  runId: string;
  requiredGates: RequiredGate[];
  requiredEvidenceRefs: string[];
  presentEvidenceIds: string[];
  undisposedBlockerIds: string[];
  finalMessageEmitted: boolean;
}

/** Injected non-determinism: a fixed clock and a monotonic id source. */
export interface CompletionDeps {
  clock: () => string;
  idSeq: () => string;
}

/**
 * One check within the gate result. Mirrors the frozen
 * `completion-gate-result.schema.json` `checks` item exactly
 * (`additionalProperties: false`).
 */
export interface CompletionCheck {
  checkId: string;
  status: "pass" | "fail" | "skipped" | "unknown";
  blocking: boolean;
  evidenceRefs: string[];
  detail?: string;
}

/**
 * Typed completion-gate evidence artifact. Validates against the frozen
 * `completion-gate-result.schema.json` (schemaVersion always 1). When
 * `status === "pass"`, every check is `pass` and `unresolvedBlockerIds` is
 * empty.
 */
export interface CompletionGateResult {
  schemaVersion: number;
  gateId: string;
  runId: string;
  status: "pass" | "fail" | "blocked" | "unknown";
  checks: CompletionCheck[];
  evaluatedAt: string;
  evidenceRefs: string[];
  unresolvedBlockerIds: string[];
}

/** Every durable harness contract in Release 0 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

/**
 * Build a check, including `detail` only when it is a non-empty string. An
 * explicit `detail: undefined` key would be rejected by the frozen schema
 * (`additionalProperties: false`, `detail` typed `string`), so it is omitted.
 */
function makeCheck(
  checkId: string,
  status: CompletionCheck["status"],
  evidenceRefs: string[],
  detail?: string,
): CompletionCheck {
  const check: CompletionCheck = { checkId, status, blocking: true, evidenceRefs };
  if (detail !== undefined) check.detail = detail;
  return check;
}

/** Deduplicate while preserving first-seen order. */
function uniqueInOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Evaluate the completion conditions for `input` and return a schema-valid
 * `CompletionGateResult`. Pure aside from the injected `deps`.
 */
export function evaluateCompletion(
  input: CompletionInput,
  deps: CompletionDeps,
): CompletionGateResult {
  const presentSet = new Set(input.presentEvidenceIds);

  // The evidence refs the gate stands on: every required ref (so a verified
  // result lists all of them) plus any additional present ids, deduped and
  // order-stable for determinism. Kept non-empty to satisfy the schema's
  // `nonEmptyStringArray` when any evidence is expected/present.
  const evidenceRefs = uniqueInOrder([
    ...input.requiredEvidenceRefs,
    ...input.presentEvidenceIds,
  ]);

  // --- Per-gate checks (one blocking check per required gate). ---
  const checks: CompletionCheck[] = input.requiredGates.map((gate) =>
    makeCheck(`gate:${gate.name}`, gate.status, []),
  );

  const allGatesPass = input.requiredGates.every((gate) => gate.status === "pass");

  // --- Evidence-presence check. ---
  const missingEvidence = input.requiredEvidenceRefs.filter((ref) => !presentSet.has(ref));
  const allEvidencePresent = missingEvidence.length === 0;
  checks.push(
    makeCheck(
      "evidence:required-present",
      allEvidencePresent ? "pass" : "fail",
      uniqueInOrder(input.requiredEvidenceRefs.filter((ref) => presentSet.has(ref))),
      allEvidencePresent ? undefined : `missing required evidence: ${missingEvidence.join(", ")}`,
    ),
  );

  // --- Undisposed-blocker check. ---
  const unresolvedBlockerIds = uniqueInOrder(input.undisposedBlockerIds);
  const noBlockers = unresolvedBlockerIds.length === 0;
  checks.push(
    makeCheck(
      "blockers:none-undisposed",
      noBlockers ? "pass" : "fail",
      [],
      noBlockers ? undefined : `undisposed blockers: ${unresolvedBlockerIds.join(", ")}`,
    ),
  );

  // --- Final-message check (necessary but never sufficient on its own). ---
  checks.push(makeCheck("final-message:emitted", input.finalMessageEmitted ? "pass" : "fail", []));

  const passes =
    allGatesPass && allEvidencePresent && noBlockers && input.finalMessageEmitted;

  const status: CompletionGateResult["status"] = passes
    ? "pass"
    : noBlockers
      ? "fail"
      : "blocked";

  return {
    schemaVersion: SCHEMA_VERSION,
    gateId: deps.idSeq(),
    runId: input.runId,
    status,
    checks,
    evaluatedAt: deps.clock(),
    evidenceRefs,
    unresolvedBlockerIds,
  };
}
