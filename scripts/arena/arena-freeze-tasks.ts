// Freeze the T1 sample, once, before any arm runs.
//
// The sample rule is fixed here rather than chosen after seeing results, and the
// seed is written into the output so the same 13 tasks can be reproduced from the
// same history. That is the whole point: `--tasks N` in the pilot's runner is a
// SLICE of the most recent survivors, so its sample is clustered in time and in
// whatever the team happened to be working on that fortnight. With 113 admissible
// tasks available on this repository there is no reason to accept that.
//
// Uniform, not stratified. Stratifying by gold-set size would control difficulty
// spread, and would also be a decision about which tasks count made by someone
// who had already seen the pool — which is the objection this file exists to
// foreclose. The realised gold-size distribution is reported instead.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractRetrievalTasks, type RetrievalTask } from "../benchmark/retrieval-tasks";

/** Fixed, and recorded in the artifact. Changing it is choosing a different sample. */
export const ARENA_T1_SEED = 20260909;

/**
 * A deterministic PRNG, so the sample is a property of the seed and not of the
 * machine. mulberry32: small, well-distributed enough for drawing 13 of 113, and
 * short enough to read.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw `count` without replacement, by Fisher-Yates on a copy.
 *
 * Sorted by id first so the input order cannot depend on how git happened to
 * list commits; the seed alone then decides the draw.
 */
export function sampleTasks(pool: readonly RetrievalTask[], count: number, seed: number): RetrievalTask[] {
  const ordered = [...pool].sort((left, right) => left.id.localeCompare(right.id));
  const random = mulberry32(seed);
  for (let i = ordered.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = ordered[i];
    const b = ordered[j];
    if (a !== undefined && b !== undefined) {
      ordered[i] = b;
      ordered[j] = a;
    }
  }
  return ordered.slice(0, count);
}

export interface FrozenT1 {
  readonly kind: "arena-t1";
  readonly repoRoot: string;
  readonly ref: string;
  readonly before: string;
  readonly limit: number;
  readonly seed: number;
  readonly frozenAt: string;
  readonly pool: number;
  readonly dropped: Readonly<Record<string, number>>;
  readonly goldSizeHistogram: Readonly<Record<string, number>>;
  readonly tasks: readonly RetrievalTask[];
}

export function freezeT1(options: {
  readonly repoRoot: string;
  readonly before: string;
  readonly count: number;
  readonly limit?: number;
  readonly seed?: number;
  readonly now?: () => Date;
}): FrozenT1 {
  const limit = options.limit ?? 600;
  const seed = options.seed ?? ARENA_T1_SEED;
  const extracted = extractRetrievalTasks({ repoRoot: options.repoRoot, limit, before: options.before });
  if (extracted.tasks.length < options.count) {
    throw new Error(
      `only ${extracted.tasks.length} admissible tasks in the last ${limit} first-parent commits before ` +
        `${options.before}, and ${options.count} were asked for — widen --limit rather than shrinking the sample, ` +
        "because a sample chosen to fit what survived is not the sample that was pre-registered",
    );
  }
  const tasks = sampleTasks(extracted.tasks, options.count, seed);
  const histogram: Record<string, number> = {};
  for (const task of tasks) {
    const key = String(task.gold.length);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return {
    kind: "arena-t1",
    repoRoot: options.repoRoot,
    ref: "HEAD",
    before: options.before,
    limit,
    seed,
    frozenAt: (options.now ?? ((): Date => new Date()))().toISOString(),
    pool: extracted.tasks.length,
    dropped: extracted.dropped,
    goldSizeHistogram: histogram,
    tasks,
  };
}

if (import.meta.main) {
  const repoRoot = process.argv[2];
  const before = process.argv[3];
  const out = process.argv[4];
  if (repoRoot === undefined || before === undefined || out === undefined) {
    throw new Error("usage: arena-freeze-tasks.ts <repo> <before:YYYY-MM-DD> <out.json> [count]");
  }
  const count = process.argv[5] === undefined ? 13 : Number(process.argv[5]);
  const frozen = freezeT1({ repoRoot, before, count });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(frozen, null, 2)}\n`);
  console.log(`froze ${frozen.tasks.length} of ${frozen.pool} admissible, seed ${frozen.seed} → ${out}`);
  console.log(`dropped: ${JSON.stringify(frozen.dropped)}`);
  console.log(`gold sizes: ${JSON.stringify(frozen.goldSizeHistogram)}`);
}
