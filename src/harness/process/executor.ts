// Contained real-subprocess executor (flow 026, T6 / R2-5, reviewer track:
// highload/security).
//
// `runContainedProcess` is the fail-closed, deterministic, OFFLINE decision core
// that fronts a real `node:child_process` subprocess. It closes the RUNTIME half
// of the frozen `SC_R04_SHELL_CONTAINMENT` scenario ("a future shell tool has an
// approved argv and environment allowlist / the process-group command runs /
// timeout, output, cwd, and cancellation controls are enforced").
//
// It REUSES, never re-implements, the prior security primitives:
//   - W10 `guardAction`      — argv shell-injection / traversal / credential /
//                              private-egress deny (structural gate).
//   - W10 `actionFingerprint`— the receipt `inputHash` over the approved
//                              command + env allowlist (the exact primitive the
//                              acceptance scenario names).
//   - W12 `inheritBudget`    — fail-closed deadline bound (child vs parent
//                              remaining runtime).
//   - W8  `ExecutionReceipt` — the schema-valid effect boundary, with the same
//                              outcome convention W10 `execute.ts` uses
//                              (`effect-confirmed` only on a confirmed clean
//                              exit; every ambiguous result is `indeterminate`).
//   - W7  `EvidenceRecord`   — a per-execution, hash-addressed evidence unit.
//
// Every deny gate runs BEFORE the injected `ProcessAdapter` is ever consulted,
// and the adapter is invoked at most once. This module performs NO real spawn,
// fs, or network access — it only consults the adapter's `ProcessObservation`;
// the process-group kill on timeout/cancel is the ADAPTER's responsibility
// (`real-process-adapter.ts`), reported back via `terminationMode`. Deterministic
// and offline: `clock`/`idSeq` arrive via `deps`; there is NO `Date.now`,
// `Math.random`, `new Date`, network, or filesystem here. It NEVER writes flow
// state (D-02) and never logs/persists `command.env` values.
import type { BudgetReservation, ParentRemainingBudget } from "../child/isolation";
import { inheritBudget } from "../child/isolation";
import type { EvidenceRecord } from "../evidence/types";
import { actionFingerprint } from "../mutation/fingerprint";
import type { ActionSpec } from "../mutation/fingerprint";
import { guardAction } from "../mutation/guard";
import type { GuardInput } from "../mutation/guard";
import type { PolicyProfile } from "../policy/types";
import type { ExecutionReceipt } from "../resume/recovery";
import type { ToolRisk } from "../tool/types";

/**
 * An approved, contained command. Reuses/extends {@link ActionSpec}
 * (`path`/`argv`/`env`) with the approved working directory `cwd` the adapter
 * spawns in. Passed verbatim to `adapter.spawn` — including `cwd`.
 */
