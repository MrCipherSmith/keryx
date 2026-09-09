// Producer for the M2 comparative ladder's "raw" floor leg
// (docs/requirements/keryx-benchmark-suite/plan.md, "M2 — Comparative", scope: "Comparative
// report cells across {keryx-on, keryx-off, raw, <harness>}"). Runs the SAME model, on the
// SAME ./ablation-tasks.ts questions run-ablation.ts and run-ablation-codex.ts already use,
// through the SAME `runAgentTurn` driver — but with an EMPTY tool array. No shell, no
// read_file, nothing: the model answers purely from whatever it already knows, with zero
// ability to look at this repository at all. This is the true floor `keryx-off` (basic
// filesystem tools only, still an agent loop) is measured against, distinct from `raw`
// (no tools, no agent loop capability whatsoever).
//
// Reported as its own manifest with variant `baseline` (src/metrics/benchmark.ts) — a
// deliberately UNPAIRED variant (validatePairedBenchmarkV2 no longer requires a complement
// for it; see the "PAIRED_VARIANTS" comment there) because a raw floor has nothing to be
// paired against within its own manifest. It is combined with the keryx and harness legs by
// src/metrics/comparative.ts's buildComparativeReport, never merged into one manifest.
//
// Regenerate with (needs a live DEEPSEEK_API_KEY in the environment):
//   DEEPSEEK_API_KEY=... bun scripts/benchmark/run-ablation-raw.ts

