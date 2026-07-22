#!/usr/bin/env bun
/**
 * Concurrent test-suite stress harness.
 *
 * Runs N full `bun test` suites at the same time and reports, per run, the
 * pass/fail/skip tallies and the names of every failing test. Several agent
 * sessions run `bun test` in parallel from different worktrees, so a test that
 * reaches a fixed path or a fixed artifact id outside its own working copy
 * fails for reasons unrelated to any change. This harness makes that class of
 * defect reproducible and measurable instead of anecdotal.
 *
 * Usage:
 *   bun scripts/stress/concurrent-suite-stress.ts [--runs 6] [--repeat 1] [--filter <path>]
 *
 * Exit code is 0 only when every run of every repetition reported zero failures.
 */

const PASS_LINE = /^\s*(\d+)\s+pass\s*$/;
const FAIL_LINE = /^\s*(\d+)\s+fail\s*$/;
const SKIP_LINE = /^\s*(\d+)\s+skip\s*$/;
const FAIL_TEST_LINE = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/;

interface RunResult {
  index: number;
  exitCode: number;
  pass: number;
  fail: number;
  skip: number;
  failingTests: string[];
  errorLines: string[];
  durationMs: number;
  transcript: string;
  logPath?: string;
}

/** Where transcripts of failing runs are kept (`.tmp-*` is gitignored). */
const LOG_DIR = ".tmp-stress-logs";

function parseArgs(argv: string[]): { runs: number; repeat: number; filter: string[] } {
  let runs = 6;
  let repeat = 1;
  const filter: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runs" || arg === "-n") {
      runs = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--repeat" || arg === "-r") {
      repeat = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--filter" || arg === "-f") {
      const value = argv[i + 1];
      if (value !== undefined) filter.push(value);
      i += 1;
    }
  }
  if (!Number.isFinite(runs) || runs < 1) runs = 6;
  if (!Number.isFinite(repeat) || repeat < 1) repeat = 1;
  return { runs, repeat, filter };
}

/** Pull the interesting signal out of a full `bun test` transcript. */
function summarize(index: number, exitCode: number, output: string, durationMs: number): RunResult {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  const failingTests: string[] = [];
  const errorLines: string[] = [];
  for (const line of output.split("\n")) {
    const passMatch = PASS_LINE.exec(line);
    if (passMatch?.[1] !== undefined) {
      pass = Number.parseInt(passMatch[1], 10);
      continue;
    }
    const failMatch = FAIL_LINE.exec(line);
    if (failMatch?.[1] !== undefined) {
      fail = Number.parseInt(failMatch[1], 10);
      continue;
    }
    const skipMatch = SKIP_LINE.exec(line);
    if (skipMatch?.[1] !== undefined) {
      skip = Number.parseInt(skipMatch[1], 10);
      continue;
    }
    const failTestMatch = FAIL_TEST_LINE.exec(line);
    if (failTestMatch?.[1] !== undefined) {
      failingTests.push(failTestMatch[1].trim());
      continue;
    }
    const trimmed = line.trim();
    if (
      trimmed.startsWith("error:") ||
      trimmed.startsWith("ENOENT") ||
      trimmed.includes("posix_spawn")
    ) {
      errorLines.push(trimmed);
    }
  }
  return { index, exitCode, pass, fail, skip, failingTests, errorLines, durationMs, transcript: output };
}

async function runOnce(index: number, filter: string[]): Promise<RunResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn(["bun", "test", ...filter], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return summarize(index, exitCode, `${stdout}\n${stderr}`, Date.now() - startedAt);
}

/**
 * Keep the transcript of any run that failed. A collision is rare and expensive
 * to reproduce, so the evidence has to survive the run that produced it.
 */
async function retainFailingTranscripts(wave: number, results: RunResult[]): Promise<void> {
  for (const result of results) {
    if (result.fail === 0) continue;
    const logPath = `${LOG_DIR}/wave${wave}-run${result.index}.log`;
    await Bun.write(logPath, result.transcript);
    result.logPath = logPath;
  }
}

/** The `(fail)` marker plus the lines under it, which carry the real message. */
function failureExcerpt(transcript: string, contextLines = 12): string[] {
  const lines = transcript.split("\n");
  const excerpt: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!FAIL_TEST_LINE.test(lines[i] ?? "")) continue;
    excerpt.push(...lines.slice(i, i + contextLines).map((line) => `    ${line}`));
    excerpt.push("    ---");
  }
  return excerpt;
}

function reportWave(wave: number, results: RunResult[]): number {
  const totalFailures = results.reduce((sum, result) => sum + result.fail, 0);
  console.log(`\n=== wave ${wave} — ${results.length} concurrent suites ===`);
  console.log("run | exit |  pass | fail | skip |   secs");
  for (const result of results) {
    const secs = (result.durationMs / 1000).toFixed(1).padStart(6);
    console.log(
      `${String(result.index).padStart(3)} | ${String(result.exitCode).padStart(4)} | ` +
        `${String(result.pass).padStart(5)} | ${String(result.fail).padStart(4)} | ` +
        `${String(result.skip).padStart(4)} | ${secs}`,
    );
  }
  const failingByName = new Map<string, number>();
  const errorsByText = new Map<string, number>();
  for (const result of results) {
    for (const name of result.failingTests) {
      failingByName.set(name, (failingByName.get(name) ?? 0) + 1);
    }
    for (const text of result.errorLines) {
      errorsByText.set(text, (errorsByText.get(text) ?? 0) + 1);
    }
  }
  if (failingByName.size > 0) {
    console.log(`\nfailing tests (name × runs affected):`);
    for (const [name, count] of [...failingByName].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}× ${name}`);
    }
  }
  if (errorsByText.size > 0) {
    console.log(`\nerror lines (text × occurrences):`);
    for (const [text, count] of [...errorsByText].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${count}× ${text}`);
    }
  }
  for (const result of results) {
    if (result.fail === 0) continue;
    console.log(`\nrun ${result.index} failure detail (full transcript: ${result.logPath ?? "n/a"}):`);
    for (const line of failureExcerpt(result.transcript)) console.log(line);
  }
  console.log(`\nwave ${wave} total failures: ${totalFailures}`);
  return totalFailures;
}

async function main(): Promise<void> {
  const { runs, repeat, filter } = parseArgs(process.argv.slice(2));
  console.log(`cwd: ${process.cwd()}`);
  console.log(`runs per wave: ${runs}, waves: ${repeat}${filter.length > 0 ? `, filter: ${filter.join(" ")}` : ""}`);
  let grandTotal = 0;
  const waveTotals: number[] = [];
  for (let wave = 1; wave <= repeat; wave += 1) {
    const results = await Promise.all(
      Array.from({ length: runs }, (_unused, index) => runOnce(index + 1, filter)),
    );
    await retainFailingTranscripts(wave, results);
    const waveFailures = reportWave(wave, results);
    waveTotals.push(waveFailures);
    grandTotal += waveFailures;
  }
  console.log(`\n=== summary ===`);
  console.log(`failures per wave: ${waveTotals.join(", ")}`);
  console.log(`grand total failures: ${grandTotal}`);
  process.exit(grandTotal === 0 ? 0 : 1);
}

await main();
