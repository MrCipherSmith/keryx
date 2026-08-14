// Producer for the M1 ablation runner's MUTATING slice (docs/requirements/
// keryx-benchmark-suite/plan.md, "Remaining in M1: Ablation runner — coverage
// beyond read-only comprehension tasks to actual mutating coding tasks").
//
// Unlike scripts/benchmark/run-ablation.ts (read-only comprehension questions,
// no tool can mutate the worktree), this gives the agent a real shell_exec tool
// and asks it to make a real, small code change that makes a SEEDED, already-
// failing test pass. Each (task, variant, seed) combination gets its OWN fresh
// git worktree (scripts/benchmark/mutating-tasks.ts's tasks mutate real state,
// so — unlike the read-only runner — a worktree cannot be reused across seeds
// within a variant) via src/harness/child/git-worktree-port.ts, checked out
// from the same base ref. Success is decided by independently running
// `bun test <seed test path>` in the worktree AFTER the agent's turn — never
// by trusting the agent's own "DONE" claim.
//
// Regenerate with (needs a live DEEPSEEK_API_KEY, or point at any other
// keryx provider, e.g. a running `rapid-mlx serve <model>`):
//   bun scripts/benchmark/run-ablation-mutating.ts --provider rapid-mlx --model qwen3.5-9b-4bit
//
// The pure scorer (buildAblationManifest) is unit-tested offline already
// (src/metrics/ablation-runner.test.ts) — this script only produces raw
// samples for it, reusing the exact same manifest/protocol machinery the
// read-only ablation leg uses so both legs report through one consistent
// M1 harness ladder.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../../src/commands/agent";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildAblationManifest, computeAblationDelta, type AblationSeedSample, type AblationTaskInput, type AblationVariant } from "../../src/metrics/ablation-runner";
import { checkGoldLeakage } from "../../src/metrics/leakage";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { builtinMetaprojectTools } from "../../src/harness/tool/builtin/metaproject-tools";
import { builtinReadOnlyTools, type InteractiveTool } from "../../src/harness/tool/builtin/interactive-tools";
import { shellExecTool } from "../../src/harness/tool/builtin/shell-exec-tool";
import { makeProvider } from "../../src/harness/provider/make-provider";
import type { NormalizedMessage } from "../../src/harness/provider/types";
import { MUTATING_GOLD_ARTIFACT_PATH, MUTATING_TASKS, type MutatingTask } from "./mutating-tasks";

const SEEDS = [1, 2, 3] as const;

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] !== undefined ? (process.argv[index + 1] as string) : fallback;
}

const PROVIDER_NAME = argValue("--provider", "deepseek");
const MODEL = argValue("--model", PROVIDER_NAME === "deepseek" ? "deepseek-v4-flash" : "unknown");
const RESULTS_FILENAME =
  PROVIDER_NAME === "deepseek" ? "ablation-mutating-results.json" : `ablation-mutating-results-${PROVIDER_NAME}.json`;

function buildTools(root: string, variant: AblationVariant): InteractiveTool[] {
  const basic = builtinReadOnlyTools(root);
  const withShell = [...basic, shellExecTool(root)];
  if (variant === "context-off") return withShell;
  return [...withShell, ...builtinMetaprojectTools(root)];
}

function buildSystemInstruction(variant: AblationVariant): string {
  const toolList =
    variant === "context-on"
      ? "get_cwd, list_dir, read_file, shell_exec, search_code (ripgrep over the project), " +
        "graph_affected (dependency graph), memory_search (project memory)"
      : "get_cwd, list_dir, read_file, shell_exec";
  return (
    "You are making a real, small code change in a real TypeScript codebase to make a " +
    `failing test pass. You have these tools: ${toolList}. Ground every claim in what ` +
    "you actually read or ran — never guess file contents or invent an answer. When you " +
    "are done, reply with exactly: DONE"
  );
}

