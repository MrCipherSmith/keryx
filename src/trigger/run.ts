// Flow 286 T7: `keryx trigger run <name>` — resolution + locking.
//
// This module is deliberately CORE zone (`src/lib/import-zones.ts`: `{
// segment: "trigger", zone: "core" }`), same as `./config.ts`. Core may never
// import client/adapter code (`src/lib/import-policy.ts`, "owner-imports-
// client" — enforced at zero, no exception). That is why the actual dispatch
// to `keryx sync --apply` / `keryx gdgraph build` (both `src/commands/**`,
// adapter zone) does NOT live here: it lives in `../commands/trigger.ts`,
// which imports this module (core) plus `./sync`/`./gdgraph` (adapter->
// adapter, unrestricted) and wires the two together. This file only ever
// decides WHICH entry to run and WHETHER the caller may proceed (lock); it
// never performs an action itself.

import path from "node:path";
import { withFileLock } from "../lib/fs";
import { evaluateSpendCap, type SpendCapEvaluation, type SpendCapOptions } from "../review/caps";
import {
  loadTriggersConfig,
  type TriggerEntry,
  type TriggersFileProblem,
} from "./config";
import { readTriggerRuns } from "./record";

// ---------------------------------------------------------------------------
// Resolution — "which entry does `<name>` mean, and can a run proceed at all"
// ---------------------------------------------------------------------------

export type TriggerResolution =
  | { readonly kind: "config-absent" }
  | { readonly kind: "config-broken"; readonly fileProblem: Exclude<TriggersFileProblem, "absent"> }
  | { readonly kind: "unknown-name"; readonly known: readonly string[] }
  | { readonly kind: "rejected"; readonly reasons: readonly string[] }
  | { readonly kind: "disabled"; readonly entry: TriggerEntry }
  | { readonly kind: "ready"; readonly entry: TriggerEntry };

/**
 * Resolve `name` against the project's trigger config for a `keryx trigger
 * run <name>` invocation. Pure and total — never throws, mirrors
 * `loadTriggersConfig`'s own "never throws" contract.
 *
 * AC2 ("a run with nothing to do exits zero") vs. a real problem: this
 * function only classifies; `../commands/trigger.ts` is what turns each kind
 * into an exit code, and it draws that line as: an absent config file or a
 * disabled entry is "nothing to do" (exit 0) — the operator/scheduler asked
 * for nothing and got nothing done, honestly. A BROKEN config file, an
 * unknown name, or a rejected (malformed) entry all mean the operator's own
 * setup cannot answer "what should run" at all, which is not "nothing to
 * do" — it is refused loudly (non-zero), the same way `flow task done` on an
 * unknown task id throws rather than silently no-opping.
 */
export function resolveTriggerForRun(projectRoot: string, name: string): TriggerResolution {
  const loaded = loadTriggersConfig(projectRoot);

  if (loaded.fileProblem === "absent") {
    return { kind: "config-absent" };
  }
  if (loaded.fileProblem !== undefined) {
    return { kind: "config-broken", fileProblem: loaded.fileProblem };
  }

  const entry = loaded.triggers.find((candidate) => candidate.name === name);
  if (entry !== undefined) {
    return entry.enabled ? { kind: "ready", entry } : { kind: "disabled", entry };
  }

  const rejected = loaded.rejected.find((candidate) => candidate.name === name);
  if (rejected !== undefined) {
    return { kind: "rejected", reasons: rejected.reasons };
  }

  return { kind: "unknown-name", known: loaded.triggers.map((candidate) => candidate.name) };
}

// ---------------------------------------------------------------------------
// Locking (AC3)
// ---------------------------------------------------------------------------
//
// DECISION (recorded in the flow's journal.md as `- note (implementer):`):
// a second concurrent `trigger run` REFUSES immediately rather than waiting.
// `withFileLock`'s own retry loop is reused with `timeoutMs: 0` — one mkdir
// attempt (with `removeStaleLock`'s ordinary stale-reclaim still consulted,
// so a lock abandoned by a killed process is still recovered), and on
// contention it fails over into the documented `"Timed out waiting for
// lock: …"` error immediately rather than retrying. That message is the
// established way this codebase distinguishes "lock contention" from any
// other failure a locked section can throw — see
// `src/lib/routing-entrypoint.test.ts`'s own assertion on the same string.
//
// `src/gdgraph/` and `src/wiki/` take NO lock at all today (flow 286 T5
// survey, `context.md`); this is the first lock either gets, and it is
// scoped to TRIGGERED runs only, not `keryx sync --apply` / `keryx gdgraph
// build` typed by a person. That is a real, named gap this dispatch leaves
// open on purpose (see the journal note) rather than widening the lock's
// scope beyond what this task was asked to build.

