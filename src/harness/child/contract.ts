// Canonical child-contract adapter (flow 015, W12 / CA-01).
//
// Adapts the canonical gdskills `subagent-dispatch`/`subagent-result` contracts
// (`.metaproject/core/gdskills/contracts/`) with harness parent/session/attempt
// extension metadata and STATUS-first prose framing. The extension object is
// metadata OVER the canonical contracts (validates against the frozen
// `harness-child-contract-extension.schema.json`), NOT a replacement wire
// contract.
//
// STATUS-first prose is adapter framing: a worker's reply whose first line is
// `STATUS: <TOKEN>` is converted to a canonical `subagent-result` object BEFORE
// persistence. The persisted form is always the canonical object, never the raw
// string.
//
// Deterministic: no `Date.now()`, `Math.random()`, network, or fs surface. All
// canonical fields the prose cannot carry (run/dispatch ids, timestamp, contract
// version) are supplied through `meta`.

/**
 * Harness extension metadata layered over a canonical `subagent-dispatch` or
 * `subagent-result` contract. Mirrors
 * `harness-child-contract-extension.schema.json` (`additionalProperties:false`).
 */
export interface ChildContractExtension {
  schemaVersion: 1;
  canonicalContract: "subagent-dispatch" | "subagent-result";
  canonicalContractVersion: string;
  parentRunId: string;
  sessionId: string;
  attempt: { attemptId: string; number: number };
  branchId: string;
  contextManifestHash: string;
  policyFingerprint: string;
  budgetReservation: { reservationId: string; maxRuntimeMs: number; maxToolCalls?: number };
  durableResultArtifact: { artifactId: string; kind: string; path?: string; hash: string };
  /**
   * The child's fail-closed-resolved model/provider selection (flow 089). Optional
   * and additive: absent on legacy dispatches (backward-compatible), present once a
   * parent threads model context through `spawnChild` (see `./model` +
   * `resolveChildModel`). `source` records which resolution rung produced it.
   */
  modelSelection?: { providerId: string; modelId: string; source: "env" | "explicit" | "tier" | "inherited" };
}

/**
 * Input to {@link buildChildDispatchExtension}: every {@link ChildContractExtension}
 * field except `schemaVersion`, which the builder injects as the const `1`.
 */
export type BuildChildDispatchExtensionInput = Omit<ChildContractExtension, "schemaVersion">;

/** Canonical `subagent-result` status enum (mirrors subagent-result.schema.json). */
export type CanonicalSubagentStatus =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "NEEDS_CONTEXT"
  | "BLOCKED"
  | "FAILED";

/**
 * A canonical `subagent-result` object. Field shape and required/optional split
 * mirror `subagent-result.schema.json` exactly.
 */
export interface CanonicalSubagentResult {
  contract_version: string;
  run_id: string;
  dispatch_id: string;
  status: CanonicalSubagentStatus;
  summary: string;
  acceptance: Array<{
    criterion: string;
    status: "met" | "partial" | "not_met" | "not_applicable";
    evidence?: string;
  }>;
  artifacts: Array<{
    path: string;
    kind: string;
    exists: boolean;
    summary?: string;
    hash?: string | null;
  }>;
  changed_files: Array<{ path: string; change: string }>;
  findings: unknown[];
  questions: unknown[];
  errors: Array<{ type: string; message: string; detail?: string }>;
  metrics: Record<string, unknown>;
  timestamp_utc: string;
}

/**
 * Out-of-band metadata for the string branch of {@link parseChildResult}: the
 * pre-built result-variant extension plus the canonical fields STATUS-first
 * prose cannot carry.
 */
export interface ParseChildResultMeta {
  extension: ChildContractExtension;
  runId: string;
  dispatchId: string;
  timestampUtc: string;
  contractVersion: string;
}

/** A normalized child result: the extension metadata plus the canonical object. */
export interface ParsedChildResult {
  extension: ChildContractExtension;
  canonical: CanonicalSubagentResult;
}

const CANONICAL_STATUS_TOKENS: ReadonlySet<CanonicalSubagentStatus> = new Set([
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
  "FAILED",
]);

/**
 * Assemble a frozen-schema {@link ChildContractExtension} from parent context.
 * The same builder produces both the `subagent-dispatch` and `subagent-result`
 * variants via `input.canonicalContract`. Pure and deterministic: inputs are
 * copied through and `schemaVersion:1` is injected internally. Optional fields
 * (`budgetReservation.maxToolCalls`, `durableResultArtifact.path`) are only set
 * when provided (respects `exactOptionalPropertyTypes`).
 */
