// Producer for the LONG-session ablation slice, codex CLI leg (flow 387 T22a). Mirrors
// run-ablation-mutating-codex.ts (codex exec with its own agent loop, context-on/off toggled by the
// presence of AGENTS.md / .metaproject, an isolated worktree per (task, variant, seed), success decided
// by the task's oracle over the files codex left behind) but runs the long tasks in ./long-tasks.ts, so
// its token metrics can be compared with run-ablation-long.ts's keryx runs on the SAME corpus and oracle.
//
// codex's JSON stream exposes no per-request count, no tool-call arguments and no prune/compaction hook,
// so `requests`, `repeatedReads` and `mechanisms` are null here; the volume figures come from its
// command_execution events (distinct task paths named in commands, output size), a recorded heuristic.
//
//   bun scripts/benchmark/run-ablation-long-codex.ts --dry-run
//   bun scripts/benchmark/run-ablation-long-codex.ts --tasks long --seeds 1 --model gpt-5.6-sol
//
// Flags: --model (pins `codex exec -m`), --tasks long|<name,name>, --seeds 1,2,3, --timeout-min (default 45),
// --label <text>, --dry-run.

import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildAblationManifest, computeAblationDelta, type AblationTaskInput, type AblationVariant } from "../../src/metrics/ablation-runner";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { codexVolume } from "./long-metrics";
import {
  argValue,
  describeSample,
  dryRun,
  finalizeLongRun,
  labelledFilename,
  parseSeeds,
  seedLongWorktree,
  summarizeOracle,
  worktreeReader,
  type LongRunSample,
} from "./long-runner-shared";
import { selectLongTasks, type LongTask } from "./long-tasks";
import { codexMetrics, fixtureFilename } from "./token-metrics";

const argv = process.argv;
const DEFAULT_MODEL = "gpt-5.6-sol"; // recorded, not pinned, unless --model is passed (see run-ablation-mutating-codex.ts)
const PINNED_MODEL = argv.includes("--model") ? argValue(argv, "--model", "") || undefined : undefined;
const MODEL = PINNED_MODEL ?? DEFAULT_MODEL;
const TASK_SPEC = argValue(argv, "--tasks", "long");
const SEEDS = parseSeeds(argValue(argv, "--seeds", "1,2,3"));
const TIMEOUT_MS = Number(argValue(argv, "--timeout-min", "45")) * 60_000;
const LABEL = argValue(argv, "--label", "");
const RESULTS_FILENAME = labelledFilename(fixtureFilename("ablation-long-results-codex.json", DEFAULT_MODEL, MODEL), LABEL);
const CONTEXT_STRIP_PATHS = [".metaproject", "AGENTS.md", "CLAUDE.md"];
// Stripped from every worktree so no leg is influenced by an auto-discovered MCP server this benchmark does not test.
const MCP_CONFIG_STRIP_PATHS = ["opencode.json", ".mcp.json"];

type CodexEvent = { type: string; [key: string]: unknown };

function parseCodexJsonl(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // stray non-JSON log output: skipped, not fatal
    }
  }
  return events;
}

async function runSeed(task: LongTask, variant: AblationVariant, seed: number, root: string): Promise<LongRunSample> {
  const built = seedLongWorktree(root, task);
  for (const rel of MCP_CONFIG_STRIP_PATHS) rmSync(join(root, rel), { force: true });
  if (variant === "context-off") {
    for (const rel of CONTEXT_STRIP_PATHS) rmSync(join(root, rel), { recursive: true, force: true });
  }

  const modelArgs = PINNED_MODEL !== undefined ? ["-m", PINNED_MODEL] : [];
  const startedAt = Date.now();
  const proc = Bun.spawn(["codex", "exec", "--approve-for-me", "--json", ...modelArgs, "-C", root, task.cliPromptText], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const durationMs = Date.now() - startedAt;

  const events = parseCodexJsonl(stdout);
  const toolCalls = events.filter((e) => e.type === "item.completed" && (e as { item?: { type?: string } }).item?.type === "command_execution").length;
  const turn = events.find((e) => e.type === "turn.completed") as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
  const tokens = turn?.usage !== undefined ? (turn.usage.input_tokens ?? 0) + (turn.usage.output_tokens ?? 0) : null;

  const oracle = built.check(worktreeReader(root));
  return {
    seed,
    success: oracle.success,
    tokens,
    toolCalls,
    model: MODEL,
    metrics: codexMetrics(events),
    repeatedReads: null,
    task: task.name,
    durationMs,
    oracle: summarizeOracle(oracle),
    mechanisms: null,
    volume: codexVolume(events, task.volumePathPrefix, task.expectedDistinctReads),
    budgetNotes: [],
  };
}

async function main(): Promise<void> {
  const tasks = selectLongTasks(TASK_SPEC);
  if (argv.includes("--dry-run")) {
    const ok = await dryRun(tasks, (line) => console.error(line));
    process.exit(ok ? 0 : 1);
  }

  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-long-codex-"));
  const port = createGitWorktreePort({ repoRoot, worktreesDir });

  try {
    const taskInputs: AblationTaskInput[] = [];
    for (const task of tasks) {
      console.error(`\n# task: ${task.name}`);
      const cells: Record<AblationVariant, LongRunSample[]> = { "context-on": [], "context-off": [] };
      for (const variant of ["context-on", "context-off"] as const) {
        for (const seed of SEEDS) {
          const worktreeId = `ablation-long-codex-${task.name}-${variant}-${seed}`;
          const created = await port.create(worktreeId);
          try {
            const sample = await runSeed(task, variant, seed, created.path);
            cells[variant].push(sample);
            console.error(describeSample(variant, sample));
          } finally {
            await port.remove(worktreeId).catch((cause) => {
              console.error(`worktree[${worktreeId}] cleanup failed: ${(cause as Error).message}`);
            });
          }
        }
      }
      taskInputs.push({
        taskId: `harness:ablation-long:${task.name}`,
        contextOn: { variant: "context-on", samples: cells["context-on"] },
        contextOff: { variant: "context-off", samples: cells["context-off"] },
      });
    }

    const resultsFixture = {
      note:
        "RAW per-seed LONG-session results, codex CLI leg: codex exec (its own agent loop, --approve-for-me) runs the same long tasks and " +
        "oracle as run-ablation-long.ts, context-on (AGENTS.md + .metaproject present) vs context-off (stripped), each seed in its own " +
        "isolated worktree. Success is the task's exact-value oracle over the files codex left behind. Captured live, no fabricated samples.",
      metricsNote:
        "metrics from codex's turn.completed usage (input includes the cached portion); requests, repeatedReads and mechanisms are null " +
        "(not exposed by codex's JSON stream); volume is a heuristic over command_execution events. model " +
        (PINNED_MODEL !== undefined ? "was pinned with codex -m." : "is a recorded assumption, not verified from codex's output."),
      model: MODEL,
      provider: "codex-cli",
      timeoutMinutes: TIMEOUT_MS / 60_000,
      label: LABEL.length > 0 ? LABEL : null,
      generated_by: "bun scripts/benchmark/run-ablation-long-codex.ts",
      captured: new Date().toISOString().slice(0, 10),
      tasks: taskInputs,
    };
    const resultsUrl = new URL(`../../fixtures/benchmark/keryx/${RESULTS_FILENAME}`, import.meta.url);

    console.error("\n# deltas (context-on vs context-off, informational)");
    for (const input of taskInputs) {
      const delta = computeAblationDelta(input);
      console.error(
        `${delta.taskId}: successRate on=${delta.successRateOn} off=${delta.successRateOff}; ` +
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
    console.error(`run-ablation-long-codex failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