/** One project-scoped lock directory for every triggered run, regardless of which entry fired. */
export function triggerRunLockPath(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "trigger", ".run.lock");
}

const LOCK_TIMEOUT_PREFIX = "Timed out waiting for lock:";

export interface TriggerLockAcquired<T> {
  readonly acquired: true;
  readonly result: T;
}

export interface TriggerLockRefused {
  readonly acquired: false;
  readonly reason: string;
}

export type TriggerLockOutcome<T> = TriggerLockAcquired<T> | TriggerLockRefused;

/**
 * Run `fn` while holding the project's trigger-run lock, or report a refusal
 * when another `trigger run` already holds it. Never throws for lock
 * contention specifically — every OTHER error (including one `fn` itself
 * throws, i.e. the action failing) propagates unchanged, because that is
 * exactly the "action itself failed" case AC2 reserves a non-zero exit for.
 */
export async function withTriggerRunLock<T>(
  projectRoot: string,
  fn: () => Promise<T>,
): Promise<TriggerLockOutcome<T>> {
  try {
    const result = await withFileLock(
      triggerRunLockPath(projectRoot),
      async () => {
        // TEST SEAM, never set in production (mirrors `KERYX_CTX_CLOCK_PIN_MS`
        // in `src/ctx/artifact-id.ts` and `KERYX_GDGRAPH_LOCAL` in
        // `src/commands/gdgraph.ts`): stretches how long THIS run holds the
        // lock once acquired, so a concurrency test can spawn a second real
        // `trigger run` process and deterministically observe it arriving
        // while the first still holds the lock — without stubbing
        // `withFileLock` itself, which is the mechanism under test.
        const holdMs = Number(process.env["KERYX_TRIGGER_RUN_HOLD_MS"] ?? "");
        if (Number.isFinite(holdMs) && holdMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, holdMs));
        }
        return fn();
      },
      { timeoutMs: 0 },
    );
    return { acquired: true, result };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(LOCK_TIMEOUT_PREFIX)) {
      return {
        acquired: false,
        reason:
          "another `keryx trigger run` holds this project's trigger lock — refusing rather than waiting, " +
          "so this run stays exactly one pass (AC2) instead of blocking on another run's schedule. Retry on the next fire.",
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Budget refusal (AC8, T11)
// ---------------------------------------------------------------------------
//
// DECISION (recorded in the flow's journal.md as `- note (implementer):`
// under T11): only the two action kinds that can lead to future model spend —
// `open-flow` (starts a flow that will go on to be worked) and `flow-next`
// (reports work on an already-open flow) — are gated here. `reconcile`
// (`sync --apply`) and `rebuild` (`gdgraph build`) are deterministic
// bookkeeping that never calls a model (T8's `NO_MODEL_COST`), so gating them
// on a spend ceiling would be checking a number that can never move because of
// them; that gate stays scoped to the two action kinds the T5 survey named.
//
// "The configured spend ceiling" (AC8) is `evaluateSpendCap`'s own ceiling
// (`../review/caps.ts`, `DEFAULT_SPEND_CEILING_USD = 3`) — the same one
// `keryx review budget` refuses against. There is no separate trigger-level
// ceiling setting; `.metaproject/triggers.json` (T6) declares WHAT fires and
// WHAT it does, not a budget, and inventing a second ceiling knob here would
// be a second place to configure the same fact.
//
// "Spent" is read from THIS project's own fired-trigger record
// (`./record.ts`, `runs.jsonl`) — the one durable ledger of what triggered
// runs have cost, summed over every record whose `cost.recorded` is `true`,
// across every trigger name and action kind (a project-wide ceiling, not a
// per-trigger one — `keryx review budget`'s own ceiling is per REVIEW ROUND,
// but nothing here is scoped narrower than "this project" the way a round is
// scoped to one PR). A run record file that has never been written (`state:
// "absent"`) means zero fired triggers have ever recorded a cost, which is a
// DEMONSTRATED `0`, not an unknown — `evaluateSpendCap(0, ...)` reports
// `"under"`. A run record file that exists but cannot be READ (`state:
// "unreadable"`) is the one case this reports as `spent: undefined`
// ("not-recorded"): the ledger might say anything, and reporting a guessed `0`
// would be exactly the "coerced to 0" mistake `evaluateSpendCap`'s own doc
// comment refuses to make.
export interface TriggerBudgetAllowed {
  readonly allowed: true;
  readonly evaluation: SpendCapEvaluation;
}
export interface TriggerBudgetRefused {
  readonly allowed: false;
  readonly reason: string;
  readonly evaluation: SpendCapEvaluation;
}
export type TriggerBudgetOutcome = TriggerBudgetAllowed | TriggerBudgetRefused;

/**
 * What this project's fired-trigger record demonstrates about spend. Distinct
 * from `SpendCapEvaluation`'s own tri-state (`under`/`over`/`not-recorded`)
 * because `not-recorded` there is ambiguous about WHY nothing was recorded —
 * "no trigger has ever fired" (an ABSENT ledger, a demonstrated `$0`) and "the
 * ledger exists but a line in it is damaged" (`unreadable`) are different
 * facts with different correct responses (proceed vs. refuse), and
 * `evaluateSpendCap` alone cannot tell them apart from a bare `number |
 * undefined`.
 *
 * REVIEW FIX (finding 3, T15): before this type existed, an `unreadable`
 * ledger collapsed to `spent: undefined`, which `evaluateSpendCap` reports as
 * `not-recorded` with `stop: false` — the SAME shape a project that has never
 * fired a trigger gets. That let a single damaged line in `runs.jsonl` disable
 * AC8's budget refusal silently: `readTriggerRuns` correctly refused to
 * pretend `$0`, but the caller then threw that honesty away. `evaluateSpendCap`
 * itself already gets this right for what it CAN see (`spent === undefined`
 * is never coerced to `0`) — the bug was one level up, in what `spent` was
 * built from.
 */
type RecordedTriggerSpend =
  | { readonly known: true; readonly usd: number }
  | { readonly known: false; readonly reason: string };

/**
 * How much this project's fired-trigger record demonstrates has been spent.
 * An ABSENT record is a demonstrated `$0` (nothing has ever fired, hence
 * recorded, a cost) — an UNREADABLE one is `known: false`, carrying the
 * reason it could not be read, never coerced to a number.
 */
async function recordedTriggerSpend(projectRoot: string): Promise<RecordedTriggerSpend> {
  const read = await readTriggerRuns(projectRoot);
  if (read.state === "absent") return { known: true, usd: 0 };
  if (read.state === "unreadable") return { known: false, reason: read.reason };
  const usd = read.records.reduce((sum, record) => sum + (record.cost.recorded ? record.cost.usd : 0), 0);
  return { known: true, usd };
}

/**
 * Whether an `open-flow`/`flow-next` run may proceed under the project's
 * spend ceiling (AC8). Never throws for the ceiling decision itself.
 *
 * Two distinct refusal paths, not one: an UNREADABLE ledger (finding 3, T15)
 * refuses immediately, before `evaluateSpendCap` is even asked — spend cannot
 * be verified from a ledger that cannot be read, so this treats that the same
 * as "assume the worst" rather than the "assume nothing was spent" that
 * `not-recorded`/`stop: false` would otherwise produce. A DEMONSTRATED spend
 * (an absent ledger's `$0`, or a readable one's sum) goes through
 * `evaluateSpendCap` as before, and every shape it can report there
 * (`under`, `over`) maps to `allowed: true` except `over` — the pre-existing
 * "only the specific refusal condition is caught here" discipline,
 * unchanged for the case the ledger actually answers.
 */
export async function evaluateTriggerBudget(
  projectRoot: string,
  actionKind: string,
  options: SpendCapOptions = {},
): Promise<TriggerBudgetOutcome> {
  const spend = await recordedTriggerSpend(projectRoot);
  if (!spend.known) {
    // A `SpendCapEvaluation` is still produced (unreadable maps to
    // `evaluateSpendCap(undefined, …)`'s own `not-recorded` shape) so
    // `TriggerBudgetOutcome`'s `evaluation` field stays populated for every
    // caller that reads it — but `allowed` is decided HERE, not by
    // `evaluation.stop`, precisely because `not-recorded` alone must not read
    // as "safe to proceed" for this specific cause.
    const evaluation = evaluateSpendCap(undefined, options);
    return {
      allowed: false,
      evaluation,
      reason:
        `this project's fired-trigger run record could not be read (${spend.reason}) — spend cannot be verified ` +
        `against the ${evaluation.currency} ${evaluation.ceiling} spend ceiling, so refusing to start "${actionKind}" ` +
        "rather than proceed on an unknown ledger. Fix or restore `runs.jsonl` (see `keryx trigger status`), then retry.",
    };
  }

  const evaluation = evaluateSpendCap(spend.usd, options);
  if (!evaluation.stop) {
    return { allowed: true, evaluation };
  }
  return {
    allowed: false,
    evaluation,
    reason:
      `this project has $${evaluation.spent} ${evaluation.currency} recorded against a $${evaluation.ceiling} ` +
      `${evaluation.currency} spend ceiling (over by $${evaluation.overBy}) — refusing to start "${actionKind}" ` +
      "rather than risk spending further. Raise the ceiling, or review `keryx trigger status`'s recorded cost, before retrying.",
  };
}
