// Producer for the metastore GDCTX oracle slice (fact-preservation rate), dogfooded on
// keryx's own gdctx compaction (robust, no external clone; mirrors run-testing-oracle.ts /
// run-memory-oracle.ts). This is the thin, I/O-doing half of the pipeline: for each pinned
// dogfood command it runs `keryx ctx run -- <command>` for the REAL compact summary, reads
// the raw log gdctx wrote alongside it, extracts facts from BOTH with the SAME documented,
// reproducible rule (extractFacts, src/metrics/oracle-runner.ts), writes the captured
// raw-vs-compact fact-set fixture, then scores them with the PURE scorer in
// src/metrics/oracle-runner.ts and prints the paired-3-5-v2 manifest + validation result.
//
// Ground truth (raw facts): the facts extractFacts finds in the ACTUAL raw stdout of the
// underlying shell command (gdctx's own raw log, e.g. `.metaproject/data/gdctx/raw/<id>.log`)
// — not a hand-typed fixture. System output (compact facts): the facts extractFacts finds in
// the compact SUMMARY `keryx ctx run --` prints (the same text an agent sees on stdout),
// after stripping gdctx's own footer bookkeeping lines (`compacted: …`, `raw: …`,
// `summary: …`), which are about the artifact record, not the compacted command output.
//
// Dogfood inputs (fixed, so the fixture is reproducible from a stated command): three
// `find <dir> -type f | sort` listings inside this repo, chosen to span both regimes gdctx's
// compactor actually has —
//   - a listing SHORTER than the compactor's line budget (no truncation possible: every raw
//     fact must survive) — a real, non-trivial "perfect preservation" case;
//   - two listings LONGER than the budget (the compactor elides the middle, so some facts are
//     genuinely dropped) — real, non-trivial "lossy" cases of differing severity.
// `sort` makes each listing's raw order deterministic run to run (the file SET can still
// drift as the repo grows, which is why this is a *regenerate*, not a *pinned-commit*, gold —
// same convention as run-testing-oracle.ts / run-memory-oracle.ts, which dogfood live repo
// state rather than an external pinned commit).
//
// Regenerate with:
//   bun scripts/benchmark/run-gdctx-oracle.ts
//
// The pure scorer (extractFacts + scoreGdctxRun + buildGdctxManifest) is fully unit-tested
// offline (src/metrics/oracle-runner.test.ts), so a failure here never blocks the metastore
// slice — it only means the fixture was not refreshed. If `keryx ctx run` is unavailable in
// the current environment, this producer fails loudly rather than fabricating fact sets;
// report it as `gdctx_result: pending` and keep the deterministic scorer + this regen command.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildGdctxManifest, extractFacts, GDCTX_FACT_PRESERVATION_LABEL, type GdctxScoreInput } from "../../src/metrics/oracle-runner";

// Each dogfood input: a shell command whose raw output is a deterministic, fact-bearing
// file-path listing. `find`+`sort` keeps the listing's raw ORDER deterministic; the compactor's
// 120-line budget (src/commands/ctx.ts DEFAULT_CONFIG.maxOutputLines) is what decides whether
// a given listing is short enough to survive whole.
const DOGFOOD_COMMANDS: readonly (readonly string[])[] = [
  ["bash", "-c", "find src/metrics -type f | sort"],
  ["bash", "-c", "find docs -type f | sort"],
  ["bash", "-c", "find .metaproject/skills -type f | sort"],
];

const fixtureRoot = new URL("../../fixtures/benchmark/keryx/", import.meta.url);
const fixtureUrl = new URL("gdctx-fact-preservation.json", fixtureRoot);

const repoRoot = new URL("../../", import.meta.url).pathname;

type SpawnResult = { stdout: string; stderr: string; ok: boolean };

function run(cmd: string[], cwd?: string): SpawnResult {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    ok: result.exitCode === 0,
  };
}

function keryxCli(): string[] {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--keryx");
  if (flag >= 0 && args[flag + 1]) return [args[flag + 1] as string];
  return ["keryx"];
}

// The compact summary's own footer ("compacted: N -> M bytes (…)", "raw: <path>",
// "summary: <path>") is gdctx's artifact bookkeeping about the run, not part of the
// compacted command output itself — cut it before extracting facts so those two path lines
// (which point at THIS run's own log/artifact, not anything the underlying command printed)
// are never scored as compact-side facts.
function stripFooter(stdout: string): string {
  const lines = stdout.split("\n");
  const cutIndex = lines.findIndex((line) => line.startsWith("raw: ") || line.startsWith("compacted: "));
  return (cutIndex >= 0 ? lines.slice(0, cutIndex) : lines).join("\n");
}

