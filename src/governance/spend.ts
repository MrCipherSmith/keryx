// Flow 291, AC1/AC2 — spend readers. Pure readers over already-recorded
// artifacts: no gate is re-run, no provider is called, nothing is written
// here (AC5).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { flowsRoot } from "../flow/store";
import { openReservations, readTriggerRuns, type TriggerRunsRead } from "../trigger/record";
import type { ManagedReviewManifest } from "../review/types";
import type { FlowDispatch, FlowDispatchRun, FlowOpenReservation, FlowReviewSpend, ProjectTriggerSpend } from "./types";

/**
 * Every review round manifest recorded under one flow's `reviews/` directory.
 * A manifest that fails to parse is skipped rather than thrown — the same
 * "unreadable evidence, not a crash" discipline `src/health/service.ts`'s
 * `readLatest` applies, because one damaged round must not make the whole
 * report refuse to run.
 */
export async function readFlowReviewManifests(cwd: string, flowDir: string): Promise<ManagedReviewManifest[]> {
  const reviewsDir = path.join(flowsRoot(cwd), flowDir, "reviews");
  if (!(await pathExists(reviewsDir))) {
    return [];
  }
  const entries = (await readdir(reviewsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const manifests: ManagedReviewManifest[] = [];
  for (const entry of entries) {
    const manifestPath = path.join(reviewsDir, entry.name, "manifest.json");
    if (!(await pathExists(manifestPath))) {
      continue;
    }
    try {
      manifests.push(JSON.parse(await readFile(manifestPath, "utf8")) as ManagedReviewManifest);
    } catch {
      // Unreadable/malformed manifest: excluded from the sum, not coerced
      // into a $0 contribution. `roundsTotal` below still counts the
      // directory, so a reader can see the gap rather than a quietly smaller
      // total.
    }
  }
  return manifests;
}

/**
 * AC1: sum a flow's review-round spend. Each figure (`spentUsd`,
 * `inputTokens`, `outputTokens`) is summed only over rounds that reported
 * it, and stays `undefined` — never `0` — when none did. `roundsWithCost`
 * counts rounds whose manifest carries a `cost` object at all, so a reader
 * can see "1 of 3 rounds reported cost" instead of a sum that hides the gap.
 */
export function summarizeReviewSpend(manifests: readonly ManagedReviewManifest[]): FlowReviewSpend {
  let roundsWithCost = 0;
  let spentUsd: number | undefined;
  let roundsWithSpentUsd = 0;
  let inputTokens: number | undefined;
  let roundsWithInputTokens = 0;
  let outputTokens: number | undefined;
  let roundsWithOutputTokens = 0;

  for (const manifest of manifests) {
    const cost = manifest.cost;
    if (cost === undefined) {
      continue;
    }
    roundsWithCost += 1;
    if (typeof cost.spent_usd === "number") {
      spentUsd = (spentUsd ?? 0) + cost.spent_usd;
      roundsWithSpentUsd += 1;
    }
    if (typeof cost.input_tokens === "number") {
      inputTokens = (inputTokens ?? 0) + cost.input_tokens;
      roundsWithInputTokens += 1;
    }
    if (typeof cost.output_tokens === "number") {
      outputTokens = (outputTokens ?? 0) + cost.output_tokens;
      roundsWithOutputTokens += 1;
    }
  }

  return {
    roundsTotal: manifests.length,
    roundsWithCost,
    spentUsd,
    roundsWithSpentUsd,
    inputTokens,
    roundsWithInputTokens,
    outputTokens,
    roundsWithOutputTokens,
  };
}

/**
 * AC2: project-wide spend from fired triggers — the project's TRUE total,
 * every run's cost, whether or not that run named a flow. Some of these runs
 * (flow 297: `TriggerDispatchRecord.flow`) are ALSO shown individually under
 * their flow's own `dispatch.spend` (`collectFlowDispatch` below) —
 * `attributedToFlowsUsd` says how much of this total that is, so a reader
 * never has to (wrongly) add the two together to find out. An absent ledger
 * is a demonstrated `$0` (nothing has ever fired); an unreadable one reports
 * `unreadable` with the reason rather than guessing.
 */
export async function readProjectTriggerSpend(cwd: string): Promise<ProjectTriggerSpend> {
  return summarizeProjectTriggerSpend(await readTriggerRuns(cwd));
}

/** Pure half of `readProjectTriggerSpend` — split out so `collectProjectGovernance` reads the ledger once and shares it with the per-flow dispatch view below (AC5: still read-only, just one read). */
export function summarizeProjectTriggerSpend(read: TriggerRunsRead): ProjectTriggerSpend {
  if (read.state === "absent") {
    return { state: "absent" };
  }
  if (read.state === "unreadable") {
    return { state: "unreadable", reason: read.reason };
  }
  let spentUsd = 0;
  let runsWithCostRecorded = 0;
  let runsWithCostNotRecorded = 0;
  // The SAME "closing record named a flow" test `collectFlowDispatch` uses
  // per flow, applied project-wide — so this subset always equals the sum of
  // every flow's own `dispatch.spend.spentUsd` (never drifts out of sync).
  let attributedToFlowsUsd: number | undefined;
  let runsTotal = 0;
  const open = new Set(openReservations(read.records).map((r) => r.runId));
  for (const record of read.records) {
    // Flow 300 review F3: a `reserved` record is the spend HOLD a dispatch
    // writes before its first model call, not a run. Once the run's own
    // closing record (same `dispatch.runId`) — or, for a killed run, the
    // operator's `reservation-resolved` — exists, THAT record is the run and
    // carries its cost; counting the hold as well put every dispatch into "not
    // recorded" even when its closing record had a cost. A hold nothing has
    // closed yet (in flight, or killed and unresolved) is still a run whose
    // cost is not recorded, and stays counted as one.
    if (record.outcome === "reserved" && !(record.reservation !== undefined && open.has(record.reservation.runId))) continue;
    runsTotal += 1;
    if (record.cost.recorded) {
      spentUsd += record.cost.usd;
      runsWithCostRecorded += 1;
      if (record.dispatch?.flow !== undefined) {
        attributedToFlowsUsd = (attributedToFlowsUsd ?? 0) + record.cost.usd;
      }
    } else {
      runsWithCostNotRecorded += 1;
    }
  }
  return {
    state: "present",
    spentUsd,
    runsWithCostRecorded,
    runsWithCostNotRecorded,
    runsTotal,
    attributedToFlowsUsd,
  };
}

/**
 * Flow 297 (AC1, AC2): one flow's slice of the same trigger ledger — every
 * CLOSING record (`outcome !== "reserved"`) whose `dispatch.flow` names this
 * flow, plus every reservation still open for it. A record with no `dispatch`
 * at all (every non-`flow-next` trigger action, and every record written
 * before flow 290) never matches any flow and stays out of this view — it is
 * still counted in the project-wide `ProjectTriggerSpend` above, exactly as
 * before this change.
 *
 * The runs counted here are a SLICE of `ProjectTriggerSpend`, not an addition
 * to it — every one of them is already inside that total, and inside its own
 * `attributedToFlowsUsd`. That is what `FlowDispatchSpend.includedInProjectTriggerSpend`
 * states explicitly, so a caller reading only this function's output still
 * knows not to add its `spentUsd` onto the project's.
 *
 * One ledger line is one fact, never double-counted: a completed dispatch run
 * writes a "reserved" line and then exactly one closing line for the same
 * `runId` — only the closing line becomes a `FlowDispatchRun` here (its cost
 * supersedes the reservation). A KILLED run has only the "reserved" line, no
 * closing one — `openReservations()` is what surfaces that, as "reserved, not
 * spent", never folded into `spentUsd`.
 */
export function collectFlowDispatch(read: TriggerRunsRead, flowId: string): FlowDispatch {
  if (read.state === "absent") {
    return { state: "absent" };
  }
  if (read.state === "unreadable") {
    return { state: "unreadable", reason: read.reason };
  }

  const runs: FlowDispatchRun[] = read.records
    .filter((record) => record.outcome !== "reserved" && record.dispatch?.flow === flowId)
    .map((record) => ({
      runId: record.dispatch!.runId,
      trigger: record.trigger,
      at: record.at,
      task: record.dispatch!.task,
      outcome: record.outcome,
      cost: record.cost,
      denials: record.dispatch!.denials ?? [],
    }));

  let spentUsd: number | undefined;
  let runsWithCostRecorded = 0;
  let runsWithCostNotRecorded = 0;
  for (const run of runs) {
    if (run.cost.recorded) {
      spentUsd = (spentUsd ?? 0) + run.cost.usd;
      runsWithCostRecorded += 1;
    } else {
      runsWithCostNotRecorded += 1;
    }
  }

  const openForFlow = openReservations(read.records).filter((reservation) => reservation.flow === flowId);
  const openReservationsOut: FlowOpenReservation[] = openForFlow.map((reservation) => ({
    runId: reservation.runId,
    trigger: reservation.trigger,
    at: reservation.at,
    usd: reservation.usd,
  }));
  const openReservedUsd = openForFlow.reduce((sum, reservation) => sum + reservation.usd, 0);

  return {
    state: "present",
    spend: {
      runsTotal: runs.length + openForFlow.length,
      spentUsd,
      runsWithCostRecorded,
      runsWithCostNotRecorded,
      openReservedUsd,
      // Always true: every run counted above is also part of
      // `ProjectTriggerSpend.spentUsd` (and its `attributedToFlowsUsd`
      // subset) — this flow's `spentUsd` is a slice of the project total,
      // never an addition to it.
      includedInProjectTriggerSpend: true,
    },
    runs,
    openReservations: openReservationsOut,
  };
}
