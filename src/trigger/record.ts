// Flow 286 T8, AC4: "Every fired trigger is recorded — what fired it, when,
// what it did, and what it cost when a model was used — and `keryx trigger
// status` reads that record rather than re-deriving it."
//
// HOUSE STYLE, and why: this borrows `src/forgetting/journal.ts`'s shape
// wholesale rather than inventing a fourth durable-record pattern —
//
//   1. SEPARATE TREE, append-only JSONL (`.metaproject/data/trigger/runs.jsonl`,
//      next to `../trigger/run.ts`'s own `.run.lock` under the same
//      `data/trigger/` directory — the lock and the record of what the lock
//      gated belong together). There is no function here that rewrites the
//      file; a caller that wants to shorten this history has to do it with
//      something that is not this API, exactly like the deletion journal.
//   2. `appendFile` (O_APPEND), no locking layer of its own — the SAME choice
//      `appendDeletionRecord` makes, and for the same reason: a single
//      `write()` of one short JSON line is atomic under O_APPEND on every
//      platform this project ships to, which is what "survives concurrent
//      writers" asks for here, not a second lock on top of the one
//      `withTriggerRunLock` already takes for the ACTION itself.
//      `record.test.ts` proves this with real concurrent appends, and
//      `../commands/trigger-run.e2e.test.ts`'s AC3 race is the sharper
//      version: two real `keryx trigger run` processes, one of which is
//      REFUSED BY THE LOCK — and the dispatch instruction is explicit that a
//      lock refusal is itself an outcome worth recording, so both processes
//      append a record for the SAME `at`-adjacent instant, from two real OS
//      processes, and both records must land intact.
//   3. Read returns `"absent" | "present" | "unreadable"`, never collapsing
//      "nothing was ever fired" into "the record could not be read" — the
//      same discipline `readDeletionJournal` applies, for the same reason: a
//      reader shown `[]` for both concludes nothing ever fired when the
//      truth might be "the file is there and this read failed".
//
// WHAT COUNTS AS "FIRED" (a decision this file makes, stated rather than
// buried in the call site): only a `keryx trigger run <name>` that RESOLVED
// to a concrete, declared entry — `disabled` or `ready` in
// `resolveTriggerForRun`'s vocabulary (`./run.ts`) — is recorded here. A
// `config-absent`, `config-broken`, `unknown-name` or `rejected` (malformed)
// outcome never reaches a concrete `TriggerEntry`: there is no `action` to
// say "what it did" about, because nothing tied to a real entry was ever
// asked to run. Those four remain what they already are — a stderr line and
// an exit code — and are not represented as a fired-trigger record with a
// fabricated or absent `action`. This mirrors `DeletionRecord` never
// recording a layer it never examined: an absent fact is left absent, not
// padded to fit the shape.

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "../lib/fs";
import type { TriggerAction, TriggerFire } from "./config";

export const TRIGGER_RUN_RECORD_VERSION = 1;

export function triggerDataDir(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "trigger");
}

export function triggerRunsPath(projectRoot: string): string {
  return path.join(triggerDataDir(projectRoot), "runs.jsonl");
}

/**
 * What a fired trigger's run is classified as. Required (dispatch
 * instruction, T8): distinguish "did the work" (`ok`), "nothing to do"
 * (`no-op` — a disabled entry, or an action not implemented in this build),
 * "refused by the lock" (`lock-refused`), and "failed" (the action itself
 * errored). `budget-refused` is reserved room, not yet produced by anything
 * in this dispatch: T11 (`open-flow`/`flow-next`, AC8) is what calls
 * `evaluateSpendCap` and can actually refuse a run over the spend ceiling —
 * this type exists now so T11 records that outcome as a first-class kind
 * from day one rather than needing a schema change to add it, per the T5
 * survey's own note that a budget refusal "must not look like a crash".
 */
