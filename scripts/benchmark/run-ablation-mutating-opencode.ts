// Producer for the M1 mutating-ablation slice's opencode CLI leg (docs/requirements/
// keryx-benchmark-suite/plan.md, "Remaining in M1: Ablation runner, mutating slice —
// needs a model that can actually complete the base task"). Same shape as
// run-ablation-mutating-codex.ts, but driven through `opencode run --auto` with the
// free `opencode/deepseek-v4-flash-free` OpenCode Zen provider — the SAME model family
// keryx's own harness legs use.
//
// [[opencode-headless-hang]] (session memory) originally found opencode's headless mode
// hangs on READ-ONLY comprehension tasks — but a real mutating file-edit task, live-tested
// before this script was written, completed successfully in ~60-90s with no hang. That
// finding does not generalize to "any tool-use task hangs"; this script is the real,
// full-scale confirmation.
//
// Each (task, variant, seed) gets its own fresh, FULLY INDEPENDENT git clone (see
// src/harness/child/git-clone-port.ts) — NOT a linked git worktree like every other
// mutating-ablation producer. A real, reproduced finding (2026-08-14): opencode resolves
// "project root" via a linked worktree's shared `.git` and writes its edits into the
// MAIN checkout instead of the worktree it was actually invoked in — the first full run
// (via git-worktree-port.ts) scored 0/18 because of exactly this: the edits landed in
// this repo's own real `src/lib/*.ts`, confirmed and reverted, while the independent
// verification below correctly checked the (untouched) worktree copy. An independent
// clone has no shared `.git` to walk past. Mutating tasks cannot reuse a directory
// across seeds regardless. Success is decided by an independent `bun test <seed test>`
// run after opencode's turn — never by trusting its own claim.
//
// Regenerate with (needs opencode on PATH, already authenticated with OpenCode Zen):
//   bun scripts/benchmark/run-ablation-mutating-opencode.ts

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import { buildAblationManifest, computeAblationDelta, type AblationSeedSample, type AblationTaskInput, type AblationVariant } from "../../src/metrics/ablation-runner";
import { checkGoldLeakage } from "../../src/metrics/leakage";
// A real, reproduced finding (2026-08-14, see plan.md's mutating-ablation section):
// opencode resolves "project root" via a linked `git worktree`'s shared `.git` and
// writes to the MAIN checkout instead of the worktree it was actually invoked in — an
// independent `git clone` closes that route structurally. createGitClonePort is the
// same WorktreePort shape as createGitWorktreePort, just backed by `git clone`.
import { createGitClonePort } from "../../src/harness/child/git-clone-port";
import { MUTATING_GOLD_ARTIFACT_PATH, MUTATING_TASKS, cliPrompt, type MutatingTask } from "./mutating-tasks";

const SEEDS = [1, 2, 3] as const;
const MODEL = "opencode/deepseek-v4-flash-free";
const CONTEXT_STRIP_PATHS = [".metaproject", "AGENTS.md", "CLAUDE.md"];
const MCP_CONFIG_STRIP_PATHS = ["opencode.json", ".mcp.json"];

type OpencodeEvent = { type: string; part?: Record<string, unknown>; [key: string]: unknown };

function parseOpencodeJsonl(stdout: string): OpencodeEvent[] {
  const events: OpencodeEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as OpencodeEvent);
    } catch {
      // stray non-JSON log output — skipped, not fatal
    }
  }
  return events;
}

