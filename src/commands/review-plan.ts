// `keryx review plan` (flow 458, AC8): the round plan in one command. It runs start (with round detection), scope,
// blast-radius, slice, required and estimate, writes <package>/plan.json and prints a short summary. It never dispatches.
// Each step is the real subcommand (`run` re-enters the review command, so flags and refusals are the ones the steps have
// on their own); only the plan's own reading of their results lives here.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { writeFileAtomic } from "../lib/fs";
import { estimatePackage, planConfirmed, type RoundEstimate, CONFIRM_PLAN_TOOL } from "../review/estimate";
import { readPriorFindings, readRoundRecord, renderRoundLine, type RoundRecord } from "../review/round-record";
import { isDeltaRound } from "../review/round-split";
import type { SliceEntry, SliceManifest } from "../review/slice";
import { REVIEW_HOSTS } from "../review/host-profile";
import { packageReviewers, writeWaveDrivers } from "../review/wave-drivers";

export const PLAN_FILE = "plan.json";
export const PLAN_FLAGS = ["--target", "--ref", "--head", "--host", "--memory-query", "--unattended", "--json", "--help", "-h"] as const;

/** What one re-entered review subcommand did: its stdout, stderr and exit code. */
export type StepResult = { stdout: string; stderr: string; exitCode: number };
export type PlanDeps = {
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void;
  /** Runs `keryx review <args>` and captures what it printed. */
  run: (args: string[]) => Promise<StepResult>;
  /** Where steps run: the project root (cwd). */
  cwd?: string | undefined;
};

export type PlanSlice = { id: string; files: string[]; depth?: string | undefined; roles: string[]; findingIds?: string[] | undefined };

export type ReviewPlan = {
  v: 1;
  package: string;
  target: { kind: "pr" | "branch"; ref: string; base: string | null; head: string | null };
  round: { number: number; mode: string; source: string; previous: string | null; range: { base: string | null; head: string | null }; fixHunks: number; newHunks: number; priorFindings: number; carried: number; line: string };
  slices: { fix: PlanSlice[]; new: PlanSlice[]; secondLook?: PlanSlice[] };
  roster: string[];
  dispatches: number;
  minutes: { min: number; max: number };
  split?: RoundEstimate["split"];
  overThreshold: boolean;
  overReasons: string[];
  planKey: string;
  warnings: string[];
  next: string;
};

export function printPlanHelp(): void {
  console.log(`keryx review plan --target <pr-url|branch> [--ref <base>] [--head <sha>] [--host ${REVIEW_HOSTS.join("|")}]
                  [--memory-query "<query>"] [--unattended] [--json]

The round plan in one command; it never dispatches. Runs, in this order: \`review start\` (which finds the previous round
of the target in every source and writes round.json), \`review scope\`, \`review blast-radius --package\`,
\`review slice --package\` (a delta round slices only prevHead..head, each slice tagged fix or new),
\`review required --depth auto --scope --package\` and \`review estimate\`. Writes <package>/${PLAN_FILE}: the round, the fix and new
slices, the roster, dispatches, minutes, whether the plan is over the operator threshold and what comes next:
"dispatch", or "confirm plan (card ${CONFIRM_PLAN_TOOL} / keryx review confirm-plan)".

--target is a pull request (URL, owner/repo#n or number) or a branch. --ref is the base the diff is taken against (a first round;
a delta round uses the previous reviewed head). --head pins the commit the round reviews (scope, blast-radius and slice
read that commit, not the working tree). --host: the agent host. --memory-query and --unattended are passed to
\`review start\` as they are; --unattended is refused there at a terminal, like \`review start --unattended\`.`);
}

/** A pull request reference (URL, `owner/repo#n`, `#n`, number) targets kind `pr`; anything else is a branch. */
export function targetKindOf(value: string): "pr" | "branch" {
  return /^https?:\/\/\S+\/pull\/\d+/.test(value) || /^[\w.-]+\/[\w.-]+#\d+$/.test(value) || /^#?\d+$/.test(value) ? "pr" : "branch";
}

function fail(step: string, result: StepResult): never {
  const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-6).join("\n");
  throw new Error(`review plan: \`review ${step}\` failed (exit ${result.exitCode}); the plan stops here.\n${detail}`);
}

/** The package directory `review start` printed (`path: <dir>`). */
export function packagePathOf(startOutput: string, cwd: string): string | undefined {
  const line = startOutput.split("\n").find((entry) => entry.startsWith("path: "));
  if (line === undefined) return undefined;
  const value = line.slice("path: ".length).trim();
  return value === "" ? undefined : path.resolve(cwd, value);
}

