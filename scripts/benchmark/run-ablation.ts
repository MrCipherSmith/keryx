// Producer for the M1 ablation runner (docs/requirements/keryx-benchmark-suite/plan.md,
// "Remaining in M1: Ablation runner"). Runs the SAME agent + model on the SAME small set
// of real, checkable investigation tasks against THIS repository, twice per seed:
//   - context-on:  basic filesystem tools + keryx metaproject tools (search_code,
//     graph_affected, memory_search) — src/harness/tool/builtin/metaproject-tools.ts.
//   - context-off: basic filesystem tools only (get_cwd, list_dir, read_file) — the
//     "raw-model+basic-tools" target from plan.md's M1 scope.
// Each variant runs in its OWN isolated git worktree (src/harness/child/git-worktree-port.ts)
// checked out from the same base ref, so neither run can see the other's state. The actual
// multi-turn agent loop is src/commands/agent.ts's runAgentTurn — the same driver `keryx
// shell --agent` uses, called headlessly (no TTY, no approval prompts: every tool offered
// here is risk `read`, so none ever needs `AgentIO.requestApproval`).
//
// Tasks are read-only code-comprehension questions with an objectively checkable answer
// (a specific file + exported symbol name this script already knows is correct — verified
// by reading the source before writing the task). This keeps the first ablation slice safe
// (no tool can mutate the worktree) while still exercising the real question M1 asks: does
// keryx's own retrieval tooling change a real agent's success/token/tool-call profile on a
// real task, not just an offline retrieval metric.
//
// Regenerate with (needs a live DEEPSEEK_API_KEY in the environment):
//   DEEPSEEK_API_KEY=... bun scripts/benchmark/run-ablation.ts
// Or point at any other `keryx` provider (src/commands/providers.ts registry) — e.g. the
// LOCAL leg via a running `rapid-mlx serve <model> --port 8010` (no key needed):
//   bun scripts/benchmark/run-ablation.ts --provider rapid-mlx --model qwen3.5-9b-4bit
// A non-default provider writes to fixtures/benchmark/keryx/ablation-results-<provider>.json
// instead of the default file, so model legs never clobber each other.
//
// The pure scorer (buildAblationManifest) is fully unit-tested offline
// (src/metrics/ablation-runner.test.ts), so a failure here never blocks that coverage — it
// only means the fixture was not refreshed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../../src/commands/agent";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildAblationManifest, computeAblationDelta, type AblationSeedSample, type AblationTaskInput, type AblationVariant } from "../../src/metrics/ablation-runner";
import { checkGoldLeakage } from "../../src/metrics/leakage";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { builtinMetaprojectTools } from "../../src/harness/tool/builtin/metaproject-tools";
import { builtinReadOnlyTools, type InteractiveTool } from "../../src/harness/tool/builtin/interactive-tools";
import { makeProvider } from "../../src/harness/provider/make-provider";
import type { NormalizedMessage } from "../../src/harness/provider/types";
import { ABLATION_GOLD_ARTIFACT_PATH, ABLATION_TASKS, ANSWER_FORMAT, checkAblationAnswer, type AblationTask } from "./ablation-tasks";

const SEEDS = [1, 2, 3] as const;

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] !== undefined ? (process.argv[index + 1] as string) : fallback;
}

const PROVIDER_NAME = argValue("--provider", "deepseek");
const MODEL = argValue("--model", PROVIDER_NAME === "deepseek" ? "deepseek-v4-flash" : "unknown");
const RESULTS_FILENAME = PROVIDER_NAME === "deepseek" ? "ablation-results.json" : `ablation-results-${PROVIDER_NAME}.json`;
type Task = AblationTask;
const TASKS = ABLATION_TASKS;
const checkAnswer = checkAblationAnswer;

function buildTools(root: string, variant: AblationVariant): InteractiveTool[] {
  const basic = builtinReadOnlyTools(root);
  if (variant === "context-off") return basic;
  return [...basic, ...builtinMetaprojectTools(root)];
}

function buildSystemInstruction(variant: AblationVariant): string {
  const toolList =
    variant === "context-on"
      ? "get_cwd, list_dir, read_file, search_code (ripgrep over the project), " +
        "graph_affected (dependency graph), memory_search (project memory)"
      : "get_cwd, list_dir, read_file";
  return (
    "You are investigating a real codebase to answer a precise question. You have ONLY " +
    `these read-only tools: ${toolList}. Use them to find the exact answer — never guess ` +
    "or answer from general knowledge; this codebase has code you have not seen before. " +
    `${ANSWER_FORMAT} Do not add any other text.`
  );
}

