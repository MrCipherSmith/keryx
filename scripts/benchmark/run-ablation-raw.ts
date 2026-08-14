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
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildRawBaselineManifest, type RawBaselineSeedSample, type RawBaselineTaskInput } from "../../src/metrics/ablation-runner";
import { makeProvider } from "../../src/harness/provider/make-provider";
import type { NormalizedMessage } from "../../src/harness/provider/types";
import { applySavedApiKeys } from "../../src/lib/shell-config";
import { ABLATION_TASKS, ANSWER_FORMAT, checkAblationAnswer, type AblationTask } from "./ablation-tasks";

const SEEDS = [1, 2, 3] as const;
const PROVIDER_NAME = "deepseek";
const MODEL = "deepseek-v4-flash";
const RESULTS_FILENAME = "ablation-results-raw.json";

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
    maxToolCalls: 0,
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
  await Bun.write(resultsUrl, `${JSON.stringify(resultsFixture, null, 2)}\n`);

  const manifest = buildRawBaselineManifest(taskResults, { ladder: "comparative", model: MODEL });
  console.log(JSON.stringify(manifest, null, 2));

  const result = validatePairedBenchmark(manifest);
  console.error(`\n# ladder=comparative (raw leg) manifest valid: ${result.valid ? "yes" : "no"}`);
  for (const err of result.errors) console.error(`- ${err}`);
  console.error(`wrote fixtures/benchmark/keryx/${RESULTS_FILENAME}`);
  if (!result.valid) process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation-raw failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