const toPlanSlice = (entry: SliceEntry): PlanSlice => ({ id: entry.id, files: entry.files, ...(entry.depth === undefined ? {} : { depth: entry.depth }), roles: entry.roles ?? [], ...(entry.findingIds === undefined ? {} : { findingIds: entry.findingIds }) });

/** The slices of a manifest by kind: fix slices, and everything else (a first round's slices are all `new`). */
export function slicesByKind(manifest: Pick<SliceManifest, "slices">): { fix: PlanSlice[]; new: PlanSlice[]; secondLook?: PlanSlice[] } {
  const originals = manifest.slices.filter((entry) => entry.retryOf === undefined);
  const secondLook = originals.filter((entry) => entry.kind === "second-look").map(toPlanSlice);
  return {
    fix: originals.filter((entry) => entry.kind === "fix").map(toPlanSlice),
    new: originals.filter((entry) => entry.kind !== "fix" && entry.kind !== "second-look").map(toPlanSlice),
    ...(secondLook.length === 0 ? {} : { secondLook }),
  };
}

export function nextStepOf(estimate: Pick<RoundEstimate, "overThreshold">, confirmed: boolean): string {
  return estimate.overThreshold && !confirmed ? `confirm plan (card ${CONFIRM_PLAN_TOOL} / keryx review confirm-plan)` : "dispatch";
}

export function renderPlanSummary(plan: ReviewPlan): string {
  const lines = [
    `plan: ${plan.package}`,
    plan.round.line,
    `slices: fix ${plan.slices.fix.length}, new ${plan.slices.new.length}${plan.slices.secondLook === undefined ? "" : `, second-look ${plan.slices.secondLook.length}`}`,
    ...(plan.split === undefined || plan.split === null ? [] : [`dispatches: fix: ${plan.split.fix.slices} slices / ${plan.split.fix.dispatches} dispatches, new: ${plan.split.new.slices} slices / ${plan.split.new.dispatches} dispatches${plan.split.secondLook === undefined ? "" : `, second-look: ${plan.split.secondLook.slices} slices / ${plan.split.secondLook.dispatches} dispatches`}`]),
    `roster (${plan.roster.length}): ${plan.roster.join(", ") || "none"}`,
    `estimate: ${plan.dispatches} dispatches, ${plan.minutes.min}-${plan.minutes.max} min${plan.overThreshold ? ` — over threshold (${plan.overReasons.join("; ")})` : ""}`,
    ...plan.warnings.map((warning) => `warning: ${warning}`),
    `next: ${plan.next}`,
    `written: ${path.join(plan.package, PLAN_FILE)}`,
  ];
  return lines.join("\n");
}

