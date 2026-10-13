import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { placeReviewPath } from "../lib/review-path-flags";
import { CHUNK_STATE_FILE, ensureChunkPlan, mergeChunkPass, nextChunk, readChunkPlan, recordChunk } from "../review/chunks";
import {
  DEFAULT_MAX_PASSES,
  answerChunkEstimate,
  chunkModeOf,
  chunkRunBlocker,
  estimateChunkRun,
  readChunkEstimate,
  recordChunkEstimate,
  renderChunkEstimate,
} from "../review/chunks-estimate";
import { coverageLine, writeCoverage } from "../review/coverage-complete";
import { DEFAULT_BLAST_RADIUS_MAX_FILES } from "../review/blast-radius";

export type ChunksDeps = {
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void;
};

export const CHUNKS_FLAGS = ["--package", "--result", "--chunk", "--status", "--mode", "--answer", "--quote", "--json", "--help", "-h"] as const;
export const COVERAGE_FLAGS = ["--package", "--json", "--help", "-h"] as const;

export function printChunksHelp(): void {
  console.log(`keryx review chunks — usage:

  keryx review chunks plan     --package <dir> [--json]
  keryx review chunks estimate --package <dir> [--mode automatic|interactive] [--answer yes|no --quote "<operator quote>"] [--json]
  keryx review chunks next     --package <dir> [--json]
  keryx review chunks record   --package <dir> --chunk <id> (--status <DONE|BLOCKED|...> | --result <file|->) [--json]
  keryx review chunks merge    --package <dir> [--json]

The blast radius keeps at most ${DEFAULT_BLAST_RADIUS_MAX_FILES} files per pass; the rest are listed as \`dropped\`. \`plan\` writes
<dir>/chunks.json, a deterministic split of every dropped file into chunks of at most ${DEFAULT_BLAST_RADIUS_MAX_FILES} files and the
slice byte cap, each file in exactly one chunk. No dropped files means no plan.

Chunks run one at a time through review-regression on the middle tier. \`next\` prints the chunk to
dispatch; \`record\` takes what the pass returned (a status, or a JSON result {"status", "findings"}) and
applies the retry plan: a failed chunk is handed back in smaller pieces while the plan allows it, and
stays pending afterwards. \`merge\` writes <dir>/chunk-pass.json: the state of each chunk (done, failed or
pending) and the findings of the finished ones, two on the same file and line counted once.

\`estimate\` says what a run will cost before it starts: chunks, files, tokens, cost at the middle tier
and duration. The ceiling is ${DEFAULT_MAX_PASSES} passes of ${DEFAULT_BLAST_RADIUS_MAX_FILES} files (${DEFAULT_MAX_PASSES * DEFAULT_BLAST_RADIUS_MAX_FILES} files);
set reviewChunks.maxPasses in routing.config.json to move it. In automatic review mode a run at or under the
ceiling goes through without a question and a run over it asks once; in interactive mode a run over
the ceiling waits for a yes (\`--answer yes --quote "..."\`). \`next\` refuses until then. The estimate and the
answer are recorded in <dir>/chunk-estimate.json.

A reviewer's tool calls go to <input-dir>/tool-calls/<reviewer>.jsonl, one JSON line per call; the
review counts the graph, wiki, memory and ctx calls from it.`);
}

export function printCoverageHelp(): void {
  console.log(`keryx review coverage — usage:

  keryx review coverage --package <dir> [--json]

Writes <dir>/coverage.json and prints four counts over every file in scope (the changed files and the
blast radius together): in scope, covered by a finished slice or chunk, covered by a named omission
(with the reasons), and uncovered. \`keryx review complete\` refuses while any file is uncovered; the
refusal names the first files and the command that runs the missing chunks. The only way past is
\`--waive-coverage "<operator quote>"\`, which records the quote, the time and the files not reviewed.`);
}

const wantsHelp = (args: readonly string[]): boolean => args.includes("--help") || args.includes("-h");

function resolveDir(command: string, args: readonly string[], cwd: string = process.cwd()): string {
  const raw = optionValue([...args], "--package");
  if (raw === undefined) throw new Error(`Missing --package <dir>. See \`keryx review ${command} --help\`.`);
  const placed = placeReviewPath(command, "--package", raw, { projectRoot: resolveProjectRoot(cwd), cwd });
  if (!placed.ok) throw new Error(placed.message);
  if (!existsSync(placed.path) || !statSync(placed.path).isDirectory()) throw new Error(`--package ${raw} is not a directory.`);
  return placed.path;
}

async function readResult(args: readonly string[], cwd: string = process.cwd()): Promise<{ status: string; findings?: unknown } | undefined> {
  const raw = optionValue([...args], "--result");
  if (raw === undefined) return undefined;
  const placed = placeReviewPath("chunks", "--result", raw, { projectRoot: resolveProjectRoot(cwd), cwd });
  if (!placed.ok) throw new Error(placed.message);
  const text = placed.path === "-" ? await Bun.stdin.text() : await readFile(placed.path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--result is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || typeof (parsed as { status?: unknown }).status !== "string") {
    throw new Error('--result must be a JSON object with a "status" string, e.g. {"status":"DONE","findings":[]}.');
  }
  return parsed as { status: string; findings?: unknown };
}

