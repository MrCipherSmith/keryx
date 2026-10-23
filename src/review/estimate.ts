// `keryx review estimate`: what a round will cost before it starts. It reads the slice manifest and the required reviewer
// set, and prints roles x slices = assignments, how many dispatches (waves) those need at the manifest's wave budget, and
// an expected duration range. Nothing here dispatches or writes.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { readJsonFileOr, readJsonObjectFile } from "../lib/json";
import { packageHasBlastRadius, packageHasPrContext, packageRoundDepth, packageScopeFiles, projectRootOfPackage, requiredReviewers, type RoundDepth } from "./coverage";
import { operatorGateApplies, runProfileRefusal } from "./run-profile";
import { manifestSizeProblem, packWavesByKind, waveBytesOf, type SliceEntry, type SliceManifest } from "./slice";
import { ROLES_RUN_WITHOUT_SLICES, ROUTABLE_ROLES, isRoutedManifest } from "./slice-routing";
import { requiredSlices, sliceGraph } from "./waves";
import { manifestRosterRoles, splitCounts } from "./round-split";
import { isHostQuestion, type HostQuestion } from "./types";

/** A spawned reviewer child is killed after 5 minutes (src/harness/tool/builtin/spawn-subagent-tool.ts), so one dispatch never runs longer than this. */
export const CHILD_DEADLINE_MINUTES = 5;
/** A typical dispatch finishes well inside the deadline; this is the optimistic per-dispatch time. */
export const TYPICAL_DISPATCH_MINUTES = 2;
/** How many reviewer dispatches the orchestrator runs side by side. */
export const ASSUMED_PARALLEL_DISPATCHES = 4;

/** Above this many dispatches the operator confirms the plan before it runs (`routing.config.json` `reviewPlan.maxDispatches`). */
export const DEFAULT_MAX_DISPATCHES = 40;
/** Above this upper duration, in minutes, the operator confirms the plan (`reviewPlan.maxMinutes`). */
export const DEFAULT_MAX_MINUTES = 90;
/** The card tool that records a plan confirmation inside keryx shell. */
export const CONFIRM_PLAN_TOOL = "review_confirm_plan";
export const PLAN_CONFIRMATION_FILE = "plan-confirmation.json";

export type PlanThresholds = { maxDispatches: number; maxMinutes: number; source: "default" | "routing.config.json"; warning?: string };

export type RoleEstimate = { role: string; slices: number; waves: number };

/** Who owns one slice in the plan, and how deep it is read: what the plan key is computed over. */
export type SlicePlanEntry = { id: string; roles: string[]; depth?: string | undefined };

export type RoundEstimate = {
  depth: RoundDepth | "unrecorded";
  sliced: boolean;
  roles: number;
  slices: number;
  /** roles x slices when sliced (each role owns the slices its path gate matches); the role count when not. */
  assignments: number;
  waveBytes: number | undefined;
  /** Total reviewer dispatches: every role's waves added up. */
  dispatches: number;
  /** Dispatch batches that run one after another: at least the longest role's waves, at most dispatches / parallelism rounded up. */
  sequentialBatches: number;
  minutes: { min: number; max: number };
  perRole: RoleEstimate[];
  assumptions: string;
  /** The slice manifest the estimate read, relative to the project root; undefined when the package is not sliced. */
  manifest?: string | undefined;
  /** Per original slice: the roles that own it and its depth. Empty when the package is not sliced. */
  slicePlan: SlicePlanEntry[];
  /** Routed slices by depth; zero when the manifest carries no routing. */
  routing: { deep: number; light: number; audit: number };
  /** Roles slice routing gave no slice: they need no dispatch. */
  routedOut: string[];
  /** The thresholds the plan was held to. */
  thresholds: { maxDispatches: number; maxMinutes: number };
  /** True when the plan needs the operator's confirmation before it runs. */
  overThreshold: boolean;
  /** Why the plan is over the threshold; empty when it is not. */
  overReasons: string[];
  /** {@link planKeyOf} of this estimate: a confirmation binds to it. */
  planKey: string;
  /** Original slices a major-or-worse finding re-opened deep (`escalated` in the manifest). */
  escalated: string[];
  /** Delta round (flow 458): the fix and new slices and the dispatches each kind needs. Absent in a round without kinds. */
  split?: { fix: { slices: number; dispatches: number }; new: { slices: number; dispatches: number }; secondLook?: { slices: number; dispatches: number } } | undefined;
};

