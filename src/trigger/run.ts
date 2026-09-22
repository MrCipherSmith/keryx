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
import {
  loadTriggersConfig,
  type TriggerEntry,
  type TriggersFileProblem,
} from "./config";

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
