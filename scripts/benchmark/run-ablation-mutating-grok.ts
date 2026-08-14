// Producer for the M1 mutating-ablation slice's Grok Build CLI leg (docs/requirements/
// keryx-benchmark-suite/plan.md, "Remaining in M1: Ablation runner, mutating slice —
// needs a model that can actually complete the base task"). Same shape as
// run-ablation-mutating-codex.ts / run-ablation-mutating-opencode.ts, but driven through
// xAI's `grok` CLI (`grok -p <prompt> --always-approve --output-format json`) — a
// mature, third distinct agentic CLI with its own tool loop, live-tested and confirmed
// working headlessly (both a trivial tool-use prompt and a real mutating file-edit task)
// before this script was written.
//
// Unlike codex/opencode's JSONL event streams, `grok --output-format json` prints ONE
// final JSON object (text/usage/num_turns/modelUsage) — no per-event stream to parse.
//
// Each (task, variant, seed) gets its own fresh git worktree (mutating tasks cannot reuse
// a worktree across seeds). Success is decided by an independent `bun test <seed test>`
// run after grok's turn — never by trusting its own claim.
//
// Regenerate with (needs `grok` on PATH, already authenticated):
//   bun scripts/benchmark/run-ablation-mutating-grok.ts

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildAblationManifest, computeAblationDelta, type AblationSeedSample, type AblationTaskInput, type AblationVariant } from "../../src/metrics/ablation-runner";
import { checkGoldLeakage } from "../../src/metrics/leakage";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { MUTATING_GOLD_ARTIFACT_PATH, MUTATING_TASKS, cliPrompt, type MutatingTask } from "./mutating-tasks";

const SEEDS = [1, 2, 3] as const;
const MODEL = "grok-4.6"; // grok resolves its own current default; recorded, not pinned
const CONTEXT_STRIP_PATHS = [".metaproject", "AGENTS.md", "CLAUDE.md"];
const MCP_CONFIG_STRIP_PATHS = ["opencode.json", ".mcp.json"];

type GrokResult = {
  text?: string;
  usage?: { total_tokens?: number };
  num_turns?: number;
};

async function runTestInWorktree(root: string, seedTestFile: string): Promise<boolean> {
  const proc = Bun.spawn(["bun", "test", seedTestFile], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function runSeed(task: MutatingTask, variant: AblationVariant, seed: number, root: string): Promise<AblationSeedSample> {
  await writeFile(join(root, task.seedTestFile), task.seedTestContent, "utf8");

  const proc = Bun.spawn(["grok", "-p", cliPrompt(task), "--cwd", root, "--always-approve", "--output-format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;

  let result: GrokResult = {};
  try {
    result = JSON.parse(stdout.trim()) as GrokResult;
  } catch {
    // Malformed/empty output — tokens/toolCalls stay unmeasured, success is still
    // decided independently below.
  }
  const tokens = typeof result.usage?.total_tokens === "number" ? result.usage.total_tokens : null;
  // grok's single JSON result has no per-tool-call event stream; num_turns (model calls
  // in the agent loop) is the closest real signal, reported as an approximation.
  const toolCalls = typeof result.num_turns === "number" ? result.num_turns : 0;

  // Independent verification: a real `bun test` run in the worktree grok edited — never
  // grok's own claim.
  const success = await runTestInWorktree(root, task.seedTestFile);
  return { seed, success, tokens, toolCalls };
}

async function main(): Promise<void> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-mutating-grok-"));
  const port = createGitWorktreePort({ repoRoot, worktreesDir });

  try {
    const taskInputs: AblationTaskInput[] = [];
    for (const task of MUTATING_TASKS) {
      console.error(`\n# task: ${task.name}`);
      const contextOnSamples: AblationSeedSample[] = [];
      const contextOffSamples: AblationSeedSample[] = [];
      for (const variant of ["context-on", "context-off"] as const) {
        const samples = variant === "context-on" ? contextOnSamples : contextOffSamples;
        for (const seed of SEEDS) {
          const worktreeId = `ablation-mutating-grok-${task.name}-${variant}-${seed}`;
          const created = await port.create(worktreeId);
          const root = created.path;
          try {
            // AC-5: strip the gold artifact before grok ever sees this worktree, then
            // verify the strip worked — never trust a live case on an unverified worktree.
            await rm(join(root, MUTATING_GOLD_ARTIFACT_PATH), { force: true });
            const leakage = checkGoldLeakage(root, [MUTATING_GOLD_ARTIFACT_PATH]);
            if (leakage.assertion === "failed") {
              throw new Error(`AC-5: gold artifact still reachable in ${variant} worktree after strip: ${leakage.reachablePaths.join(", ")}`);
            }
            for (const relPath of MCP_CONFIG_STRIP_PATHS) {
              await rm(join(root, relPath), { force: true });
            }
            if (variant === "context-off") {
              for (const relPath of CONTEXT_STRIP_PATHS) {
                await rm(join(root, relPath), { recursive: true, force: true });
              }
            }
            const sample = await runSeed(task, variant, seed, root);
            samples.push(sample);
            console.error(`  ${variant} seed=${seed}: success=${sample.success} tokens=${sample.tokens ?? "n/a"} toolCalls=${sample.toolCalls}`);
          } finally {
            await port.remove(worktreeId).catch((cause) => {
              console.error(`worktree[${worktreeId}] cleanup failed: ${(cause as Error).message}`);
            });
          }
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
        "RAW per-seed MUTATING-ablation results, Grok Build CLI leg: `grok -p ... " +
        "--always-approve` (its own built-in agent loop, grok-4.6) makes a real code " +
        "edit to make a seeded failing test pass, twice per seed — context-on " +
        "(unmodified worktree) vs context-off (AGENTS.md/.metaproject stripped) — each " +
        "seed in its own fresh git worktree. Success is decided by an independent " +
        "`bun test` run after grok's turn, never by trusting its own claim. toolCalls " +
        "is grok's own reported num_turns (closest available signal — grok's " +
        "--output-format json has no per-tool-call event stream to count exactly). " +
        "Captured live, no fabricated samples.",
      model: MODEL,
      provider: "grok-cli",
      generated_by: "bun scripts/benchmark/run-ablation-mutating-grok.ts",
      captured: new Date().toISOString().slice(0, 10),
      tasks: taskInputs,
    };
    const resultsUrl = new URL("../../fixtures/benchmark/keryx/ablation-mutating-results-grok.json", import.meta.url);
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
    console.error(`\n# ladder=harness mutating-ablation (grok leg) manifest valid: ${result.valid ? "yes" : "no"}`);
    for (const err of result.errors) console.error(`- ${err}`);
    console.error("wrote fixtures/benchmark/keryx/ablation-mutating-results-grok.json");
    if (!result.valid) process.exit(1);
  } finally {
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation-mutating-grok failed: ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/ablation-runner.test.ts");
    process.exit(1);
  });
}