/**
 * Stable identity of a plan: the round's roles with their waves, the wave budget, and, per original slice, its id,
 * owning roles and depth. A confirmation recorded for one plan does not carry over to a re-sliced, re-routed or
 * re-budgeted one (another `--host` or `--max-bytes` changes the waves, and so the cost; security review M4).
 */
export function planKeyOf(estimate: Pick<RoundEstimate, "perRole" | "slicePlan"> & { waveBytes?: number | undefined }): string {
  const roles = [...estimate.perRole].sort((a, b) => a.role.localeCompare(b.role)).map((entry) => ({ role: entry.role, waves: entry.waves }));
  const slices = [...estimate.slicePlan].sort((a, b) => a.id.localeCompare(b.id)).map((entry) => ({ id: entry.id, roles: [...entry.roles].sort(), depth: entry.depth ?? null }));
  return createHash("sha256").update(JSON.stringify({ roles, slices, waveBytes: estimate.waveBytes ?? null })).digest("hex").slice(0, 16);
}

/**
 * The dispatches (waves) one role needs over a manifest: its required slices packed per kind at the wave budget. A role a
 * routed manifest gives no slice is routed out (no dispatch) unless it runs without slices (the regression reviewer reads
 * scope B); any other role that owns nothing still gets one dispatch with no slice. The one count the estimate (and so
 * plan.json) and the drivers `review slice --package` writes share, so the plan's dispatches equal the drivers written.
 */
export function roleDispatchWaves(manifest: SliceManifest, role: string): SliceEntry[][] {
  const ids = requiredSlices(manifest, role);
  if (ids.length === 0) return isRoutedManifest(manifest) && ROUTABLE_ROLES.has(role) && !ROLES_RUN_WITHOUT_SLICES.has(role) ? [] : [[]];
  const waves = packWavesByKind(sliceGraph(manifest, role).open(ids, new Set()), waveBytesOf(manifest));
  return waves.length === 0 ? [[]] : waves;
}

