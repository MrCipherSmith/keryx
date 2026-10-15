// `keryx review estimate`: what a round will cost before it starts. It reads the slice manifest and the required reviewer
// set, and prints roles x slices = assignments, how many dispatches (waves) those need at the manifest's wave budget, and
// an expected duration range. Nothing here dispatches or writes.

import { existsSync } from "node:fs";
import path from "node:path";
import { readJsonFileOr } from "../lib/json";
import { packageHasBlastRadius, packageHasPrContext, packageRoundDepth, packageScopeFiles, projectRootOfPackage, requiredReviewers, type RoundDepth } from "./coverage";
import { packWaves, waveBytesOf, type SliceManifest } from "./slice";
import { requiredSlices, sliceGraph } from "./waves";

/** A spawned reviewer child is killed after 5 minutes (src/harness/tool/builtin/spawn-subagent-tool.ts), so one dispatch never runs longer than this. */
export const CHILD_DEADLINE_MINUTES = 5;
/** A typical dispatch finishes well inside the deadline; this is the optimistic per-dispatch time. */
export const TYPICAL_DISPATCH_MINUTES = 2;
/** How many reviewer dispatches the orchestrator runs side by side. */
export const ASSUMED_PARALLEL_DISPATCHES = 4;

export type RoleEstimate = { role: string; slices: number; waves: number };

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
};

export function estimateRound(roles: readonly string[], manifest: SliceManifest | undefined, depth: RoundEstimate["depth"] = "unrecorded"): RoundEstimate {
  const perRole: RoleEstimate[] = roles.map((role) => {
    if (manifest === undefined) return { role, slices: 0, waves: 1 };
    const ids = requiredSlices(manifest, role);
    const open = sliceGraph(manifest, role).open(ids, new Set());
    return { role, slices: ids.length, waves: Math.max(1, packWaves(open, waveBytesOf(manifest)).length) };
  });
  const dispatches = perRole.reduce((total, r) => total + r.waves, 0);
  const longest = perRole.reduce((m, r) => Math.max(m, r.waves), 0);
  const sequentialBatches = Math.max(longest, Math.ceil(dispatches / ASSUMED_PARALLEL_DISPATCHES));
  const assignments = manifest === undefined ? roles.length : perRole.reduce((total, r) => total + r.slices, 0);
  return {
    depth,
    sliced: manifest !== undefined,
    roles: roles.length,
    slices: manifest?.slices.filter((s) => s.retryOf === undefined).length ?? 0,
    assignments,
    waveBytes: manifest === undefined ? undefined : waveBytesOf(manifest),
    dispatches,
    sequentialBatches,
    minutes: { min: sequentialBatches * TYPICAL_DISPATCH_MINUTES, max: sequentialBatches * CHILD_DEADLINE_MINUTES },
    perRole,
    assumptions: `${TYPICAL_DISPATCH_MINUTES}-${CHILD_DEADLINE_MINUTES} min per dispatch (a child is killed at ${CHILD_DEADLINE_MINUTES} min), ${ASSUMED_PARALLEL_DISPATCHES} dispatches in parallel; excludes the verifier, retries and the mutation pass`,
  };
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

export async function estimatePackage(packageDir: string, options: { manifest?: string | undefined } = {}): Promise<RoundEstimate> {
  if (!existsSync(packageDir)) throw new Error(`${packageDir} does not exist; pass --package <review-dir>`);
  const root = projectRootOfPackage(packageDir);
  const recorded = await packageRoundDepth(packageDir);
  const files = await packageScopeFiles(packageDir);
  const set = await requiredReviewers(root, "all", files, {
    blastRadius: await packageHasBlastRadius(packageDir),
    prContext: packageHasPrContext(packageDir),
    depth: recorded?.depth,
  });
  const found = await readManifest(options.manifest === undefined ? manifestCandidates(packageDir, root) : [options.manifest]);
  if (options.manifest !== undefined && found === undefined) throw new Error(`${options.manifest} is not a slice manifest (no readable JSON with a slices array); run \`keryx review slice\` first`);
  return { ...estimateRound(set.required, found?.manifest, recorded?.depth ?? "unrecorded"), manifest: found === undefined ? undefined : path.relative(root, found.file) };
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
  for (const r of estimate.perRole) lines.push(`  ${r.role}: ${r.slices} slice(s), ${r.waves} wave(s)`);
  return lines.join("\n");
}
