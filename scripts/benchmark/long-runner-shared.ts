// Shared plumbing for the long-session runners (flow 387 T22a): run-ablation-long.ts (keryx's own
// agent) and run-ablation-long-codex.ts (codex CLI). Everything here is harness-agnostic and
// network-free: seeding a task's corpus into an isolated worktree, stripping + verifying the gold
// artifacts, reading the worktree back for the oracle, emission gating, and the offline dry run.
// Nothing in this file contains an answer; the answers live in long-tasks.ts, which is stripped
// from every worktree before an agent sees it.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { checkGoldLeakage } from "../../src/metrics/leakage";
import { ABLATION_GOLD_ARTIFACT_PATH } from "./ablation-tasks";
import { LONG_GOLD_ARTIFACT_PATHS, type LongCase, type LongOracleResult, type LongTask, type ReadWorktreeFile } from "./long-tasks";
import type { MechanismCounts, VolumeMetrics } from "./long-metrics";
import { MUTATING_GOLD_ARTIFACT_PATH } from "./mutating-tasks";
import type { InstrumentedSeedSample } from "./token-metrics";

/** Result fixtures this family writes; they hold oracle failure lines (expected values), so they are gold too. */
export const LONG_RESULT_FIXTURE_PREFIX = "ablation-long-";
const FIXTURE_DIR = "fixtures/benchmark/keryx";

export function argValue(argv: readonly string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] !== undefined ? (argv[index + 1] as string) : fallback;
}

/** "1,2,3" -> [1,2,3]; rejects anything that is not a positive integer. */
export function parseSeeds(spec: string): number[] {
  const seeds = spec.split(",").map((s) => Number(s.trim()));
  if (seeds.length === 0 || seeds.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error(`--seeds must be a comma-separated list of positive integers, got "${spec}"`);
  }
  return seeds;
}

/** `ablation-long-results[-x].json` -> `...-<label>.json`; a label keeps a baseline run from clobbering a flow run. */
export function labelledFilename(filename: string, label: string | undefined): string {
  if (label === undefined || label.length === 0) return filename;
  const slug = label.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  return filename.replace(/\.json$/, `-${slug}.json`);
}

/** Every repo-relative path a worktree must not contain before an agent sees it. */
export function goldPathsFor(worktreeRoot: string): string[] {
  const paths = [ABLATION_GOLD_ARTIFACT_PATH, MUTATING_GOLD_ARTIFACT_PATH, ...LONG_GOLD_ARTIFACT_PATHS];
  const dir = join(worktreeRoot, FIXTURE_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(LONG_RESULT_FIXTURE_PREFIX)) paths.push(`${FIXTURE_DIR}/${name}`);
    }
  }
  return paths;
}

/**
 * AC-5 for a long-task worktree: remove every gold artifact, then PROVE none is reachable.
 * Throws instead of returning a flag: a case on an unverified worktree must not run.
 * Known residual: a linked worktree shares the repo's git object store, so an agent that thinks
 * to run `git show HEAD:<path>` could still read a committed gold file; the stripped files are
 * not in the working tree, and the prompt forbids shell filtering, but this is not a sandbox.
 */
export function stripAndVerifyGold(worktreeRoot: string): void {
  const paths = goldPathsFor(worktreeRoot);
  for (const rel of paths) rmSync(join(worktreeRoot, rel), { force: true });
  const leakage = checkGoldLeakage(worktreeRoot, paths);
  if (leakage.assertion !== "passed") {
    throw new Error(`AC-5: gold artifact still reachable in worktree after strip (${leakage.assertion}): ${leakage.reachablePaths.join(", ")}`);
  }
}

export function writeSeedFiles(root: string, files: LongCase["seedFiles"]): void {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
}

/** Worktree reader for the oracle: `undefined` when the file does not exist. */
export function worktreeReader(root: string): ReadWorktreeFile {
  return (rel) => {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch {
      return undefined;
    }
  };
}

/** Strip gold, verify, then seed the task's corpus. Returns the built case (its oracle is bound to the expected values). */
export function seedLongWorktree(root: string, task: LongTask): LongCase {
  stripAndVerifyGold(root);
  const built = task.build();
  writeSeedFiles(root, built.seedFiles);
  return built;
}

export type OracleSummary = {
  readonly success: boolean;
  readonly score: number;
  readonly correct: number;
  readonly total: number;
  readonly failures: readonly string[];
  readonly counters: Readonly<Record<string, number>>;
};

export const summarizeOracle = (r: LongOracleResult): OracleSummary => ({
  success: r.success,
  score: r.score,
  correct: r.correct,
  total: r.total,
  failures: r.failures,
  counters: r.counters,
});

/** A long-run sample: an instrumented ablation sample plus the oracle, mechanism and volume evidence. */
export type LongRunSample = InstrumentedSeedSample & {
  readonly task: string;
  readonly durationMs: number;
  readonly oracle: OracleSummary;
  /** null for harnesses whose events carry no hook for it (the CLI legs). */
  readonly mechanisms: MechanismCounts | null;
  readonly volume: VolumeMetrics;
  /** `[budget]` lines the agent printed (round/tool-call limit reached), keryx only. */
  readonly budgetNotes: readonly string[];
};

