// Flow 291, AC1/AC2 — spend readers. Pure readers over already-recorded
// artifacts: no gate is re-run, no provider is called, nothing is written
// here (AC5).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { flowsRoot } from "../flow/store";
import { readTriggerRuns } from "../trigger/record";
import type { ManagedReviewManifest } from "../review/types";
import type { FlowReviewSpend, ProjectTriggerSpend } from "./types";

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
 * AC2: project-wide spend from fired triggers. Never flow-attributed —
 * `TriggerRunRecord` (`src/trigger/record.ts`) carries no flow reference, so
 * every run's cost lands in this one project-level figure. An absent ledger
 * is a demonstrated `$0` (nothing has ever fired); an unreadable one reports
 * `unreadable` with the reason rather than guessing.
 */
export async function readProjectTriggerSpend(cwd: string): Promise<ProjectTriggerSpend> {
  const read = await readTriggerRuns(cwd);
  if (read.state === "absent") {
    return { state: "absent" };
  }
  if (read.state === "unreadable") {
    return { state: "unreadable", reason: read.reason };
  }
  let spentUsd = 0;
  let runsWithCostRecorded = 0;
  let runsWithCostNotRecorded = 0;
  for (const record of read.records) {
    if (record.cost.recorded) {
      spentUsd += record.cost.usd;
      runsWithCostRecorded += 1;
    } else {
      runsWithCostNotRecorded += 1;
    }
  }
  return {
    state: "present",
    spentUsd,
    runsWithCostRecorded,
    runsWithCostNotRecorded,
    runsTotal: read.records.length,
  };
}
