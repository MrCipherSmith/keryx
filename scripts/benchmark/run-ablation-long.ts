// Producer for the LONG-session ablation slice, keryx's own agent (flow 387 T22a).
//
// Same machinery as run-ablation-mutating.ts (src/commands/agent.ts runAgentTurn, an isolated git
// worktree per (task, variant, seed), context-on vs context-off, success decided by an independent
// check after the turn), but the tasks are the long ones in ./long-tasks.ts, built so that flow 387's
// mechanisms fire: prune + collapse (tool output past the newest 40K tokens), reasoning-replay trim,
// compaction (a context window small enough that the retained history crosses 85% of it) and spill
// (a 2100-line tool output). Per run it records the existing token metrics, repeated reads, and the
// counts of prune / compaction events (the `onContextCompaction` hook, kind "prune"), cleared results,
// collapsed records and spills, plus a volume check proving the agent actually read the corpus.
//
//   # offline wiring check, no model (seeds each task, runs its oracle on the untouched tree):
//   bun scripts/benchmark/run-ablation-long.ts --dry-run
//   # live (needs DEEPSEEK_API_KEY, or any keryx provider such as a running rapid-mlx):
//   bun scripts/benchmark/run-ablation-long.ts --tasks long --provider deepseek --seeds 1
//   # the baseline: run the SAME script from a checkout of main, with a label so it does not overwrite:
//   bun scripts/benchmark/run-ablation-long.ts --tasks long --label baseline-main
//
// Flags: --provider, --model, --tasks long|<name,name>, --seeds 1,2,3, --context-window <tokens>
// (default 64000; the compaction guard trips at 85% of it, `0` leaves compaction off), --max-tool-calls
// (default 150), --max-rounds (default 150), --label <text>, --dry-run.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../../src/commands/agent";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildAblationManifest, computeAblationDelta, type AblationTaskInput, type AblationVariant } from "../../src/metrics/ablation-runner";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { builtinMetaprojectTools } from "../../src/harness/tool/builtin/metaproject-tools";
import { builtinReadOnlyTools, type InteractiveTool } from "../../src/harness/tool/builtin/interactive-tools";
import { shellExecTool } from "../../src/harness/tool/builtin/shell-exec-tool";
import { makeProvider } from "../../src/harness/provider/make-provider";
import type { NormalizedMessage } from "../../src/harness/provider/types";
import { MechanismTracker, PRUNE_HOOK_NAME, VolumeTracker } from "./long-metrics";
import {
  argValue,
  describeSample,
  dryRun,
  finalizeLongRun,
  labelledFilename,
  mechanismRollup,
  parseSeeds,
  seedLongWorktree,
  summarizeOracle,
  worktreeReader,
  type LongRunSample,
} from "./long-runner-shared";
import { selectLongTasks, type LongTask } from "./long-tasks";
import { KeryxUsageAccumulator, RepeatedReadTracker, fixtureFilename } from "./token-metrics";

const argv = process.argv;
const PROVIDER_NAME = argValue(argv, "--provider", "deepseek");
const MODEL = argValue(argv, "--model", PROVIDER_NAME === "deepseek" ? "deepseek-v4-flash" : "unknown");
const TASK_SPEC = argValue(argv, "--tasks", "long");
const SEEDS = parseSeeds(argValue(argv, "--seeds", "1,2,3"));
const CONTEXT_WINDOW = Number(argValue(argv, "--context-window", "64000"));
const MAX_TOOL_CALLS = Number(argValue(argv, "--max-tool-calls", "150"));
const MAX_ROUNDS = Number(argValue(argv, "--max-rounds", "150"));
const LABEL = argValue(argv, "--label", "");
const LEGACY_FILENAME = PROVIDER_NAME === "deepseek" ? "ablation-long-results.json" : `ablation-long-results-${PROVIDER_NAME}.json`;
const RESULTS_FILENAME = labelledFilename(
  fixtureFilename(LEGACY_FILENAME, PROVIDER_NAME === "deepseek" ? "deepseek-v4-flash" : "unknown", MODEL),
  LABEL,
);

function buildTools(root: string, variant: AblationVariant, getSessionDir: () => string): InteractiveTool[] {
  const basic = builtinReadOnlyTools(root, { getSessionDir });
  const withShell = [...basic, shellExecTool(root)];
  return variant === "context-off" ? withShell : [...withShell, ...builtinMetaprojectTools(root)];
}