export function estimateRound(
  roles: readonly string[],
  manifest: SliceManifest | undefined,
  depth: RoundEstimate["depth"] = "unrecorded",
  thresholds: Pick<PlanThresholds, "maxDispatches" | "maxMinutes"> = { maxDispatches: DEFAULT_MAX_DISPATCHES, maxMinutes: DEFAULT_MAX_MINUTES },
): RoundEstimate {
  const problem = manifest === undefined ? undefined : manifestSizeProblem(manifest);
  if (problem !== undefined) throw new Error(problem);
  const routed = manifest !== undefined && isRoutedManifest(manifest);
  const routedOut: string[] = [];
  const owners = new Map<string, string[]>();
  const counts = manifest === undefined ? undefined : splitCounts(manifest);
  const kindOf = new Map((manifest?.slices ?? []).map((s) => [s.id, s.kind === "fix" ? "fix" : s.kind === "second-look" ? "second-look" : "new"] as const));
  const kindDispatches = { fix: 0, new: 0, "second-look": 0 };
  const perRole: RoleEstimate[] = roles.map((role) => {
    if (manifest === undefined) return { role, slices: 0, waves: 1 };
    const ids = requiredSlices(manifest, role);
    for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), role]);
    const waves = roleDispatchWaves(manifest, role);
    if (routed && waves.length === 0) routedOut.push(role);
    // A dispatch carries one kind: fix slices come with the prior findings they answer, new slices as in round 1.
    if (counts !== undefined) for (const wave of waves) if (wave.length > 0) kindDispatches[kindOf.get(wave[0]!.id) ?? "new"] += 1;
    return { role, slices: ids.length, waves: waves.length };
  });
  const originals = manifest?.slices.filter((s) => s.retryOf === undefined) ?? [];
  const slicePlan: SlicePlanEntry[] = originals.map((s) => ({ id: s.id, roles: owners.get(s.id) ?? [], ...(s.depth === undefined ? {} : { depth: s.depth }) }));
  const dispatches = perRole.reduce((total, r) => total + r.waves, 0);
  const longest = perRole.reduce((m, r) => Math.max(m, r.waves), 0);
  const sequentialBatches = Math.max(longest, Math.ceil(dispatches / ASSUMED_PARALLEL_DISPATCHES));
  const assignments = manifest === undefined ? roles.length : perRole.reduce((total, r) => total + r.slices, 0);
  const minutes = { min: sequentialBatches * TYPICAL_DISPATCH_MINUTES, max: sequentialBatches * CHILD_DEADLINE_MINUTES };
  const waveBytes = manifest === undefined ? undefined : waveBytesOf(manifest);
  const overReasons = [
    ...(dispatches > thresholds.maxDispatches ? [`${dispatches} dispatches > ${thresholds.maxDispatches}`] : []),
    ...(minutes.max > thresholds.maxMinutes ? [`up to ${minutes.max} min > ${thresholds.maxMinutes}`] : []),
  ];
  return {
    depth,
    sliced: manifest !== undefined,
    roles: roles.length,
    slices: originals.length,
    assignments,
    waveBytes,
    dispatches,
    sequentialBatches,
    minutes,
    perRole,
    assumptions: `${TYPICAL_DISPATCH_MINUTES}-${CHILD_DEADLINE_MINUTES} min per dispatch (a child is killed at ${CHILD_DEADLINE_MINUTES} min), ${ASSUMED_PARALLEL_DISPATCHES} dispatches in parallel; excludes the verifier, retries and the mutation pass`,
    slicePlan,
    routing: {
      deep: originals.filter((s) => s.depth === "deep").length,
      light: originals.filter((s) => s.depth === "light").length,
      audit: originals.filter((s) => s.audit === true).length,
    },
    routedOut,
    thresholds: { maxDispatches: thresholds.maxDispatches, maxMinutes: thresholds.maxMinutes },
    overThreshold: overReasons.length > 0,
    overReasons,
    planKey: planKeyOf({ perRole, slicePlan, waveBytes }),
    escalated: originals.filter((s) => s.escalated !== undefined).map((s) => s.id),
    ...(counts === undefined ? {} : { split: { fix: { slices: counts.fix, dispatches: kindDispatches.fix }, new: { slices: counts.new, dispatches: kindDispatches.new }, ...(counts.secondLook === undefined ? {} : { secondLook: { slices: counts.secondLook, dispatches: kindDispatches["second-look"] } }) } }),
  };
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** `reviewPlan` in the project's `routing.config.json`; a field it leaves out, or that is not a positive number, keeps its default. */
export async function readPlanThresholds(projectRoot: string): Promise<PlanThresholds> {
  const defaults: PlanThresholds = { maxDispatches: DEFAULT_MAX_DISPATCHES, maxMinutes: DEFAULT_MAX_MINUTES, source: "default" };
  const file = path.join(projectRoot, "routing.config.json");
  if (!(await pathExists(file))) return defaults;
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") return { ...defaults, warning: `${file} could not be read as a JSON object (${read.state}); the default plan thresholds apply` };
  const own = read.value.reviewPlan;
  if (own === null || typeof own !== "object" || Array.isArray(own)) return defaults;
  const fields = own as Record<string, unknown>;
  return {
    maxDispatches: positive(fields.maxDispatches) ? Math.floor(fields.maxDispatches) : DEFAULT_MAX_DISPATCHES,
    maxMinutes: positive(fields.maxMinutes) ? fields.maxMinutes : DEFAULT_MAX_MINUTES,
    source: "routing.config.json",
  };
}

// ---------------------------------------------------------------------------
// Plan confirmation: `<package>/plan-confirmation.json`, written by the `review_confirm_plan` card (keryx shell) or by
// `keryx review estimate --confirm --quote` at a terminal. Nothing else may write it.
// ---------------------------------------------------------------------------

export type PlanConfirmedVia = "tui-card" | "remote-card" | "terminal" | "host-question";
const CONFIRMED_VIA: readonly PlanConfirmedVia[] = ["tui-card", "remote-card", "terminal", "host-question"];

export type PlanConfirmation = {
  planKey: string;
  dispatches: number;
  minutes: [number, number];
  quote: string;
  confirmedVia: PlanConfirmedVia;
  at: string;
  /** Flow 464: who pressed the remote card and when; set only with `confirmedVia: "remote-card"`. */
  pressedBy?: number | undefined;
  pressedAt?: string | undefined;
  /** Flow 467: the question the host asked and the answer that came back; set only with `confirmedVia: "host-question"`. */
  hostQuestion?: HostQuestion | undefined;
};

function isPlanConfirmation(value: unknown): value is PlanConfirmation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.planKey === "string" && v.planKey !== ""
    && typeof v.dispatches === "number" && Number.isFinite(v.dispatches)
    && Array.isArray(v.minutes) && v.minutes.length === 2 && v.minutes.every((m) => typeof m === "number" && Number.isFinite(m))
    && typeof v.quote === "string" && v.quote.trim() !== ""
    && typeof v.confirmedVia === "string" && (CONFIRMED_VIA as readonly string[]).includes(v.confirmedVia)
    && (v.confirmedVia !== "host-question" || isHostQuestion(v.hostQuestion))
    && typeof v.at === "string" && v.at !== "";
}

