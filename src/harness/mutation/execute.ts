// Monitored trusted-local guarded mutation + execution receipt/reconciliation
// (flow 013, W10 / M-02, reviewer track: security/logic).
//
// `executeGuardedMutation` is the fail-closed execute-and-record half of the
// frozen guarded-mutation contract. It composes the M-01 structural guard /
// approval / fingerprint surface with an injected `MutationAdapter` (the ONLY
// side-effecting boundary) and mints a schema-valid `ExecutionReceipt`. It is
// deterministic and OFFLINE: clock/id arrive via `deps`; the fingerprint is
// data-only; there is NO `Date.now`/`Math.random`/network/filesystem here — the
// adapter is the sole effect surface, and it is never reached on any blocked
// path (SC_R04_GUARDED_MUTATION, SC_R15_FAIL_CLOSED_ISOLATION, AC4/AC5).
//
// Fail-closed order (each gate blocks BEFORE the adapter is ever consulted):
//   1. trustMode "read-only"                         -> blocked (never mutates)
//   2. trustMode "untrusted" && !isolationAvailable  -> blocked (isolation)
//   3. guard.kind === "deny"                          -> blocked
//   4. approval.kind !== "valid"                      -> blocked
//   5. adapter.apply(spec) exactly once:
//        - "effect-confirmed" -> executed (receipt + evidence)
//        - otherwise           -> needs-reconciliation (indeterminate/absent
//                                  receipt; W8 `recoverFrom` blocks unsafe retry)
import type { PolicyTrustMode } from "../policy/types";
import type { ExecutionReceipt } from "../resume/recovery";
import { actionFingerprint, type ActionSpec } from "./fingerprint";
import type { GuardOutcome } from "./guard";
import type { ApprovalCheck } from "./approval";

/**
 * The single side-effecting boundary. `apply` performs the concrete mutation
 * (real fs, process, or network — behind the adapter, never in this module) and
 * reports what it observed: whether the effect is confirmed, absent, or
 * indeterminate, plus a content hash of the observed effect for evidence. It is
 * injected (a fake in tests), so `executeGuardedMutation` itself stays
 * deterministic and offline.
 */
export interface MutationAdapter {
  apply(spec: ActionSpec): {
    outcome: "effect-confirmed" | "effect-absent" | "indeterminate";
    observedHash: string;
  };
}

/**
 * The typed result of a guarded execution:
 *   - `executed`             — the effect was confirmed; carries the receipt and
 *                              non-empty evidence refs.
 *   - `blocked`              — a fail-closed gate denied execution; the adapter
 *                              was never called.
 *   - `needs-reconciliation` — the effect's real-world result is ambiguous
 *                              (indeterminate/absent); the receipt's UNKNOWN
 *                              outcome makes W8 `recoverFrom` block an unsafe
 *                              retry.
 */
export type ExecuteOutcome =
  | { kind: "executed"; receipt: ExecutionReceipt; evidenceRefs: string[] }
  | { kind: "blocked"; reason: string }
  | { kind: "needs-reconciliation"; receipt: ExecutionReceipt };

/** Inputs to a single guarded execution. */
export interface ExecuteGuardedMutationInput {
  spec: ActionSpec;
  trustMode: PolicyTrustMode;
  isolationAvailable: boolean;
  guard: GuardOutcome;
  approval: ApprovalCheck;
  adapter: MutationAdapter;
}

/**
 * Injected sources of otherwise-nondeterministic values: `clock` stamps
 * `observedAt`, `idSeq` mints receipt/execution ids. Fixing them makes the
 * receipt fully deterministic.
 */
export interface ExecuteDeps {
  clock: () => string;
  idSeq: () => string;
}

/** The single KNOWN adapter outcome that confirms a clean, recorded effect. */
const CONFIRMED_OUTCOME = "effect-confirmed";

/**
 * The worktree root used only to normalize the fingerprint path. Fixtures use an
 * ABSOLUTE `spec.path`, so `path.resolve(root, absolutePath)` is
 * root-independent (Node path semantics); the fingerprint mirrors the
 * `guardAction` convention of an empty env allowlist.
 */
const FINGERPRINT_WORKTREE_ROOT = "/";

function blocked(reason: string): ExecuteOutcome {
  return { kind: "blocked", reason };
}

/**
 * Execute a guarded mutation fail-closed, then record a schema-valid
 * `ExecutionReceipt`. Every deny gate is evaluated BEFORE the adapter is
 * consulted, so a blocked action never reaches the side-effecting boundary.
 * Deterministic and offline (clock/id injected; no `Date.now`/`Math.random`/
 * network/fs).
 */
export function executeGuardedMutation(
  input: ExecuteGuardedMutationInput,
  deps: ExecuteDeps,
): ExecuteOutcome {
  const { spec, trustMode, isolationAvailable, guard, approval, adapter } = input;

  // 1. Read-only trust mode never mutates — regardless of guard/approval.
  if (trustMode === "read-only") {
    return blocked("Trust mode is read-only; mutation is never permitted.");
  }

  // 2. Fail-closed isolation boundary: an untrusted action must not run
  //    unattended without isolation. No permission prompt can bypass this.
  if (trustMode === "untrusted" && !isolationAvailable) {
    return blocked(
      "Untrusted action requires isolation, which is unavailable; failing closed to block unattended mutation.",
    );
  }

  // 3. Structural guard denial is terminal.
  if (guard.kind === "deny") {
    return blocked(`Structural guard denied the mutation: ${guard.reason}`);
  }

  // 4. Only a fresh, valid single-use approval authorizes execution.
  if (approval.kind !== "valid") {
    return blocked(`Approval is not valid (${approval.reason}); refusing to mutate.`);
  }

  // 5. Structurally clean and authorized — invoke the sole side-effecting
  //    boundary exactly once and record what it observed.
  const applied = adapter.apply(spec);
  const receipt = buildReceipt(spec, applied.outcome, applied.observedHash, deps);

  if (applied.outcome === CONFIRMED_OUTCOME) {
    return { kind: "executed", receipt, evidenceRefs: receipt.evidenceRefs };
  }

  // Ambiguous / absent effect: the receipt's UNKNOWN outcome flows to W8
  // `recoverFrom`, which blocks an unsafe retry until reconciliation.
  return { kind: "needs-reconciliation", receipt };
}

/**
 * Build a schema-valid, deterministic `ExecutionReceipt` for `spec`. `inputHash`
 * is the root-independent action fingerprint; `idempotencyKey` reuses it (a
 * stable 64-char value satisfying the schema's `minLength: 16`); `evidenceRefs`
 * is a non-empty, unique array anchored on the adapter's observed-effect hash.
 */
function buildReceipt(
  spec: ActionSpec,
  outcome: ReturnType<MutationAdapter["apply"]>["outcome"],
  observedHash: string,
  deps: ExecuteDeps,
): ExecutionReceipt {
  const inputHash = actionFingerprint(spec, {
    worktreeRoot: FINGERPRINT_WORKTREE_ROOT,
    envAllowlist: [],
  });

  return {
    schemaVersion: 1,
    receiptId: deps.idSeq(),
    executionId: deps.idSeq(),
    idempotencyKey: inputHash,
    inputHash,
    observedAt: deps.clock(),
    outcome,
    evidenceRefs: [`observed-effect:${observedHash}`],
  };
}