/** Parse the `raw: <relative-path>` pointer line `keryx ctx run` prints. */
function parseRawLogPath(stdout: string): string {
  const match = stdout.split("\n").find((line) => line.startsWith("raw: "));
  if (!match) throw new Error(`keryx ctx run output did not contain a "raw: <path>" pointer line:\n${stdout}`);
  return match.slice("raw: ".length).trim();
}

type CapturedInput = {
  input: string;
  rawText: string;
  compactText: string;
  rawFacts: string[];
  compactFacts: string[];
};

async function captureOne(cli: string[], command: readonly string[]): Promise<CapturedInput> {
  const label = command.join(" ");
  const invocation = run([...cli, "ctx", "run", "--", ...command], repoRoot);
  if (!invocation.ok) {
    throw new Error(`keryx ctx run -- ${label} failed: ${invocation.stderr || invocation.stdout}`);
  }
  const compactText = stripFooter(invocation.stdout);
  const rawLogRelPath = parseRawLogPath(invocation.stdout);
  const rawText = await readFile(path.join(repoRoot, rawLogRelPath), "utf8");
  return {
    input: label,
    rawText,
    compactText,
    rawFacts: extractFacts(rawText),
    compactFacts: extractFacts(compactText),
  };
}

async function main(): Promise<void> {
  const cli = keryxCli();

  if (DOGFOOD_COMMANDS.length < 3 || DOGFOOD_COMMANDS.length > 5) {
    throw new Error(`DOGFOOD_COMMANDS must list 3-5 inputs, found ${DOGFOOD_COMMANDS.length}`);
  }

  const captured: CapturedInput[] = [];
  for (const command of DOGFOOD_COMMANDS) captured.push(await captureOne(cli, command));

  // Persist the captured fixture: the raw fact set + compact fact set + source command per
  // input, so the manifest recomputes byte-for-byte from a committed input without re-running
  // gdctx (the same shape the CLI's loadGdctxFacts reads).
  const fixture = {
    note:
      "SYSTEM (compact) vs RAW fact sets for the gdctx fact-preservation oracle. Both sides " +
      "captured from a REAL `keryx ctx run -- <command>` compaction of this repo's own tree " +
      "(dogfood) and reduced to facts via the shared, documented extractFacts rule " +
      "(src/metrics/oracle-runner.ts). rawFacts/compactFacts are what factPreservation scores; " +
      "rawLines/compactLines are for human sanity-checking, not scored.",
    repo: "keryx (dogfood, this repository)",
    generated_by: "bun scripts/benchmark/run-gdctx-oracle.ts (keryx ctx run -- <command> per input)",
    captured: new Date().toISOString().slice(0, 10),
    inputs: captured.map((c) => ({
      input: c.input,
      rawLines: c.rawText.split("\n").filter((l) => l.trim().length > 0).length,
      compactLines: c.compactText.split("\n").filter((l) => l.trim().length > 0).length,
      rawFacts: c.rawFacts,
      compactFacts: c.compactFacts,
    })),
  };
  await Bun.write(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);

  // Score: compact fact set vs raw fact set per input.
  const inputs: GdctxScoreInput[] = captured.map((c) => ({
    input: c.input,
    rawFacts: c.rawFacts,
    compactFacts: c.compactFacts,
  }));

  const manifest = buildGdctxManifest(inputs, { ladder: "metastore" });
  console.log(`# layer: gdctx (${GDCTX_FACT_PRESERVATION_LABEL})`);
  console.log(JSON.stringify(manifest, null, 2));
  console.error(`# oracle IR result — layer=gdctx (${GDCTX_FACT_PRESERVATION_LABEL})`);
  for (const runRecord of manifest.runs) {
    const o = runRecord.oracle;
    console.error(`${runRecord.task_id}: factPreservation=${o?.factPreservation?.value}`);
  }
  const result = validatePairedBenchmark(manifest);
  console.error(`# layer=gdctx manifest valid: ${result.valid ? "yes" : "no"}`);
  for (const err of result.errors) console.error(`- ${err}`);
  console.error("wrote fixtures/benchmark/keryx/gdctx-fact-preservation.json");
  if (!result.valid) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-gdctx-oracle failed (offline/bun/keryx unavailable is expected in CI): ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/oracle-runner.test.ts");
    process.exit(1);
  });
}