/** The recorded plan confirmation, or undefined when there is none or it is not a well-formed one. */
export function readPlanConfirmation(packageDir: string): PlanConfirmation | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(packageDir, PLAN_CONFIRMATION_FILE), "utf8"));
    return isPlanConfirmation(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True when the package holds a confirmation recorded for exactly this plan. */
export function planConfirmed(packageDir: string, estimate: Pick<RoundEstimate, "perRole" | "slicePlan"> & { waveBytes?: number | undefined }): boolean {
  return readPlanConfirmation(packageDir)?.planKey === planKeyOf(estimate);
}

export function planConfirmationFor(estimate: RoundEstimate, quote: string, confirmedVia: PlanConfirmedVia, now: Date = new Date()): PlanConfirmation {
  if (quote.trim() === "") throw new Error("A plan confirmation needs the operator's own words (--quote).");
  return { planKey: planKeyOf(estimate), dispatches: estimate.dispatches, minutes: [estimate.minutes.min, estimate.minutes.max], quote: quote.trim(), confirmedVia, at: now.toISOString() };
}

export async function writePlanConfirmation(packageDir: string, confirmation: PlanConfirmation): Promise<string> {
  const file = path.join(packageDir, PLAN_CONFIRMATION_FILE);
  await writeFileAtomic(file, `${JSON.stringify(confirmation, null, 2)}\n`);
  return file;
}

/** The terminal command that records a confirmation for a package. */
export function confirmPlanCommand(packageDir: string): string {
  return `keryx review estimate --package ${packageDir} --confirm --quote "<the operator's words>"`;
}

/** Why a dispatch of this plan is refused, or undefined when it is under the threshold or confirmed. */
export function planGateRefusal(estimate: RoundEstimate, confirmed: boolean, packageDir: string, previous?: PlanConfirmation | undefined): string | undefined {
  if (!estimate.overThreshold || confirmed) return undefined;
  // Security review M5: a plan an escalation grew is a different plan; say why the confirmation no longer holds.
  const grew =
    estimate.escalated.length > 0 && previous !== undefined
      ? `the plan grew because ${estimate.escalated.length} light slice(s) (${estimate.escalated.slice(0, 6).join(", ")}${estimate.escalated.length > 6 ? ", …" : ""}) were re-opened deep after a major-or-worse finding, so the confirmation recorded for plan ${previous.planKey} (${previous.dispatches} dispatches) no longer covers it; the operator confirms the grown plan. `
      : "";
  return `${grew}the review plan is over the operator threshold (${estimate.overReasons.join("; ")}; ${estimate.dispatches} dispatches, ${estimate.minutes.min}-${estimate.minutes.max} min) and no confirmation is recorded for it (plan ${estimate.planKey}). Inside keryx shell, call the ${CONFIRM_PLAN_TOOL} tool: the operator answers it as a card. Outside keryx shell, the operator runs \`${confirmPlanCommand(packageDir)}\` in a terminal`;
}

/**
 * The estimate of a package's plan and, when it is over the threshold without a confirmation, the refusal. A package
 * started before flow 457 (no operator-gate stamp, ./run-profile.ts) is not held to the gate: it never had a way to
 * record a confirmation (security review M9).
 */
export async function packagePlanGate(packageDir: string, options: { manifest?: string | undefined; manifestValue?: SliceManifest | undefined } = {}): Promise<{ estimate: RoundEstimate; refusal: string | undefined }> {
  const estimate = await estimatePackage(packageDir, options);
  const profileMissing = runProfileRefusal(packageDir);
  if (profileMissing !== undefined) return { estimate, refusal: profileMissing };
  if (!operatorGateApplies(packageDir)) return { estimate, refusal: undefined };
  return { estimate, refusal: planGateRefusal(estimate, planConfirmed(packageDir, estimate), packageDir, readPlanConfirmation(packageDir)) };
}

/** Where a round's slice manifest lives when `--manifest` is not given: the package's own, then the shell host's shared one. */
export function manifestCandidates(packageDir: string, root: string): string[] {
  return [
    path.join(packageDir, "slices", "manifest.json"),
    path.join(packageDir, "slice-manifest.json"),
    path.join(root, ".metaproject", "data", "review", "slices", "manifest.json"),
  ];
}

async function readManifest(candidates: readonly string[]): Promise<{ manifest: SliceManifest; file: string } | undefined> {
  for (const candidate of candidates) {
    const found = await readJsonFileOr<SliceManifest | undefined>(candidate, undefined);
    if (found !== undefined && Array.isArray(found.slices)) return { manifest: found, file: candidate };
  }
  return undefined;
}

export async function estimatePackage(packageDir: string, options: { manifest?: string | undefined; manifestValue?: SliceManifest | undefined } = {}): Promise<RoundEstimate> {
  if (!existsSync(packageDir)) throw new Error(`${packageDir} does not exist; pass --package <review-dir>`);
  const root = projectRootOfPackage(packageDir);
  const recorded = await packageRoundDepth(packageDir);
  const files = await packageScopeFiles(packageDir);
  const set = await requiredReviewers(root, "all", files, {
    blastRadius: await packageHasBlastRadius(packageDir),
    prContext: packageHasPrContext(packageDir),
    depth: recorded?.depth,
  });
  const read = await readManifest(options.manifest === undefined ? manifestCandidates(packageDir, root) : [options.manifest]);
  // A caller that already holds the manifest (the ledger, after applying escalations in a dry run) estimates that one.
  const found = options.manifestValue === undefined ? read : { manifest: options.manifestValue, file: read?.file ?? options.manifest ?? path.join(packageDir, "slices", "manifest.json") };
  if (options.manifest !== undefined && found === undefined) throw new Error(`${options.manifest} is not a slice manifest (no readable JSON with a slices array); run \`keryx review slice\` first`);
  const problem = found === undefined ? undefined : manifestSizeProblem(found.manifest);
  if (problem !== undefined) throw new Error(`${path.relative(root, found!.file)}: ${problem}`);
  const thresholds = await readPlanThresholds(root);
  // A delta round's fix slices add the roles that authored the findings they answer (flow 458), and a slice routed to the
  // security reviewer adds it in a light round too (manifestRosterRoles).
  const roles = [...new Set([...set.required, ...(found === undefined ? [] : manifestRosterRoles(found.manifest))])].sort();
  return { ...estimateRound(roles, found?.manifest, recorded?.depth ?? "unrecorded", thresholds), manifest: found === undefined ? undefined : path.relative(root, found.file) };
}

export function renderEstimate(estimate: RoundEstimate): string {
  const lines = [
    `depth: ${estimate.depth}`,
    `manifest: ${estimate.manifest ?? "none (the package is not sliced; pass --manifest <slices/manifest.json>)"}`,
    estimate.sliced
      ? `assignments: ${estimate.roles} roles x ${estimate.slices} slices = ${estimate.assignments} (a path-gated role owns only the slices its gate matches)`
      : `assignments: ${estimate.assignments} (${estimate.roles} roles; the package is not sliced, so each role reviews the whole diff once)`,
    `waves: ${estimate.dispatches} dispatches${estimate.waveBytes === undefined ? "" : ` at ${estimate.waveBytes} bytes per wave`}, ${estimate.sequentialBatches} batch(es) one after another`,
    `expected duration: ${estimate.minutes.min}-${estimate.minutes.max} min`,
    `assumption: ${estimate.assumptions}`,
  ];
  if (estimate.routing.deep + estimate.routing.light > 0) {
    lines.push(`routing: ${estimate.routing.deep} deep (${estimate.routing.audit} audit), ${estimate.routing.light} light${estimate.routedOut.length === 0 ? "" : `; no slice routed to ${estimate.routedOut.join(", ")}`}`);
  }
  if (estimate.split !== undefined) lines.push(`split round: fix: ${estimate.split.fix.slices} slices / ${estimate.split.fix.dispatches} dispatches, new: ${estimate.split.new.slices} slices / ${estimate.split.new.dispatches} dispatches`);
  lines.push(estimate.overThreshold
    ? `over threshold: ${estimate.overReasons.join("; ")} — the operator confirms this plan before it runs (plan ${estimate.planKey})`
    : `threshold: within ${estimate.thresholds.maxDispatches} dispatches and ${estimate.thresholds.maxMinutes} min (plan ${estimate.planKey})`);
  for (const r of estimate.perRole) lines.push(`  ${r.role}: ${r.slices} slice(s), ${r.waves} wave(s)`);
  return lines.join("\n");
}