export function buildChildDispatchExtension(
  input: BuildChildDispatchExtensionInput,
): ChildContractExtension {
  const budgetReservation: ChildContractExtension["budgetReservation"] = {
    reservationId: input.budgetReservation.reservationId,
    maxRuntimeMs: input.budgetReservation.maxRuntimeMs,
    ...(input.budgetReservation.maxToolCalls !== undefined
      ? { maxToolCalls: input.budgetReservation.maxToolCalls }
      : {}),
  };

  const durableResultArtifact: ChildContractExtension["durableResultArtifact"] = {
    artifactId: input.durableResultArtifact.artifactId,
    kind: input.durableResultArtifact.kind,
    hash: input.durableResultArtifact.hash,
    ...(input.durableResultArtifact.path !== undefined
      ? { path: input.durableResultArtifact.path }
      : {}),
  };

  return {
    schemaVersion: 1,
    canonicalContract: input.canonicalContract,
    canonicalContractVersion: input.canonicalContractVersion,
    parentRunId: input.parentRunId,
    sessionId: input.sessionId,
    attempt: { attemptId: input.attempt.attemptId, number: input.attempt.number },
    branchId: input.branchId,
    contextManifestHash: input.contextManifestHash,
    policyFingerprint: input.policyFingerprint,
    budgetReservation,
    durableResultArtifact,
    ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
  };
}

function parseStatusToken(firstLine: string): CanonicalSubagentStatus {
  const marker = "STATUS:";
  if (!firstLine.startsWith(marker)) {
    throw new Error(
      `parseChildResult: STATUS-first prose must begin with "STATUS: <TOKEN>", got ${JSON.stringify(firstLine)}`,
    );
  }
  const token = firstLine.slice(marker.length).trim();
  if (!CANONICAL_STATUS_TOKENS.has(token as CanonicalSubagentStatus)) {
    throw new Error(
      `parseChildResult: unknown STATUS token ${JSON.stringify(token)}; expected one of ${[
        ...CANONICAL_STATUS_TOKENS,
      ].join(", ")}`,
    );
  }
  return token as CanonicalSubagentStatus;
}

/**
 * Normalize a child worker's result into a {@link ParsedChildResult}.
 *
 * - `raw: string` — STATUS-first prose. The first line must be `STATUS: <TOKEN>`.
 *   `meta` is REQUIRED and supplies the pre-built extension plus the canonical
 *   fields the prose cannot carry. The remaining prose becomes the canonical
 *   `summary`. Returns the "converted-before-persistence" canonical form.
 * - `raw: ParsedChildResult` — an already-normalized object (e.g. a previously
 *   serialized result recovered from transport). `meta` is ignored and the value
 *   is passed through idempotently, so both transport shapes normalize identically.
 *
 * Deterministic: no clock/randomness; timestamps come from `meta`.
 */
export function parseChildResult(
  raw: string | ParsedChildResult,
  meta?: ParseChildResultMeta,
): ParsedChildResult {
  if (typeof raw !== "string") {
    // Already-normalized object form: idempotent pass-through.
    return raw;
  }

  if (meta === undefined) {
    throw new Error(
      "parseChildResult: meta is required when parsing STATUS-first prose (string) input",
    );
  }

  const lines = raw.split("\n");
  const firstLine = lines[0];
  if (firstLine === undefined) {
    throw new Error("parseChildResult: empty input has no STATUS line");
  }
  const status = parseStatusToken(firstLine);
  const summary = lines.slice(1).join("\n").trim();

  const canonical: CanonicalSubagentResult = {
    contract_version: meta.contractVersion,
    run_id: meta.runId,
    dispatch_id: meta.dispatchId,
    status,
    summary,
    acceptance: [],
    artifacts: [],
    changed_files: [],
    findings: [],
    questions: [],
    errors: [],
    metrics: {},
    timestamp_utc: meta.timestampUtc,
  };

  return { extension: meta.extension, canonical };
}

/**
 * Serialize a {@link ParsedChildResult} to deterministic, stable-key-order JSON
 * such that `parseChildResult(JSON.parse(serializeChildResult(x)))` deep-equals
 * `x` (object branch). The persisted form is this canonical JSON, never the raw
 * STATUS-first prose string.
 */
export function serializeChildResult(result: ParsedChildResult): string {
  return JSON.stringify(result);
}