import { runAgentTurn, type AgentDeps, type AgentIO } from "../../src/commands/agent";
import { validatePairedBenchmark, type PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { buildRawBaselineManifest, type RawBaselineSeedSample, type RawBaselineTaskInput } from "../../src/metrics/ablation-runner";
import { makeProvider } from "../../src/harness/provider/make-provider";
import type { NormalizedMessage } from "../../src/harness/provider/types";
import { applySavedApiKeys } from "../../src/lib/shell-config";
import { ABLATION_TASKS, ANSWER_FORMAT, checkAblationAnswer, type AblationTask } from "./ablation-tasks";

const SEEDS = [1, 2, 3] as const;
const PROVIDER_NAME = "deepseek";
const MODEL = "deepseek-v4-flash";
const RESULTS_FILENAME = "ablation-results-raw.json";

/** Injectable side effects for {@link finalizeRawBaselineRun} — real I/O in `main`, spies in tests. */
export type RawBaselineEmissionIO = {
  readonly writeResultsFixture: (contents: string) => Promise<void>;
  readonly printManifest: (contents: string) => void;
  readonly logLine: (line: string) => void;
};

/**
 * Decide what to emit for the raw-baseline leg, GATED on validation (same defect shape as
 * build-comparative-report.ts, fixed the same way here: previously the raw per-seed fixture
 * was written to disk and the derived manifest printed to stdout FIRST, and only afterward
 * validated — an invalid manifest's raw fixture reached disk (and build-comparative-report.ts
 * reads that fixture back as "already-validated") before the process exited non-zero.
 *
 * Choice recorded: on an invalid run, a previously-written GOOD fixture file is left ON
 * DISK, UNTOUCHED (same reasoning as build-comparative-report.ts's finalizeComparativeReport
 * — overwriting a good artifact with an invalid one destroys it for no benefit; deleting it
 * turns a transient failure into a silent data loss). Returns the exit code the caller
 * should use.
 */
export async function finalizeRawBaselineRun(
  resultsFixture: unknown,
  manifest: PairedBenchmarkManifestV2,
  validation: { readonly valid: boolean; readonly errors: readonly string[] },
  io: RawBaselineEmissionIO,
): Promise<number> {
  if (validation.valid) {
    await io.writeResultsFixture(`${JSON.stringify(resultsFixture, null, 2)}\n`);
    io.printManifest(JSON.stringify(manifest, null, 2));
  }

  io.logLine(`\n# ladder=comparative (raw leg) manifest valid: ${validation.valid ? "yes" : "no"}`);
  for (const err of validation.errors) io.logLine(`- ${err}`);

  if (validation.valid) {
    io.logLine(`wrote fixtures/benchmark/keryx/${RESULTS_FILENAME}`);
    return 0;
  }
  io.logLine(
    `invalid manifest — nothing written to disk and nothing printed to stdout; ` +
      `fixtures/benchmark/keryx/${RESULTS_FILENAME} left unchanged (a previously-written valid fixture, if any, is preserved as-is)`,
  );
  return 1;
}

const SYSTEM_INSTRUCTION =
  "You are being asked a precise question about a specific software repository you have " +
  "NOT been given access to — you have no tools, no file access, nothing but this prompt. " +
  "Answer from what you already know, or your best guess if you are not certain. " +
  `${ANSWER_FORMAT} Do not add any other text.`;

async function runSeed(task: AblationTask, seed: number, idSeq: () => string): Promise<RawBaselineSeedSample> {
  const provider = makeProvider(PROVIDER_NAME, MODEL, { fetch });
  const deps: AgentDeps = {
    provider,
    providerId: PROVIDER_NAME,
    modelId: MODEL,
    tools: [],
    systemInstruction: SYSTEM_INSTRUCTION,
    idSeq,
    // `maxToolCalls` was passed here and silently ignored: AgentDeps has no such
    // field, and scripts/ was outside the typecheck, so this cap never took effect.
    // Removed rather than renamed to `maxRounds` — enabling a cap that was never
    // applied would change what this script does and make new runs incomparable to
    // the recorded ones without anyone noticing.
  };
  let tokens = 0;
  let sawUsage = false;
  const io: AgentIO = {
    write: () => undefined,
    onUsage: (usage) => {
      sawUsage = true;
      tokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    },
  };
  const history: NormalizedMessage[] = [];
  await runAgentTurn(io, deps, history, task.prompt);
  const finalText = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  return { seed, success: checkAblationAnswer(task, finalText), tokens: sawUsage ? tokens : null };
}

async function main(): Promise<void> {
  applySavedApiKeys();
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required in the environment to run live raw-leg seeds");
  }

  let counter = 0;
  const idSeq = (): string => `id-${(counter += 1)}`;

  const taskResults: RawBaselineTaskInput[] = [];
  for (const task of ABLATION_TASKS) {
    console.error(`\n# task: ${task.name}`);
    const samples: RawBaselineSeedSample[] = [];
    for (const seed of SEEDS) {
      const sample = await runSeed(task, seed, idSeq);
      samples.push(sample);
      console.error(`  raw seed=${seed}: success=${sample.success} tokens=${sample.tokens ?? "n/a"}`);
    }
    taskResults.push({ taskId: `harness:ablation:${task.name}`, samples });
  }

  const resultsFixture = {
    note:
      "RAW per-seed comparative-ladder floor results: deepseek-v4-flash answers the SAME " +
      "ablation questions run-ablation.ts/run-ablation-codex.ts use, through the SAME " +
      "runAgentTurn driver, but with an EMPTY tool array — no file access, no repository " +
      "context of any kind. This is the zero-tool floor the comparative report's `raw` cell " +
      "measures, distinct from keryx-off (still an agent loop with basic filesystem tools). " +
      "Token usage was not reported by the provider for this zero-tool call shape (a real " +
      "gap, not fabricated as zero) — cost.tokens is omitted rather than invented.",
    model: MODEL,
    provider: PROVIDER_NAME,
    generated_by: "bun scripts/benchmark/run-ablation-raw.ts",
    captured: new Date().toISOString().slice(0, 10),
    tasks: taskResults,
  };
  const resultsUrl = new URL(`../../fixtures/benchmark/keryx/${RESULTS_FILENAME}`, import.meta.url);
  const manifest = buildRawBaselineManifest(taskResults, { ladder: "comparative", model: MODEL });
  const result = validatePairedBenchmark(manifest);
  const code = await finalizeRawBaselineRun(resultsFixture, manifest, result, {
    writeResultsFixture: async (contents) => {
      await Bun.write(resultsUrl, contents);
    },
    printManifest: (contents) => console.log(contents),
    logLine: (line) => console.error(line),
  });
  if (code !== 0) process.exit(code);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation-raw failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