const out = (json: boolean, value: unknown, lines: string[]): void => console.log(json ? JSON.stringify(value, null, 2) : lines.join("\n"));

/** Records the estimate when none is on file, so a run that needs no question still leaves its estimate in the package. */
async function ensureEstimateRecorded(packageDir: string, projectRoot: string, modeFlag?: string): Promise<void> {
  const estimate = await estimateChunkRun(packageDir, projectRoot);
  if (estimate === null) return;
  const previous = await readChunkEstimate(packageDir);
  if (previous?.estimate.planKey === estimate.planKey) return;
  await recordChunkEstimate(packageDir, estimate, chunkModeOf(packageDir, modeFlag));
}

export async function runChunks(args: string[], deps: ChunksDeps): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || wantsHelp(args)) {
    printChunksHelp();
    return;
  }
  deps.rejectUnknownFlags(rest, CHUNKS_FLAGS, `chunks ${sub}`);
  const packageDir = resolveDir("chunks", rest);
  const projectRoot = resolveProjectRoot(process.cwd());
  const json = rest.includes("--json");

  if (sub === "plan") {
    const plan = await ensureChunkPlan(packageDir, projectRoot);
    if (plan === null) {
      out(json, { plan: null }, ["no chunks: the blast radius dropped no files, so there is nothing to plan"]);
      return;
    }
    out(json, plan, [`chunks.json: ${plan.chunks.length} chunk(s) for ${plan.dropped} dropped file(s), at most ${plan.maxFiles} files each (${plan.tier} tier, ${plan.reviewer})`]);
    return;
  }

  if (sub === "estimate") {
    const estimate = await estimateChunkRun(packageDir, projectRoot);
    if (estimate === null) {
      out(json, { estimate: null }, ["no chunks: the blast radius dropped no files, so there is nothing to run"]);
      return;
    }
    let record = await recordChunkEstimate(packageDir, estimate, chunkModeOf(packageDir, optionValue(rest, "--mode")));
    const answer = optionValue(rest, "--answer");
    if (answer !== undefined) {
      if (answer !== "yes" && answer !== "no") throw new Error('--answer must be "yes" or "no".');
      record = await answerChunkEstimate(packageDir, answer, optionValue(rest, "--quote") ?? "");
    }
    out(json, record, renderChunkEstimate(record));
    return;
  }

  if (sub === "next") {
    if ((await readChunkPlan(packageDir)) === undefined && (await ensureChunkPlan(packageDir, projectRoot)) === null) {
      out(json, { chunk: null }, ["no chunks: the blast radius dropped no files"]);
      return;
    }
    const blocker = await chunkRunBlocker(packageDir, projectRoot);
    if (blocker !== undefined) {
      out(json, { chunk: null, blocked: blocker }, [`blocked: ${blocker}`]);
      process.exitCode = 1;
      return;
    }
    await ensureEstimateRecorded(packageDir, projectRoot);
    const next = await nextChunk(packageDir);
    const lines =
      next.chunk === null
        ? [`no chunk left to run (${next.reason})`]
        : [`next: ${next.chunk.id} — ${next.chunk.files.length} file(s), ${next.reviewer} on the ${next.tier} tier; ${next.remaining} chunk(s) left`, ...next.chunk.files.map((file) => `  ${file}`)];
    out(json, next, lines);
    return;
  }

  if (sub === "record") {
    const chunk = optionValue(rest, "--chunk");
    if (chunk === undefined) throw new Error("Missing --chunk <id>. See `keryx review chunks --help`.");
    const result = (await readResult(rest)) ?? { status: optionValue(rest, "--status") ?? "" };
    if (result.status === "") throw new Error("Missing --status <DONE|BLOCKED|...> or --result <file|->.");
    const recorded = await recordChunk(packageDir, chunk, result);
    out(json, recorded, [`${chunk}: ${recorded.state} (${recorded.decision} — ${recorded.reason}); state in ${CHUNK_STATE_FILE}`]);
    return;
  }

  if (sub === "merge") {
    const pass = await mergeChunkPass(packageDir);
    if (pass === null) {
      out(json, { pass: null }, ["no chunks: the blast radius dropped no files"]);
      return;
    }
    out(json, pass, [
      `chunk-pass.json: ${pass.totals.done}/${pass.totals.chunks} chunk(s) done, ${pass.totals.failed} failed, ${pass.totals.pending} pending; ${pass.uncoveredFiles.length} file(s) uncovered; ${pass.findings.length} finding(s)`,
    ]);
    return;
  }

  throw new Error(`Unknown chunks command "${sub}". Use plan, estimate, next, record or merge.`);
}

export async function runCoverage(args: string[], deps: ChunksDeps): Promise<void> {
  if (wantsHelp(args)) {
    printCoverageHelp();
    return;
  }
  deps.rejectUnknownFlags(args, COVERAGE_FLAGS, "coverage");
  const report = await writeCoverage(resolveDir("coverage", args));
  out(args.includes("--json"), report, [coverageLine(report)]);
}
