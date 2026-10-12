// Shared plumbing for the long-session runners (flow 387 T22a): run-ablation-long.ts (keryx's own
// agent) and run-ablation-long-codex.ts (codex CLI). Everything here is harness-agnostic and
// network-free: seeding a task's corpus into an isolated worktree, stripping + verifying the gold
// artifacts, reading the worktree back for the oracle, emission gating, and the offline dry run.
// Nothing in this file contains an answer; the answers live in long-tasks.ts, which is stripped
// from every worktree before an agent sees it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { exceedsSpillThreshold } from "../../src/harness/tool/output-spill";
import type { CommandRunner } from "../../src/harness/tool/builtin/shell-exec-tool";
import {
  ensureSlateOpened,
  mintTimestampAttemptId,
  readSlateSession,
  type SlateSessionRef,
} from "../../src/session/slate-lifecycle";
import type { Slate } from "../../src/session/slate";
import { buildSlateFrame } from "../../src/session/slate-frame";
import type { InteractiveTool } from "../../src/harness/tool/builtin/interactive-tools";
import type { NormalizedMessage } from "../../src/harness/provider/types";
import { WORKING_MEMORY_TOOL_NAMES } from "../../src/harness/tool/builtin/slate-memory-tools";
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

/** The `runAgentTurn` options of a long run: a working-memory host (live session dir, a REAL open slate, archive pruning). */
export type LongTurnOptions = { slateSession: SlateSessionRef; pruneArchive: true };

/**
 * The `runAgentTurn` options a long run needs for the working-memory path to run for real: a live
 * session dir, `pruneArchive`, and a slate that EXISTS on disk. A ref flagged `opened: true` without a
 * slate.json makes `readSlateSession` return undefined, the frame comes out empty, and the rewrite
 * silently degrades to the reasoning trim plus observation packs while the system prompt still
 * promises Notes and a Trail (the measurement defect flow 393's review found in AC6/AC9). So the
 * slate is opened here, through the same `ensureSlateOpened` the shell uses, and the run is refused
 * if it is not readable afterwards.
 */
export async function openLongTurnOptions(
  sessionDir: string,
  cwd: string,
  runtime: { provider: string; model: string },
  mintAttemptId: () => string = mintTimestampAttemptId,
): Promise<LongTurnOptions> {
  const ref: SlateSessionRef = { dir: sessionDir, cwd, opened: false };
  await ensureSlateOpened(ref, mintAttemptId, runtime);
  return { slateSession: ref, pruneArchive: true };
}

/**
 * Throws unless a run is on the real working-memory path: the slate is readable, its frame is not empty
 * (the Anchors block alone makes it non-empty) and the four memory tools are registered. A run that
 * fails this measures the degraded mode and must not produce a number.
 */
export async function assertWorkingMemoryPath(options: LongTurnOptions, tools: readonly InteractiveTool[]): Promise<void> {
  const names = new Set(tools.map((t) => t.definition.name));
  const missing = WORKING_MEMORY_TOOL_NAMES.filter((n) => !names.has(n));
  if (missing.length > 0) {
    throw new Error(`long run is not on the working-memory path: tools missing from the runner: ${missing.join(", ")}`);
  }
  let slate: Slate | undefined;
  try {
    slate = await readSlateSession(options.slateSession);
  } catch (cause) {
    throw new Error(`long run is not on the working-memory path: slate unreadable (${(cause as Error).message})`, { cause });
  }
  if (slate === undefined) {
    throw new Error("long run is not on the working-memory path: no slate.json in the session dir, so the frame would be empty");
  }
  const frame = buildSlateFrame(slate, { nonce: "assert", scrub: (t) => t });
  if (frame.length === 0) {
    throw new Error("long run is not on the working-memory path: the slate frame is empty");
  }
}

/**
 * The runner's equivalent of the shell's archive writer: every message the history ever held lands in
 * `<sessionDir>/archive.jsonl`, so `history_search` has something to read. The cursor follows the same
 * rule as the shell (`syncArchive` + the rebase on a shortening): sync BEFORE a rewrite, point the cursor
 * at the new end AFTER it.
 */
export function createRunnerArchive(sessionDir: string, history: readonly NormalizedMessage[]): { sync: () => void; rebase: () => void } {
  const file = join(sessionDir, "archive.jsonl");
  let next = 0;
  return {
    sync: () => {
      const rows: string[] = [];
      for (; next < history.length; next++) {
        const m = history[next];
        if (m === undefined) continue;
        const { reasoning: _reasoning, ...row } = m;
        rows.push(JSON.stringify({ ...row, kind: "message", ts: m.ts ?? new Date().toISOString() }));
      }
      if (rows.length > 0) appendFileSync(file, `${rows.join("\n")}\n`, "utf8");
    },
    rebase: () => {
      next = history.length;
    },
  };
}

/**
 * Spilled outputs, counted from the session dir: files under `tool-output/` over the spill threshold.
 * `io.onToolResult` sees the output BEFORE the spill, and a spilled exchange is later cleared or collapsed
 * out of the final history, so neither of those can count a spill; the saved file is the durable evidence
 * (a prune-written file is a result under the threshold, so it never counts).
 */
export function countSpillFiles(sessionDir: string): number {
  const dir = join(sessionDir, "tool-output");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => exceedsSpillThreshold(readFileSync(join(dir, name), "utf8"))).length;
}

/** Deadline of one command in {@link uncappedShellRunner}. */
const UNCAPPED_RUNNER_TIMEOUT_MS = 120_000;

/**
 * A `shell_exec` runner WITHOUT the tool's own 20,000-byte output cap. The stock runner truncates to
 * 20 KB, which is below the 2000-line / 50 KB spill threshold, so with it no shell output can ever be
 * spilled and a task built to exercise spill (the 2100-line registry dump) measures nothing. The real
 * spill path in `runAgentTurn` is unchanged; this only lets a large result reach it.
 */
export function uncappedShellRunner(root: string): CommandRunner {
  return async (command, options) => {
    const proc = Bun.spawn(["sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), UNCAPPED_RUNNER_TIMEOUT_MS);
    options?.signal?.addEventListener("abort", () => proc.kill(), { once: true });
    try {
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const output = err.length > 0 ? `${out}${out.endsWith("\n") || out.length === 0 ? "" : "\n"}${err}` : out;
      return code === 0 ? { output, isError: false } : { output: output.length > 0 ? output : `exit code ${code}`, isError: true };
    } finally {
      clearTimeout(timer);
    }
  };
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
