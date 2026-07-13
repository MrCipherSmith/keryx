// Crash / recovery decision surface (flow 011, W8 / RS-02, R12 / R6).
//
// `recoverFrom` is the PURE, deterministic, OFFLINE decision function behind the
// @task-RS-02 failpoint matrix. Given a persisted `SessionSnapshot`, an injected
// `Failpoint`, and (for a post-effect crash) an optional `ExecutionReceipt`, it
// returns a typed `RecoveryDecision` describing how the harness should proceed —
// WITHOUT taking that action. It never appends to the session, never invokes a
// provider/tool, and never touches the network or filesystem: recovery is a
// classification over already-durable state, so a real crash recovery drops in
// behind the same decision without changing this logic.
//
// The five failpoints map one-to-one onto the frozen AC3 matrix:
//   - crash-pre-effect          -> safe-reexecute        (no observed effect, safe to retry)
//   - crash-post-effect + KNOWN -> reconciled            (effect-confirmed receipt reconciles, no dup)
//   - crash-post-effect + UNKNOWN/none -> blocked-unknown-outcome (ambiguous effect blocks unsafe retry)
//   - torn-write                -> recovered-torn-write  (drop the truncated tail, resume at last intact entry)
//   - cancellation              -> cancelled-resumable   (attempt cancelled, session untouched + resumable)
//   - isolated-replay-reexecute -> replay-deferred       (SC_R17: isolated re-exec stays deferred in R0/1)
//
// `outcome` correspondence: the frozen `execution-receipt.schema.json` enum is
// ["effect-confirmed", "effect-absent", "indeterminate", "not-applicable"]. Only
// "effect-confirmed" is a KNOWN outcome that reconciles cleanly; every other value
// (and a missing receipt after a recorded effect) is an UNKNOWN outcome that must
// block an unsafe retry until reconciliation.
import path from "node:path";
import { validateAgainstSchema } from "../../contracts/validator";
import type { SessionSnapshot } from "./store";

// Frozen schemas dir, computed relative to this file
// (src/harness/resume/ -> repo root), matching recovery.test.ts.
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

/**
 * Mirrors `execution-receipt.schema.json`: a receipt records an observed or
 * reconciled side-effect boundary. `outcome` is kept a bare `string` (the frozen
 * enum is ["effect-confirmed", "effect-absent", "indeterminate", "not-applicable"])
 * so a durable payload validates through `src/contracts` unchanged.
 */
export interface ExecutionReceipt {
  schemaVersion: number;
  receiptId: string;
  executionId: string;
  idempotencyKey: string;
  inputHash: string;
  observedAt: string;
  outcome: string;
  evidenceRefs: string[];
}

/**
 * The injected failpoint a recovery classifies. All five are supplied as data —
 * there is no real crash, cancellation, torn filesystem write, or replay engine
 * behind them here; `recoverFrom` only decides what SHOULD happen.
 */
export type Failpoint =
  | "crash-pre-effect"
  | "crash-post-effect"
  | "torn-write"
  | "cancellation"
  | "isolated-replay-reexecute";

/**
 * The typed decision a recovery yields. Each variant is inert — the caller (not
 * `recoverFrom`) is responsible for enacting it.
 */
export type RecoveryDecision =
  | { kind: "safe-reexecute" }
  | { kind: "reconciled"; receiptId: string }
  | { kind: "blocked-unknown-outcome"; reason: string }
  | { kind: "recovered-torn-write"; atEntryId: string }
  | { kind: "cancelled-resumable" }
  | { kind: "replay-deferred" };

/** Inputs to a single recovery decision. */
export interface RecoverFromInput {
  snapshot: SessionSnapshot;
  failpoint: Failpoint;
  /** Present only for a post-effect crash that recorded a reconciliation receipt. */
  receipt?: ExecutionReceipt;
}

/**
 * Injected sources of otherwise-nondeterministic values. Recovery is a pure
 * classification and consumes none of them today; they are accepted for signature
 * parity with the rest of `src/harness/resume` (resume/run) and so a future
 * decision that must mint an id or stamp a time stays deterministic.
 */
export interface RecoveryDeps {
  clock: () => string;
  idSeq: () => string;
}

/** The single KNOWN outcome that reconciles a post-effect crash without a retry. */
const KNOWN_OUTCOME = "effect-confirmed";

/**
 * The entryId of the last entry that still validates against the frozen
 * `session-entry.schema.json`. A torn (truncated) tail line is missing required
 * fields, so it fails validation and is skipped; recovery resumes at the last
 * intact entry before it. Throws when NO entry is intact (an unrecoverable trail).
 */
function lastIntactEntryId(snapshot: SessionSnapshot): string {
  let atEntryId: string | undefined;
  for (const entry of snapshot.entries) {
    const result = validateAgainstSchema("session-entry.schema.json", entry, {
      schemaDir: SCHEMA_DIR,
    });
    if (result.valid) {
      atEntryId = entry.entryId;
    }
  }
  if (atEntryId === undefined) {
    throw new Error("recoverFrom: torn-write recovery found no intact session entry to resume from");
  }
  return atEntryId;
}

/**
 * Classify how the harness should recover from `input.failpoint`. PURE and
 * deterministic: it reads only the supplied snapshot/receipt (and the frozen
 * schemas for torn-write detection) and returns a typed decision. It appends
 * nothing, invokes no provider/tool, and performs no network/filesystem effect.
 */
export function recoverFrom(input: RecoverFromInput, _deps: RecoveryDeps): RecoveryDecision {
  switch (input.failpoint) {
    case "crash-pre-effect":
      // No side effect was ever observed: re-executing is safe (no double effect).
      return { kind: "safe-reexecute" };

    case "crash-post-effect": {
      const { receipt } = input;
      if (receipt !== undefined && receipt.outcome === KNOWN_OUTCOME) {
        // KNOWN outcome: reconcile against the existing receipt/evidence — no
        // duplicate effect is attempted.
        return { kind: "reconciled", receiptId: receipt.receiptId };
      }
      // UNKNOWN outcome (indeterminate/effect-absent/not-applicable) or no receipt
      // at all: the effect's real-world result is ambiguous, so an unsafe retry is
      // blocked until reconciliation supplies a KNOWN outcome.
      const reason =
        receipt === undefined
          ? "a side effect was recorded but no execution-receipt exists to reconcile it; blocking unsafe retry"
          : `execution-receipt outcome "${receipt.outcome}" is not "${KNOWN_OUTCOME}"; ambiguous side effect blocks unsafe retry`;
      return { kind: "blocked-unknown-outcome", reason };
    }

    case "torn-write":
      // The truncated tail is not committed: recover to the last intact entry.
      return { kind: "recovered-torn-write", atEntryId: lastIntactEntryId(input.snapshot) };

    case "cancellation":
      // A cancelled attempt leaves the session untouched and resumable.
      return { kind: "cancelled-resumable" };

    case "isolated-replay-reexecute":
      // SC_R17: isolated replay re-execution is not available in Release 0/1.
      return { kind: "replay-deferred" };
  }
}