export function describeSample(variant: string, s: LongRunSample): string {
  const m = s.mechanisms;
  const mech =
    m === null
      ? "mechanisms=n/a"
      : `prune=${m.pruneEvents} compaction=${m.compactionEvents} cleared=${m.clearedResults} collapsed=${m.collapsedRecords} spill=${m.spilledOutputs} replayAsst=${m.replayCarryingAssistants}`;
  return (
    `  ${variant} seed=${s.seed}: success=${s.success} score=${s.oracle.score.toFixed(2)} (${s.oracle.correct}/${s.oracle.total}) ` +
    `requests=${s.metrics.requests ?? "n/a"} toolCalls=${s.toolCalls} tokens=${s.tokens ?? "n/a"} ` +
    `uncachedIn=${s.metrics.uncachedInputTokens ?? "n/a"} out=${s.metrics.outputTokens ?? "n/a"} ` +
    `${mech} toolOutTok~${s.volume.estToolOutputTokens} distinctRead=${s.volume.distinctPathsRead} volumeOk=${s.volume.volumeOk} ` +
    `repeatedAfterCompactionOrPrune=${s.repeatedReads?.repeatedAfterCompactionOrPrune ?? "n/a"} ${(s.durationMs / 1000).toFixed(0)}s`
  );
}

/** Per-task roll-up over a set of samples: did each mechanism fire in any / every run. */
export function mechanismRollup(samples: readonly LongRunSample[]): {
  readonly runs: number;
  readonly withMechanisms: number;
  readonly anyPrune: number;
  readonly anyCollapse: number;
  readonly anyCompaction: number;
  readonly anySpill: number;
  readonly volumeOk: number;
  readonly successes: number;
} {
  const withM = samples.filter((s) => s.mechanisms !== null);
  return {
    runs: samples.length,
    withMechanisms: withM.length,
    anyPrune: withM.filter((s) => s.mechanisms?.fired.prune).length,
    anyCollapse: withM.filter((s) => s.mechanisms?.fired.collapse).length,
    anyCompaction: withM.filter((s) => s.mechanisms?.fired.compaction).length,
    anySpill: withM.filter((s) => s.mechanisms?.fired.spill).length,
    volumeOk: samples.filter((s) => s.volume.volumeOk).length,
    successes: samples.filter((s) => s.success).length,
  };
}

/** Injectable side effects for {@link finalizeLongRun}: real I/O in `main`, spies in tests. */
export type LongEmissionIO = {
  readonly writeResultsFixture: (contents: string) => Promise<void>;
  readonly printManifest: (contents: string) => void;
  readonly logLine: (line: string) => void;
};

/**
 * Emission gated on validation (same defect shape fixed across every run-ablation*.ts producer):
 * on an invalid manifest NOTHING is written and a previously written good fixture stays untouched.
 * Returns the exit code.
 */
export async function finalizeLongRun(
  resultsFixture: unknown,
  manifest: PairedBenchmarkManifestV2,
  validation: { readonly valid: boolean; readonly errors: readonly string[] },
  resultsFilename: string,
  io: LongEmissionIO,
): Promise<number> {
  if (validation.valid) {
    await io.writeResultsFixture(`${JSON.stringify(resultsFixture, null, 2)}\n`);
    io.printManifest(JSON.stringify(manifest, null, 2));
  }
  io.logLine(`\n# ladder=harness long-ablation manifest valid: ${validation.valid ? "yes" : "no"}`);
  for (const err of validation.errors) io.logLine(`- ${err}`);
  if (validation.valid) {
    io.logLine(`wrote ${FIXTURE_DIR}/${resultsFilename}`);
    return 0;
  }
  io.logLine(`invalid manifest — nothing written; ${FIXTURE_DIR}/${resultsFilename} left unchanged`);
  return 1;
}

/**
 * Offline check of the wiring, no model and no git: seed every selected task into a temp dir,
 * run its oracle on the PRISTINE tree (it must fail: the task is not done by existing), and
 * report corpus size. Returns false when a pristine tree passes an oracle.
 */
export async function dryRun(tasks: readonly LongTask[], log: (line: string) => void): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "keryx-long-dryrun-"));
  let ok = true;
  try {
    for (const task of tasks) {
      const root = join(dir, task.name);
      mkdirSync(root, { recursive: true });
      const built = task.build();
      writeSeedFiles(root, built.seedFiles);
      const bytes = built.seedFiles.reduce((n, f) => n + f.content.length, 0);
      const pristine = built.check(worktreeReader(root));
      log(
        `${task.name}: ${built.seedFiles.length} seeded files, ${bytes} chars (~${Math.ceil(bytes / 4)} tokens); ` +
          `expected tool output >= ~${task.expectedToolOutputTokens} tokens; pristine-tree oracle success=${pristine.success} score=${pristine.score.toFixed(2)}`,
      );
      if (pristine.success) {
        ok = false;
        log(`  ERROR: the oracle accepts the untouched tree`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return ok;
}