export async function runPlan(args: string[], deps: PlanDeps): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printPlanHelp();
    return;
  }
  deps.rejectUnknownFlags(args, PLAN_FLAGS, "plan");
  const target = optionValue(args, "--target");
  if (target === undefined || target.trim() === "") throw new Error("review plan needs --target <pr-url|branch>. See `keryx review plan --help`.");
  const base = optionValue(args, "--ref");
  const head = optionValue(args, "--head");
  const host = optionValue(args, "--host");
  const cwd = deps.cwd ?? process.cwd();
  const kind = targetKindOf(target);
  const warnings: string[] = [];

  // 1. start: finds the previous round and writes round.json beside the package.
  const memoryQuery = optionValue(args, "--memory-query");
  const started = await deps.run([
    "start",
    "--target",
    kind,
    "--ref",
    target,
    ...(head === undefined ? [] : ["--head", head]),
    ...(base === undefined ? [] : ["--base", base]),
    ...(host === undefined ? [] : ["--host", host]),
    ...(memoryQuery === undefined ? [] : ["--memory-query", memoryQuery]),
    ...(args.includes("--unattended") ? ["--unattended"] : []),
  ]);
  if (started.exitCode !== 0) fail("start", started);
  const packageDir = packagePathOf(started.stdout, cwd);
  if (packageDir === undefined || !existsSync(packageDir)) throw new Error("review plan: `review start` printed no package path; the plan stops here.");
  const round: RoundRecord | undefined = readRoundRecord(packageDir);
  const delta = isDeltaRound(round) ? round : undefined;
  warnings.push(...(round?.warnings ?? []));
  if (round?.weakPrevious !== undefined) warnings.push(round.weakPrevious);
  // A delta round is cut over the previous reviewed head; a first round over --ref, else the base start recorded.
  const baseRef = delta !== undefined ? delta.range.base! : base ?? round?.range.base ?? undefined;

  // 2. scope: the changed files of the round, recorded as scope-files.json (what required and estimate read).
  const scoped = await deps.run(["scope", "--json", ...(baseRef === undefined ? [] : ["--ref", baseRef, ...(head === undefined ? [] : ["--head", head])])]);
  if (scoped.exitCode !== 0) fail("scope", scoped);
  const scopeFile = path.join(packageDir, "scope.json");
  await writeFileAtomic(scopeFile, scoped.stdout.endsWith("\n") ? scoped.stdout : `${scoped.stdout}\n`);
  let scopeRecord: { files?: unknown; counts?: { changedLinesRetained?: unknown } } | undefined;
  try {
    scopeRecord = JSON.parse(scoped.stdout) as typeof scopeRecord;
  } catch {
    throw new Error("review plan: `review scope --json` printed no JSON; the plan stops here.");
  }
  const scopeFiles = Array.isArray(scopeRecord?.files) ? scopeRecord.files.filter((file): file is string => typeof file === "string") : [];
  if (!existsSync(path.join(packageDir, "scope-files.json"))) {
    const lines = scopeRecord?.counts?.changedLinesRetained;
    await writeFileAtomic(path.join(packageDir, "scope-files.json"), `${JSON.stringify({ version: 1, files: scopeFiles, ...(typeof lines === "number" ? { changedLines: lines } : {}) }, null, 2)}\n`);
  }

  // 3. blast-radius: scope B. A graph that cannot be read is a warning, not the end of the plan: the regression reviewer
  //    then has no scope B, and the plan says so.
  const radius = await deps.run(["blast-radius", "--package", packageDir, "--json", "--out", path.join(packageDir, "blast-radius.json"), ...(baseRef === undefined ? [] : ["--ref", baseRef])]);
  if (radius.exitCode !== 0) warnings.push(`blast radius not computed (${(radius.stderr.trim() || radius.stdout.trim()).split("\n").pop() ?? `exit ${radius.exitCode}`})`);

  // 4. slice: a delta round cuts prevHead..head and tags each slice fix or new.
  const sliced = await deps.run(["slice", "--package", packageDir, ...(baseRef === undefined || delta !== undefined ? [] : ["--ref", baseRef]), ...(head === undefined ? [] : ["--head", head]), ...(host === undefined ? [] : ["--host", host]), "--json"]);
  if (sliced.exitCode !== 0) fail("slice", sliced);
  const manifestPath = path.join(packageDir, "slices", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SliceManifest;

  // 5. required: the roster, fix-slice authors included.
  const required = await deps.run(["required", "--depth", "auto", "--scope", scopeFile, "--package", packageDir, "--json"]);
  if (required.exitCode !== 0) fail("required", required);
  let roster: string[];
  try {
    const parsed = JSON.parse(required.stdout) as { required?: unknown };
    roster = Array.isArray(parsed.required) ? parsed.required.filter((role): role is string => typeof role === "string") : [];
  } catch {
    throw new Error("review plan: `review required --json` printed no JSON; the plan stops here.");
  }

  // 6. estimate: dispatches and minutes of both kinds.
  const estimate = await estimatePackage(packageDir);
  // `slice` wrote its drivers before `required` recorded the round's depth, so they were cut for the full roster. Write
  // them again now, for the roster the estimate counts: one driver per dispatch, so `review next` and plan.json agree.
  const drivers = await writeWaveDrivers({ packageDir, manifest, sliceDir: path.dirname(manifestPath), reviewers: await packageReviewers(packageDir, manifest) });
  if (drivers.length !== estimate.dispatches) warnings.push(`${drivers.length} driver(s) written for ${estimate.dispatches} planned dispatch(es); re-run \`keryx review slice --package ${packageDir}\``);
  const confirmed = planConfirmed(packageDir, estimate);
  const byKind = slicesByKind(manifest);
  const plan: ReviewPlan = {
    v: 1,
    package: packageDir,
    target: { kind, ref: target, base: baseRef ?? null, head: round?.range.head ?? head ?? null },
    round: {
      number: round?.round ?? 1,
      mode: round?.mode ?? "first",
      source: round?.source ?? "none",
      previous: round?.previous?.reviewId ?? null,
      range: round?.range ?? { base: null, head: null },
      fixHunks: round?.fixHunks.length ?? 0,
      newHunks: round?.newHunks.length ?? 0,
      priorFindings: readPriorFindings(packageDir).length,
      carried: round?.carried.length ?? 0,
      line: round === undefined ? "round 1 — no round record" : renderRoundLine(round),
    },
    slices: byKind,
    roster,
    dispatches: estimate.dispatches,
    minutes: estimate.minutes,
    ...(estimate.split === undefined ? {} : { split: estimate.split }),
    overThreshold: estimate.overThreshold,
    overReasons: estimate.overReasons,
    planKey: estimate.planKey,
    warnings,
    next: nextStepOf(estimate, confirmed),
  };
  await writeFileAtomic(path.join(packageDir, PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(args.includes("--json") ? JSON.stringify(plan, null, 2) : renderPlanSummary(plan));
}