export interface ContainedCommand {
  path: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * The scripted/observed disposition of one contained process. A REAL adapter
 * computes this by actually enforcing the deadline + output byte-limit and
 * reporting what it observed; the offline FAKE returns a scripted value. The
 * observation ALONE drives classification — `runContainedProcess` never re-times
 * or re-measures anything.
 */
export type ProcessObservationKind =
  | "clean-exit"
  | "deadline-exceeded"
  | "output-overflow"
  | "cancelled"
  | "spawn-error";

/** What the adapter observed about a single spawned process. */
export interface ProcessObservation {
  kind: ProcessObservationKind;
  exitCode?: number;
  outputBytes?: number;
  /** How the adapter terminated the process, when it had to (no-orphan proof). */
  terminationMode?: "process-group" | "leader-only" | "none";
  /** Lowercase sha-256 hex of the observed (redacted) output. */
  observedHash: string;
  errorMessage?: string;
}

/**
 * The single side-effecting boundary. `spawn` starts the approved command in its
 * approved `cwd` and reports what it observed. Injected (a fake in the offline
 * suite), so `runContainedProcess` itself stays deterministic and offline.
 */
export interface ProcessAdapter {
  spawn(command: ContainedCommand): ProcessObservation;
}

/**
 * The typed result of a contained execution:
 *   - `completed`       — a confirmed, in-bounds clean exit (receipt
 *                         `effect-confirmed`, non-empty evidence refs).
 *   - `timeout`         — the reserved deadline was exceeded (receipt
 *                         `indeterminate`); NOT a success.
 *   - `output-overflow` — output exceeded the byte limit (receipt
 *                         `indeterminate`); terminal, no unbounded retry.
 *   - `cancelled`       — an external cancel signal / observed cancel (receipt
 *                         `indeterminate`); NOT a success.
 *   - `blocked`         — a fail-closed gate denied the run (or the spawn itself
 *                         errored, so no effect boundary exists); carries only a
 *                         reason, NO receipt (mirrors `executeGuardedMutation`).
 */
export type ContainedProcessOutcome =
  | {
      kind: "completed";
      receipt: ExecutionReceipt;
      evidenceRefs: string[];
      evidence: EvidenceRecord;
      exitCode?: number;
    }
  | { kind: "timeout"; receipt: ExecutionReceipt }
  | { kind: "output-overflow"; receipt: ExecutionReceipt }
  | { kind: "cancelled"; receipt: ExecutionReceipt }
  | { kind: "blocked"; reason: string };

/**
 * The approval surface for a contained command. Bundles everything W10
 * `guardAction` needs PLUS the additive `envAllowlist` this module itself
 * enforces (an env key present on `command.env` but absent from `envAllowlist`
 * is blocked before spawn — `guardAction` has no env-allowlist concept).
 */
export interface RunContainedProcessInput {
  command: ContainedCommand;
  allowlist: {
    worktreeRoot: string;
    envAllowlist: string[];
    profile: PolicyProfile;
    interactive: boolean;
    scanAvailable: boolean;
    risk: ToolRisk;
    resolveSymlink?: (p: string) => string;
  };
  budget: BudgetReservation;
  parentRemaining: ParentRemainingBudget;
  outputLimitBytes: number;
  cancelled?: boolean;
  adapter: ProcessAdapter;
  /**
   * Optional caller-known causal identifiers (review-polish item A). When
   * present, `buildEvidence` stamps them onto `EvidenceRecord.causal.runId`/
   * `sessionId`/`correlationId` INSTEAD OF minting fresh `deps.idSeq()` values,
   * so the built evidence correlates back to the run/session it belongs to. When
   * absent, the current `deps.idSeq()` fallback is used (existing callers
   * unaffected).
   */
  runId?: string;
  sessionId?: string;
  correlationId?: string;
}

/**
 * Injected sources of otherwise-nondeterministic values: `idSeq` mints
 * receipt/execution/evidence ids; `clock` stamps `observedAt`/`recordedAt`.
 * Fixing them makes every outcome fully deterministic.
 */
export interface RunContainedProcessDeps {
  idSeq: () => string;
  clock: () => string;
}

/** The single outcome value that confirms a clean, in-bounds effect. */
const CONFIRMED_OUTCOME = "effect-confirmed";
/** Every ambiguous (killed/truncated/cancelled) effect records this instead. */
const INDETERMINATE_OUTCOME = "indeterminate";

function blocked(reason: string): ContainedProcessOutcome {
  return { kind: "blocked", reason };
}

/** Project a {@link ContainedCommand} onto the {@link ActionSpec} fingerprint/guard surface. */
function toActionSpec(command: ContainedCommand): ActionSpec {
  return { path: command.path, argv: command.argv, env: command.env };
}

/**
 * Build a schema-valid, deterministic {@link EvidenceRecord} anchored on the
 * adapter's observed-effect hash (mirrors `childResultToEvidence`'s shape). No
 * `command.env` value ever reaches the record.
 */
function buildEvidence(
  observation: ProcessObservation,
  input: RunContainedProcessInput,
  deps: RunContainedProcessDeps,
): EvidenceRecord {
  return {
    schemaVersion: 1,
    evidenceId: deps.idSeq(),
    causal: {
      // Reuse caller-known causal ids when supplied (review-polish item A),
      // otherwise fall back to the injected id source (existing callers). An
      // empty string is treated as absent so `causal.*` never violates the
      // schema's non-empty `id` constraint.
      runId: input.runId || deps.idSeq(),
      sessionId: input.sessionId || deps.idSeq(),
      correlationId: input.correlationId || deps.idSeq(),
    },
    kind: "receipt",
    artifact: {
      artifactId: deps.idSeq(),
      kind: `contained-process:${observation.kind}`,
      hash: observation.observedHash,
    },
    provenance: {
      provenanceId: deps.idSeq(),
      trustLevel: "derived",
      sourceKind: "contained-process",
    },
    recordedAt: deps.clock(),
  };
}

/**
 * Build a schema-valid, deterministic {@link ExecutionReceipt}. `inputHash` is
 * the W10 action fingerprint over the APPROVED command + env allowlist (reuses
 * `actionFingerprint`), and `idempotencyKey` reuses it (a stable 64-char value
 * satisfying `minLength: 16`). `evidenceRefs` is a non-empty, unique array
 * linking the per-execution evidence record and the observed-effect hash.
 */
function buildReceipt(
  command: ContainedCommand,
  allowlist: RunContainedProcessInput["allowlist"],
  outcome: string,
  observation: ProcessObservation,
  evidence: EvidenceRecord,
  deps: RunContainedProcessDeps,
): ExecutionReceipt {
  const inputHash = actionFingerprint(toActionSpec(command), {
    worktreeRoot: allowlist.worktreeRoot,
    envAllowlist: allowlist.envAllowlist,
  });

  return {
    schemaVersion: 1,
    receiptId: deps.idSeq(),
    executionId: deps.idSeq(),
    idempotencyKey: inputHash,
    inputHash,
    observedAt: deps.clock(),
    outcome,
    evidenceRefs: [`evidence:${evidence.evidenceId}`, `observed-effect:${observation.observedHash}`],
  };
}

/**
 * Run one contained command, fail-closed.
 *
 * Gate order (every deny gate runs BEFORE the adapter is ever consulted, and the
 * adapter is invoked at most once):
 *   1. `guardAction` deny (argv shell-injection / traversal / symlink escape /
 *      credential / private egress) -> blocked.
 *   2. an env key on `command.env` not in `allowlist.envAllowlist` -> blocked.
 *   3. `inheritBudget(parentRemaining, budget)` not-ok -> blocked.
 * Only then is `adapter.spawn(command)` invoked exactly once, and the returned
 * {@link ProcessObservation} is classified into a typed outcome — never a false
 * `completed`. Deterministic and offline (clock/id injected; no `Date.now`/
 * `Math.random`/network/fs; no real spawn here).
 */
export function runContainedProcess(
  input: RunContainedProcessInput,
  deps: RunContainedProcessDeps,
): ContainedProcessOutcome {
  const { command, allowlist, budget, parentRemaining, outputLimitBytes, adapter } = input;

  // 1. Structural argv/path guard — reuse the W10 fail-closed gate verbatim.
  const guardInput: GuardInput = {
    spec: toActionSpec(command),
    worktreeRoot: allowlist.worktreeRoot,
    profile: allowlist.profile,
    interactive: allowlist.interactive,
    scanAvailable: allowlist.scanAvailable,
    risk: allowlist.risk,
    ...(allowlist.resolveSymlink !== undefined ? { resolveSymlink: allowlist.resolveSymlink } : {}),
  };
  const guard = guardAction(guardInput, { clock: deps.clock, idSeq: deps.idSeq });
  if (guard.kind === "deny") {
    return blocked(`Structural guard denied the contained command: ${guard.reason}`);
  }

  // 2. Environment allowlist — any key not explicitly approved is denied before
  //    spawn (guardAction has no env-allowlist concept of its own). Never log the
  //    value; only the offending key name is surfaced.
  for (const key of Object.keys(command.env)) {
    if (!allowlist.envAllowlist.includes(key)) {
      return blocked(`Environment variable "${key}" is not in the approved env allowlist; failing closed.`);
    }
  }

  // 3. Deadline bound — reuse W12 fail-closed budget inheritance.
  const bounded = inheritBudget(parentRemaining, budget);
  if (!bounded.ok) {
    return blocked(`Budget inheritance denied the contained command: ${bounded.reason}`);
  }

  // Structurally clean, env-approved, and within budget — invoke the sole
  // side-effecting boundary exactly once, with the approved command (incl. cwd).
  const observation = adapter.spawn(command);

  // 4. Classify the observation into a typed outcome — fail-closed, never a
  //    false `completed`.
  //
  // A spawn that errored produced no effect boundary at all, so it carries no
  // receipt (mirrors the `blocked` variant): terminal, non-success.
  if (observation.kind === "spawn-error") {
    return blocked(`Contained spawn failed: ${observation.errorMessage ?? "unknown spawn error"}`);
  }

  const evidence = buildEvidence(observation, input, deps);

  if (observation.kind === "deadline-exceeded") {
    return {
      kind: "timeout",
      receipt: buildReceipt(command, allowlist, INDETERMINATE_OUTCOME, observation, evidence, deps),
    };
  }

  const overflowed =
    observation.kind === "output-overflow" ||
    (observation.outputBytes !== undefined && observation.outputBytes > outputLimitBytes);
  if (overflowed) {
    return {
      kind: "output-overflow",
      receipt: buildReceipt(command, allowlist, INDETERMINATE_OUTCOME, observation, evidence, deps),
    };
  }

  if (observation.kind === "cancelled" || input.cancelled === true) {
    return {
      kind: "cancelled",
      receipt: buildReceipt(command, allowlist, INDETERMINATE_OUTCOME, observation, evidence, deps),
    };
  }

  if (observation.kind === "clean-exit") {
    const receipt = buildReceipt(command, allowlist, CONFIRMED_OUTCOME, observation, evidence, deps);
    // Surface the observation's real exitCode onto the outcome (review-hardening
    // fix #2). Conditional spread for `exactOptionalPropertyTypes`: only include
    // `exitCode` when the observation carries one. The classification is
    // UNCHANGED — a non-zero in-bounds exit is still `completed` (containment).
    // `evidenceRefs` uses the SAME `evidence:`-prefixed encoding as the receipt's
    // own `evidenceRefs` (review-polish item F), and the built evidence record is
    // surfaced on the outcome so its causal ids are inspectable (item A).
    return {
      kind: "completed",
      receipt,
      evidenceRefs: [`evidence:${evidence.evidenceId}`],
      evidence,
      ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
    };
  }

  // Unknown/ambiguous observation — fail closed, never report completed.
  return blocked(`Unclassifiable contained-process observation "${observation.kind}"; failing closed.`);
}