function systemInstruction(variant: AblationVariant): string {
  const tools =
    variant === "context-on"
      ? "get_cwd, list_dir, read_file, shell_exec, search_code, graph_affected, memory_search"
      : "get_cwd, list_dir, read_file, shell_exec";
  return (
    `You are doing a long, careful, multi-file job in a real repository. You have these tools: ${tools}. ` +
    "Ground every claim in what you actually read or ran. Earlier tool output may be replaced by a short note that names " +
    "a file holding the full text; read that file again when you need the detail. When you are done, reply with exactly: DONE"
  );
}

async function runSeed(
  task: LongTask,
  variant: AblationVariant,
  seed: number,
  worktreeId: string,
  port: ReturnType<typeof createGitWorktreePort>,
  idSeq: () => string,
): Promise<LongRunSample> {
  const created = await port.create(worktreeId);
  const root = created.path;
  // The live session dir lives OUTSIDE the worktree: spill files and pruned-result files go there.
  const sessionDir = await mkdtemp(join(tmpdir(), "keryx-long-session-"));
  try {
    const built = seedLongWorktree(root, task);

    const provider = makeProvider(PROVIDER_NAME, MODEL, { fetch });
    const repeated = new RepeatedReadTracker(PRUNE_HOOK_NAME);
    const mechanisms = new MechanismTracker();
    const volume = new VolumeTracker(task.volumePathPrefix, task.expectedDistinctReads);
    const usageAcc = new KeryxUsageAccumulator();
    const budgetNotes: string[] = [];
    const contextWindow = CONTEXT_WINDOW > 0 ? CONTEXT_WINDOW : undefined;
    const deps: AgentDeps = {
      onContextCompaction: (r) => {
        mechanisms.onContextCompaction(r);
        if (r.kind === "prune") repeated.onPrune();
        else repeated.onCompaction();
      },
      provider,
      providerId: PROVIDER_NAME,
      modelId: MODEL,
      tools: buildTools(root, variant, () => sessionDir),
      systemInstruction: systemInstruction(variant),
      idSeq,
      maxToolCalls: MAX_TOOL_CALLS,
      maxRounds: MAX_ROUNDS,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    let tokens = 0;
    let sawUsage = false;
    let toolCalls = 0;
    const io: AgentIO = {
      write: () => undefined,
      // Scoped to this script's own AgentIO: shell_exec is risk:"shell" and would otherwise block forever on a TTY prompt.
      requestApproval: async () => true,
      onUsage: (usage) => {
        sawUsage = true;
        usageAcc.addUsage(usage);
        tokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      },
      onToolCall: (name, input) => {
        toolCalls += 1;
        repeated.onToolCall(name, input);
        volume.onToolCall(name, input);
      },
      onToolResult: (_name, result) => {
        mechanisms.onToolResult(result.output);
        volume.onToolResult(result.output);
      },
      onSystem: (text) => {
        if (text.includes("[budget]")) budgetNotes.push(text.trim().slice(0, 200));
      },
    };
    const history: NormalizedMessage[] = [];
    const startedAt = Date.now();
    await runAgentTurn(io, deps, history, task.prompt, {
      slateSession: { dir: sessionDir, cwd: root, opened: true },
    });
    const durationMs = Date.now() - startedAt;

    // Independent verification from the files the agent left behind, never its own "DONE".
    const oracle = built.check(worktreeReader(root));
    return {
      seed,
      success: oracle.success,
      tokens: sawUsage ? tokens : null,
      toolCalls,
      model: MODEL,
      metrics: usageAcc.metrics(),
      repeatedReads: repeated.result(),
      task: task.name,
      durationMs,
      oracle: summarizeOracle(oracle),
      mechanisms: mechanisms.finish(history, contextWindow ?? null),
      volume: volume.result(),
      budgetNotes,
    };
  } finally {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    await port.remove(worktreeId).catch((cause) => {
      console.error(`worktree[${worktreeId}] cleanup failed: ${(cause as Error).message}`);
    });
  }
}

async function main(): Promise<void> {
  const tasks = selectLongTasks(TASK_SPEC);
  if (argv.includes("--dry-run")) {
    const ok = await dryRun(tasks, (line) => console.error(line));
    process.exit(ok ? 0 : 1);
  }
  if (PROVIDER_NAME === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required in the environment to run live long-ablation seeds");
  }

  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-long-"));
  const port = createGitWorktreePort({ repoRoot, worktreesDir });
  let counter = 0;
  const idSeq = (): string => `id-${(counter += 1)}`;

  try {
    const taskInputs: AblationTaskInput[] = [];
    for (const task of tasks) {
      console.error(`\n# task: ${task.name}`);
      const cells: Record<AblationVariant, LongRunSample[]> = { "context-on": [], "context-off": [] };
      for (const variant of ["context-on", "context-off"] as const) {
        for (const seed of SEEDS) {
          const sample = await runSeed(task, variant, seed, `ablation-long-${PROVIDER_NAME}-${task.name}-${variant}-${seed}`, port, idSeq);
          cells[variant].push(sample);
          console.error(describeSample(variant, sample));
        }
      }
      const roll = mechanismRollup(cells["context-on"]);
      console.error(
        `  mechanisms (context-on, ${roll.runs} runs): prune fired in ${roll.anyPrune}, collapse ${roll.anyCollapse}, ` +
          `compaction ${roll.anyCompaction}, spill ${roll.anySpill}; volumeOk ${roll.volumeOk}; success ${roll.successes}`,
      );
      taskInputs.push({
        taskId: `harness:ablation-long:${task.name}`,
        contextOn: { variant: "context-on", samples: cells["context-on"] },
        contextOff: { variant: "context-off", samples: cells["context-off"] },
      });
    }

    const resultsFixture = {
      note:
        "RAW per-seed LONG-session results: the SAME agent (src/commands/agent.ts runAgentTurn) and model run tasks built so " +
        "that flow 387's mechanisms fire (prune/collapse, reasoning trim, compaction, spill), context-on vs context-off, each seed in " +
        "its own isolated worktree. Success is an exact-value oracle over the files the agent left behind. Captured live, no fabricated samples.",
      metricsNote:
        "per sample: metrics/repeatedReads as in the mutating fixtures; oracle = per-cell score; mechanisms = prune/compaction event counts " +
        "(onContextCompaction, kind prune vs other) plus the final history's cleared results, collapsed records, spills and assistants still " +
        "carrying a reasoning replay; volume = tool calls by kind, distinct task files read and tool-output size, volumeOk=false means the run " +
        "bypassed the reads and says nothing about the mechanisms.",
      model: MODEL,
      provider: PROVIDER_NAME,
      contextWindow: CONTEXT_WINDOW > 0 ? CONTEXT_WINDOW : null,
      maxToolCalls: MAX_TOOL_CALLS,
      maxRounds: MAX_ROUNDS,
      label: LABEL.length > 0 ? LABEL : null,
      generated_by: "bun scripts/benchmark/run-ablation-long.ts",
      captured: new Date().toISOString().slice(0, 10),
      tasks: taskInputs,
    };
    const resultsUrl = new URL(`../../fixtures/benchmark/keryx/${RESULTS_FILENAME}`, import.meta.url);

    console.error("\n# deltas (context-on vs context-off, informational)");
    for (const input of taskInputs) {
      const delta = computeAblationDelta(input);
      console.error(
        `${delta.taskId}: successRate on=${delta.successRateOn} off=${delta.successRateOff}; ` +
          `medianToolCalls on=${delta.medianToolCallsOn} off=${delta.medianToolCallsOff}; ` +
          `medianTokens on=${delta.medianTokensOn ?? "n/a"} off=${delta.medianTokensOff ?? "n/a"}`,
      );
    }

    const manifest = buildAblationManifest(taskInputs, { ladder: "harness", model: MODEL, leakageAssertion: "passed" });
    const code = await finalizeLongRun(resultsFixture, manifest, validatePairedBenchmark(manifest), RESULTS_FILENAME, {
      writeResultsFixture: async (contents) => {
        await Bun.write(resultsUrl, contents);
      },
      printManifest: (contents) => console.log(contents),
      logLine: (line) => console.error(line),
    });
    if (code !== 0) process.exit(code);
  } finally {
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation-long failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