async function runSeed(
  task: Task,
  variant: AblationVariant,
  seed: number,
  root: string,
  idSeq: () => string,
): Promise<AblationSeedSample> {
  const provider = makeProvider(PROVIDER_NAME, MODEL, { fetch });
  const deps: AgentDeps = {
    provider,
    providerId: PROVIDER_NAME,
    modelId: MODEL,
    tools: buildTools(root, variant),
    systemInstruction: buildSystemInstruction(variant),
    idSeq,
    maxToolCalls: 12,
  };
  let tokens = 0;
  let sawUsage = false;
  let toolCalls = 0;
  const io: AgentIO = {
    write: () => undefined,
    onUsage: (usage) => {
      sawUsage = true;
      tokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    },
    onToolCall: () => {
      toolCalls += 1;
    },
  };
  const history: NormalizedMessage[] = [];
  await runAgentTurn(io, deps, history, task.prompt);
  const finalText = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
  return {
    seed,
    success: checkAnswer(task, finalText),
    tokens: sawUsage ? tokens : null,
    toolCalls,
  };
}

async function main(): Promise<void> {
  if (PROVIDER_NAME === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required in the environment to run live ablation seeds");
  }

  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-"));
  const port = createGitWorktreePort({ repoRoot, worktreesDir });

  let counter = 0;
  const idSeq = (): string => `id-${(counter += 1)}`;

  const worktreePaths = new Map<AblationVariant, string>();
  try {
    for (const variant of ["context-on", "context-off"] as const) {
      const created = await port.create(`ablation-${PROVIDER_NAME}-${variant}`);
      worktreePaths.set(variant, created.path);
      console.error(`worktree[${variant}]: ${created.path}`);
      // AC-5: strip the gold artifact (this repo's own answer key) BEFORE the agent
      // ever sees this worktree, then verify the strip actually worked — never trust
      // a live case on an unverified worktree.
      await rm(join(created.path, ABLATION_GOLD_ARTIFACT_PATH), { force: true });
      const leakage = checkGoldLeakage(created.path, [ABLATION_GOLD_ARTIFACT_PATH]);
      if (leakage.assertion === "failed") {
        throw new Error(`AC-5: gold artifact still reachable in ${variant} worktree after strip: ${leakage.reachablePaths.join(", ")}`);
      }
    }

    const taskInputs: AblationTaskInput[] = [];
    for (const task of TASKS) {
      console.error(`\n# task: ${task.name}`);
      const contextOnSamples: AblationSeedSample[] = [];
      const contextOffSamples: AblationSeedSample[] = [];
      for (const variant of ["context-on", "context-off"] as const) {
        const root = worktreePaths.get(variant) as string;
        const samples = variant === "context-on" ? contextOnSamples : contextOffSamples;
        for (const seed of SEEDS) {
          const sample = await runSeed(task, variant, seed, root, idSeq);
          samples.push(sample);
          console.error(
            `  ${variant} seed=${seed}: success=${sample.success} tokens=${sample.tokens ?? "n/a"} toolCalls=${sample.toolCalls}`,
          );
        }
      }
      taskInputs.push({
        taskId: `harness:ablation:${task.name}`,
        contextOn: { variant: "context-on", samples: contextOnSamples },
        contextOff: { variant: "context-off", samples: contextOffSamples },
      });
    }

    const resultsFixture = {
      note:
        "RAW per-seed ablation results: the SAME agent (src/commands/agent.ts runAgentTurn) " +
        "and model run on THIS repository, twice per seed — context-on (basic tools + keryx " +
        "metaproject tools) vs context-off (basic tools only) — in isolated git worktrees. " +
        "Captured live, no fabricated samples.",
      model: MODEL,
      provider: PROVIDER_NAME,
      generated_by: "bun scripts/benchmark/run-ablation.ts",
      captured: new Date().toISOString().slice(0, 10),
      tasks: taskInputs,
    };
    const resultsUrl = new URL(`../../fixtures/benchmark/keryx/${RESULTS_FILENAME}`, import.meta.url);
    await Bun.write(resultsUrl, `${JSON.stringify(resultsFixture, null, 2)}\n`);

    const manifest = buildAblationManifest(taskInputs, { ladder: "harness", model: MODEL, leakageAssertion: "passed" });
    console.log(JSON.stringify(manifest, null, 2));

    console.error("\n# deltas (context-on vs context-off, informational — not a speed claim)");
    for (const input of taskInputs) {
      const delta = computeAblationDelta(input);
      console.error(
        `${delta.taskId}: successRate on=${delta.successRateOn} off=${delta.successRateOff}; ` +
          `medianToolCalls on=${delta.medianToolCallsOn} off=${delta.medianToolCallsOff}; ` +
          `medianTokens on=${delta.medianTokensOn ?? "n/a"} off=${delta.medianTokensOff ?? "n/a"}`,
      );
    }

    const result = validatePairedBenchmark(manifest);
    console.error(`\n# ladder=harness manifest valid: ${result.valid ? "yes" : "no"}`);
    for (const err of result.errors) console.error(`- ${err}`);
    console.error(`wrote fixtures/benchmark/keryx/${RESULTS_FILENAME}`);
    if (!result.valid) process.exit(1);
  } finally {
    for (const variant of worktreePaths.keys()) {
      await port.remove(`ablation-${PROVIDER_NAME}-${variant}`).catch((cause) => {
        console.error(`worktree[${variant}] cleanup failed: ${(cause as Error).message}`);
      });
    }
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation failed: ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/ablation-runner.test.ts");
    process.exit(1);
  });
}