async function runTestInWorktree(root: string, seedTestFile: string): Promise<boolean> {
  const proc = Bun.spawn(["bun", "test", seedTestFile], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function runSeed(task: MutatingTask, variant: AblationVariant, seed: number, root: string): Promise<AblationSeedSample> {
  await writeFile(join(root, task.seedTestFile), task.seedTestContent, "utf8");

  // Real, reproduced root cause (2026-08-14): `Bun.spawn`'s `cwd` option sets the
  // kernel-level working directory but does NOT update the inherited `PWD` env var —
  // and opencode's own path resolution trusts `PWD` over the OS cwd for at least some
  // file operations, so without this it silently edits files at the PARENT process's
  // PWD (this repo's real checkout) while everything else about the child process
  // (including its own reported cwd) correctly stays `root`. Confirmed via a minimal
  // isolated repro: identical Bun.spawn call, only `env.PWD` differs, escape
  // reproduces without this line and disappears with it. Neither git-worktree-port.ts
  // NOR git-clone-port.ts alone fixed this — it is not about shared `.git` state at
  // all, it is this one environment variable.
  const proc = Bun.spawn(["opencode", "run", "-m", MODEL, "--auto", "--format", "json", cliPrompt(task)], {
    cwd: root,
    env: { ...process.env, PWD: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;

  const events = parseOpencodeJsonl(stdout);
  const toolCalls = events.filter((e) => e.type === "tool_use").length;
  // Sum every step_finish's token total — opencode emits one per turn, not one grand total.
  let tokens: number | null = null;
  for (const e of events) {
    if (e.type !== "step_finish") continue;
    const total = (e.part as { tokens?: { total?: number } } | undefined)?.tokens?.total;
    if (typeof total === "number") tokens = (tokens ?? 0) + total;
  }

  // Independent verification: a real `bun test` run in the worktree opencode edited —
  // never opencode's own claim.
  const success = await runTestInWorktree(root, task.seedTestFile);
  return { seed, success, tokens, toolCalls };
}

async function main(): Promise<void> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-mutating-opencode-"));
  const port = createGitClonePort({ repoRoot, worktreesDir });

  try {
    const taskInputs: AblationTaskInput[] = [];
    for (const task of MUTATING_TASKS) {
      console.error(`\n# task: ${task.name}`);
      const contextOnSamples: AblationSeedSample[] = [];
      const contextOffSamples: AblationSeedSample[] = [];
      for (const variant of ["context-on", "context-off"] as const) {
        const samples = variant === "context-on" ? contextOnSamples : contextOffSamples;
        for (const seed of SEEDS) {
          const worktreeId = `ablation-mutating-opencode-${task.name}-${variant}-${seed}`;
          const created = await port.create(worktreeId);
          const root = created.path;
          try {
            // AC-5: strip the gold artifact before opencode ever sees this worktree, then
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
        "RAW per-seed MUTATING-ablation results, opencode CLI leg: `opencode run --auto` " +
        "(its own built-in agent loop, free OpenCode Zen deepseek-v4-flash-free provider — " +
        "the SAME model family keryx's own harness legs use) makes a real code edit to " +
        "make a seeded failing test pass, twice per seed — context-on (unmodified " +
        "checkout) vs context-off (AGENTS.md/.metaproject stripped) — each seed in its " +
        "own fresh, FULLY INDEPENDENT git clone (src/harness/child/git-clone-port.ts), " +
        "not a linked git worktree — a real, reproduced finding found opencode resolves " +
        "project root via a linked worktree's shared .git and writes into the MAIN " +
        "checkout instead, confirmed and reverted; a real clone has no shared .git to " +
        "walk past. Success is decided by an independent `bun test` run after " +
        "opencode's turn, never by trusting its own claim. Captured live, no fabricated " +
        "samples.",
      model: MODEL,
      provider: "opencode-cli",
      generated_by: "bun scripts/benchmark/run-ablation-mutating-opencode.ts",
      captured: new Date().toISOString().slice(0, 10),
      tasks: taskInputs,
    };
    const resultsUrl = new URL("../../fixtures/benchmark/keryx/ablation-mutating-results-opencode.json", import.meta.url);
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
    console.error(`\n# ladder=harness mutating-ablation (opencode leg) manifest valid: ${result.valid ? "yes" : "no"}`);
    for (const err of result.errors) console.error(`- ${err}`);
    console.error("wrote fixtures/benchmark/keryx/ablation-mutating-results-opencode.json");
    if (!result.valid) process.exit(1);
  } finally {
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation-mutating-opencode failed: ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/ablation-runner.test.ts");
    process.exit(1);
  });
}