async function runTestInWorktree(root: string, seedTestFile: string): Promise<boolean> {
  const proc = Bun.spawn(["bun", "test", seedTestFile], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function runSeed(
  task: MutatingTask,
  variant: AblationVariant,
  seed: number,
  worktreeId: string,
  port: ReturnType<typeof createGitWorktreePort>,
  idSeq: () => string,
): Promise<AblationSeedSample> {
  const created = await port.create(worktreeId);
  const root = created.path;
  try {
    // AC-5: strip this repo's own gold artifact (mutating-tasks.ts, which contains
    // every task's exact solution spec) before the agent ever sees this worktree, then
    // verify the strip worked — never trust a live case on an unverified worktree.
    await rm(join(root, MUTATING_GOLD_ARTIFACT_PATH), { force: true });
    const leakage = checkGoldLeakage(root, [MUTATING_GOLD_ARTIFACT_PATH]);
    if (leakage.assertion === "failed") {
      throw new Error(`AC-5: gold artifact still reachable in worktree after strip: ${leakage.reachablePaths.join(", ")}`);
    }
    // Seed the failing test BEFORE the agent runs — it is what defines "done".
    await writeFile(join(root, task.seedTestFile), task.seedTestContent, "utf8");

    const provider = makeProvider(PROVIDER_NAME, MODEL, { fetch });
    const deps: AgentDeps = {
      provider,
      providerId: PROVIDER_NAME,
      modelId: MODEL,
      tools: buildTools(root, variant),
      systemInstruction: buildSystemInstruction(variant),
      idSeq,
      maxToolCalls: 20,
    };
    let tokens = 0;
    let sawUsage = false;
    let toolCalls = 0;
    const io: AgentIO = {
      write: () => undefined,
      // Scoped to THIS script's own AgentIO only (scripts/benchmark/run-containment.ts
      // established this pattern) — shell_exec is risk:"shell" and would otherwise
      // block forever waiting on a TTY approval prompt that never comes headlessly.
      requestApproval: async () => true,
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

    // Independent verification: a real `bun test` run against the seeded test, in the
    // SAME worktree the agent edited — never the agent's own "DONE" claim.
    const success = await runTestInWorktree(root, task.seedTestFile);
    return { seed, success, tokens: sawUsage ? tokens : null, toolCalls };
  } finally {
    await port.remove(worktreeId).catch((cause) => {
      console.error(`worktree[${worktreeId}] cleanup failed: ${(cause as Error).message}`);
    });
  }
}

async function main(): Promise<void> {
  if (PROVIDER_NAME === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required in the environment to run live mutating-ablation seeds");
  }

  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-mutating-"));
  const port = createGitWorktreePort({ repoRoot, worktreesDir });

  let counter = 0;
  const idSeq = (): string => `id-${(counter += 1)}`;

  try {
    const taskInputs: AblationTaskInput[] = [];
    for (const task of MUTATING_TASKS) {
      console.error(`\n# task: ${task.name}`);
      const contextOnSamples: AblationSeedSample[] = [];
      const contextOffSamples: AblationSeedSample[] = [];
      for (const variant of ["context-on", "context-off"] as const) {
        const samples = variant === "context-on" ? contextOnSamples : contextOffSamples;
        for (const seed of SEEDS) {
          const worktreeId = `ablation-mutating-${PROVIDER_NAME}-${task.name}-${variant}-${seed}`;
          const sample = await runSeed(task, variant, seed, worktreeId, port, idSeq);
          samples.push(sample);
          console.error(
            `  ${variant} seed=${seed}: success=${sample.success} tokens=${sample.tokens ?? "n/a"} toolCalls=${sample.toolCalls}`,
          );
        }
      }
      taskInputs.push({
        taskId: `harness:ablation-mutating:${task.name}`,
        contextOn: { variant: "context-on", samples: contextOnSamples },
        contextOff: { variant: "context-off", samples: contextOffSamples },
      });
    }

    const resultsFixture = {
      note:
        "RAW per-seed MUTATING-ablation results: the SAME agent (src/commands/agent.ts " +
        "runAgentTurn) and model make a real code edit to make a seeded failing test pass, " +
        "twice per seed — context-on (basic tools + shell_exec + keryx metaproject tools) " +
        "vs context-off (basic tools + shell_exec only) — each seed in its OWN fresh, " +
        "isolated git worktree (mutating tasks cannot reuse a worktree across seeds). " +
        "Success is decided by an independent `bun test` run after the agent's turn, never " +
        "by trusting the agent's own claim. Captured live, no fabricated samples.",
      model: MODEL,
      provider: PROVIDER_NAME,
      generated_by: "bun scripts/benchmark/run-ablation-mutating.ts",
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
    console.error(`\n# ladder=harness mutating-ablation manifest valid: ${result.valid ? "yes" : "no"}`);
    for (const err of result.errors) console.error(`- ${err}`);
    console.error(`wrote fixtures/benchmark/keryx/${RESULTS_FILENAME}`);
    if (!result.valid) process.exit(1);
  } finally {
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation-mutating failed: ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/ablation-runner.test.ts");
    process.exit(1);
  });
}