//
// Flow 290 (AC3): `dispatch-refused` — a dispatching `flow-next` declined to
// start an agent (flow not frozen/in progress, nothing ready, an open attempt,
// the attempt cap, or another dispatch on the same flow). Distinct from
// `no-op` so an operator can tell "there was nothing to do" from "there was
// work and the dispatcher would not touch it"; the precise cause is in
// `dispatch.refusal`.
//
// Flow 290 T13 (AC14): `reserved` — a dispatch's spend reservation, written
// under the project-wide spend lock BEFORE its first model call and closed by
// the run's own final record (same `dispatch.runId`). A reservation with no
// closing record — a killed run — keeps counting against both ceilings until an
// operator closes it with `keryx trigger resolve <runId> --spent <usd>`, which
// writes `reservation-resolved`.
export const TRIGGER_RUN_OUTCOME_KINDS = [
  "ok",
  "no-op",
  "lock-refused",
  "failed",
  "budget-refused",
  "dispatch-refused",
  "reserved",
  "reservation-resolved",
] as const;
export type TriggerRunOutcomeKind = (typeof TRIGGER_RUN_OUTCOME_KINDS)[number];

/**
 * What a fired trigger's run cost, and how well that is known — mirrors
 * `../forgetting/journal.ts`'s `Attribution` shape (a value plus the basis on
 * which it is known) for the identical reason: "no model was called" and "a
 * model was called but nothing recorded the cost" are different facts, and a
 * reader of `keryx trigger status` must be able to tell which one a record is
 * reporting rather than seeing an absent cost either way.
 */
export type TriggerRunCost =
  | { readonly recorded: true; readonly usd: number; readonly tokens?: TriggerRunTokens }
  | { readonly recorded: false; readonly reason: string; readonly tokens?: TriggerRunTokens };

/**
 * Flow 290 (AC6): the provider-reported token counts behind a cost. Additive
 * and optional — every record written before flow 290 has none and still
 * reads. A dispatched run always records these, even when it failed or was
 * stopped, because a stopped run still consumed them.
 */
export interface TriggerRunTokens {
  readonly input: number;
  readonly output: number;
}

/** Flow 290 (AC3): why a dispatching `flow-next` declined to start an agent. */
export const DISPATCH_REFUSAL_CODES = [
  "flow-not-in-progress",
  "flow-not-frozen",
  "nothing-ready",
  "blocked",
  "open-attempt",
  "attempt-cap",
  "dispatch-locked",
  "sandbox-unavailable",
  "provider-usage-unknown",
  "worktree-conflict",
] as const;
export type DispatchRefusalCode = (typeof DISPATCH_REFUSAL_CODES)[number];

/** Flow 290 (AC4): one call the unattended run refused rather than ask about. */
export interface UnattendedDenial {
  readonly tool: string;
  readonly reason: string;
}

/** Flow 290: what a dispatching `flow-next` did, beside the generic record fields. Additive. */
export interface TriggerDispatchRecord {
  readonly runId: string;
  readonly flow: string;
  readonly task?: string;
  readonly attempt?: number;
  readonly branch?: string;
  readonly refusal?: DispatchRefusalCode;
  /** The closing fact written to the flow: `done` or the attempt outcome. */
  readonly closing?: "done" | "failed" | "blocked";
  readonly denials?: readonly UnattendedDenial[];
}

export const NO_MODEL_COST: TriggerRunCost = {
  recorded: false,
  reason: "this action does not call a model — reconcile/rebuild are deterministic, no spend to record",
};

/** One fired-trigger record. */
export interface TriggerRunRecord {
  readonly v: number;
  /** When this pass finished (ISO-8601) — the record is written once the outcome is known, not when the run started. */
  readonly at: string;
  /** The entry's own name — `keryx trigger run <name>`'s argument. */
  readonly trigger: string;
  /** What fired it, as declared in the trigger's config entry (an event name, or the cron/schedule spec). */
  readonly firedBy: TriggerFire;
  /** What it did, as declared in the trigger's config entry. */
  readonly action: TriggerAction;
  readonly outcome: TriggerRunOutcomeKind;
  /** Human-readable explanation. Never empty — mirrors every other "never silent" convention in this codebase. */
  readonly detail: string;
  readonly cost: TriggerRunCost;
  /** Flow 290: present only on a dispatching `flow-next` run. */
  readonly dispatch?: TriggerDispatchRecord;
  /** Flow 290 T13: on a `reserved` record — the amount held back for run `runId`. */
  readonly reservation?: { readonly runId: string; readonly usd: number };
  /** Flow 290 T13: on a `reservation-resolved` record — the run whose reservation an operator closed. */
  readonly resolves?: string;
}

/** A reservation no final record has closed yet. */
export interface OpenReservation {
  readonly runId: string;
  readonly trigger: string;
  readonly usd: number;
  readonly at: string;
}

/** Every reservation in `records` that neither the run's own record nor an operator resolution has closed. */
export function openReservations(records: readonly TriggerRunRecord[]): OpenReservation[] {
  const open = new Map<string, OpenReservation>();
  for (const record of records) {
    if (record.outcome === "reserved" && record.reservation !== undefined) {
      open.set(record.reservation.runId, {
        runId: record.reservation.runId,
        trigger: record.trigger,
        usd: record.reservation.usd,
        at: record.at,
      });
      continue;
    }
    const closes = record.resolves ?? record.dispatch?.runId;
    if (closes !== undefined) open.delete(closes);
  }
  return [...open.values()];
}

export type TriggerRunAppend =
  | { readonly status: "appended"; readonly path: string; readonly record: TriggerRunRecord }
  | { readonly status: "failed"; readonly path: string; readonly reason: string };

/**
 * Append one fired-trigger record. The only write in this module — see the
 * file header for why there is no counterpart that rewrites the file.
 */
export async function appendTriggerRunRecord(
  projectRoot: string,
  record: Omit<TriggerRunRecord, "v">,
): Promise<TriggerRunAppend> {
  const file = triggerRunsPath(projectRoot);
  const full: TriggerRunRecord = { v: TRIGGER_RUN_RECORD_VERSION, ...record };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(full)}\n`, "utf8");
    return { status: "appended", path: file, record: full };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      path: file,
      reason:
        `the trigger run record could not be appended (${message}). The run's own outcome above is still what ` +
        "happened — this failure is only about the record of it, and it must not be reported as recorded.",
    };
  }
}

export type TriggerRunsRead =
  | { readonly state: "absent"; readonly path: string }
  | { readonly state: "present"; readonly path: string; readonly records: readonly TriggerRunRecord[] }
  | { readonly state: "unreadable"; readonly path: string; readonly reason: string };

/**
 * Read every fired-trigger record. A line that will not parse makes the whole
 * read `"unreadable"` rather than being silently dropped — reporting a
 * truncated history as the complete one is the defect `readDeletionJournal`
 * already refuses to repeat, and this mirrors it.
 */
export async function readTriggerRuns(projectRoot: string): Promise<TriggerRunsRead> {
  const file = triggerRunsPath(projectRoot);
  try {
    await stat(file);
  } catch (error) {
    if (isNotFound(error)) return { state: "absent", path: file };
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "unreadable",
      path: file,
      reason: `the trigger run record could not be examined (${message}). This is not the same as "nothing has ever fired".`,
    };
  }

  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "unreadable",
      path: file,
      reason: `the trigger run record exists but could not be read (${message}). Its records are on disk, not absent.`,
    };
  }

  const records: TriggerRunRecord[] = [];
  let damaged = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = parseRecord(trimmed);
    if (parsed) records.push(parsed);
    else damaged += 1;
  }
  if (damaged > 0) {
    return {
      state: "unreadable",
      path: file,
      reason:
        `the trigger run record holds ${damaged} line${damaged === 1 ? "" : "s"} that could not be parsed. ` +
        "The readable remainder is not reported as the whole history.",
    };
  }
  return { state: "present", path: file, records };
}

/** The most recent record for each trigger name, in the file's own order (last occurrence wins). */
export function latestRunByTrigger(records: readonly TriggerRunRecord[]): Map<string, TriggerRunRecord> {
  const latest = new Map<string, TriggerRunRecord>();
  for (const record of records) latest.set(record.trigger, record);
  return latest;
}

function parseRecord(line: string): TriggerRunRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["at"] !== "string" || typeof raw["trigger"] !== "string" || typeof raw["outcome"] !== "string") {
    return null;
  }
  return raw as unknown as TriggerRunRecord;
}
