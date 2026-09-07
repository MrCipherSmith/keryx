// Producer for the M1 mutating-ablation slice's codex CLI leg (docs/requirements/
// keryx-benchmark-suite/plan.md, "Remaining in M1: Ablation runner, mutating slice —
// needs a model that can actually complete the base task"). Mirrors
// run-ablation-codex.ts's read-only leg (own built-in shell tool loop, context-on/off
// toggled by presence/absence of AGENTS.md/.metaproject) but for the MUTATING tasks in
// ./mutating-tasks.ts: codex must make a real code edit that makes a SEEDED, already-
// failing test pass. Each (task, variant, seed) gets its own fresh git worktree (mutating
// tasks cannot reuse a worktree across seeds). Success is decided by an independent
// `bun test <seed test>` run after codex's turn — never by trusting its own "DONE" claim.
//
// `codex exec` needs `--approve-for-me` (routes approval through automatic review under
// a workspace-write sandbox) for a headless mutating task — plain `codex exec` silently
// cancels file-write tool calls without it, and `-s <mode>` cannot be combined with
// `--approve-for-me` (they conflict; `--approve-for-me` sets its own sandbox).
//
// Regenerate with (needs `codex` on PATH, already authenticated):
//   bun scripts/benchmark/run-ablation-mutating-codex.ts

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePairedBenchmark, type PairedBenchmarkManifestV2 } from "../../src/metrics/benchmark";
import { buildAblationManifest, computeAblationDelta, type AblationSeedSample, type AblationTaskInput, type AblationVariant } from "../../src/metrics/ablation-runner";
import { checkGoldLeakage } from "../../src/metrics/leakage";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { MUTATING_GOLD_ARTIFACT_PATH, MUTATING_TASKS, cliPrompt, type MutatingTask } from "./mutating-tasks";

const SEEDS = [1, 2, 3] as const;

/** Injectable side effects for {@link finalizeMutatingCodexRun} — real I/O in `main`, spies in tests. */
export type AblationEmissionIO = {
  readonly writeResultsFixture: (contents: string) => Promise<void>;
  readonly printManifest: (contents: string) => void;
  readonly logLine: (line: string) => void;
};

/**
 * Decide what to emit for the mutating codex leg, GATED on validation (same defect shape
 * fixed across every scripts/benchmark/run-ablation*.ts producer). Choice recorded: on an
 * invalid run, a previously-written GOOD fixture file is left ON DISK, UNTOUCHED (same
 * reasoning as build-comparative-report.ts's finalizeComparativeReport). Returns the exit
 * code the caller should use.
 */
export async function finalizeMutatingCodexRun(
  resultsFixture: unknown,
  manifest: PairedBenchmarkManifestV2,
  validation: { readonly valid: boolean; readonly errors: readonly string[] },
  io: AblationEmissionIO,
): Promise<number> {
  const resultsFilename = "ablation-mutating-results-codex.json";
  if (validation.valid) {
    await io.writeResultsFixture(`${JSON.stringify(resultsFixture, null, 2)}\n`);
    io.printManifest(JSON.stringify(manifest, null, 2));
  }

  io.logLine(`\n# ladder=harness mutating-ablation (codex leg) manifest valid: ${validation.valid ? "yes" : "no"}`);
  for (const err of validation.errors) io.logLine(`- ${err}`);

  if (validation.valid) {
    io.logLine(`wrote fixtures/benchmark/keryx/${resultsFilename}`);
    return 0;
  }
  io.logLine(
    `invalid manifest — nothing written to disk and nothing printed to stdout; ` +
      `fixtures/benchmark/keryx/${resultsFilename} left unchanged (a previously-written valid fixture, if any, is preserved as-is)`,
  );
  return 1;
}
const MODEL = "gpt-5.6-sol"; // codex resolves its own default under ChatGPT auth; recorded, not pinned — see run-ablation-codex.ts
const CONTEXT_STRIP_PATHS = [".metaproject", "AGENTS.md", "CLAUDE.md"];
// This repo's own root now carries a real opencode.json + .mcp.json (keryx mcp install).
// Stripped from every worktree regardless of harness, so no leg's tool choices are ever
// influenced by an auto-discovered MCP server this benchmark isn't testing.
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

  const proc = Bun.spawn(["codex", "exec", "--approve-for-me", "--json", "-C", root, cliPrompt(task)], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;

  const events = parseCodexJsonl(stdout);
  const toolCalls = events.filter((e) => e.type === "item.completed" && (e as { item?: { type?: string } }).item?.type === "command_execution").length;
  const turnCompleted = events.find((e) => e.type === "turn.completed") as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
  const tokens = turnCompleted?.usage !== undefined ? (turnCompleted.usage.input_tokens ?? 0) + (turnCompleted.usage.output_tokens ?? 0) : null;

  // Independent verification: a real `bun test` run in the worktree codex edited —
  // never codex's own claim.
  const success = await runTestInWorktree(root, task.seedTestFile);
  return { seed, success, tokens, toolCalls };
}

async function main(): Promise<void> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-mutating-codex-"));
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
          const worktreeId = `ablation-mutating-codex-${task.name}-${variant}-${seed}`;
          const created = await port.create(worktreeId);
          const root = created.path;
          try {
            // AC-5: strip the gold artifact before codex ever sees this worktree, then
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
        "RAW per-seed MUTATING-ablation results, codex CLI leg: codex exec (its own " +
        "built-in agent loop, --approve-for-me for headless file-write approval) makes a " +
        "real code edit to make a seeded failing test pass, twice per seed — context-on " +
        "(unmodified worktree, AGENTS.md + .metaproject/ present) vs context-off (those " +
        "stripped before codex ever sees the worktree, leaving a real but keryx-blind " +
        "shell) — each seed in its own fresh git worktree. Success is decided by an " +
        "independent `bun test` run after codex's turn, never by trusting its own claim. " +
        "Captured live, no fabricated samples.",
      model: MODEL,
      provider: "codex-cli",
      generated_by: "bun scripts/benchmark/run-ablation-mutating-codex.ts",
      captured: new Date().toISOString().slice(0, 10),
      tasks: taskInputs,
    };
    const resultsUrl = new URL("../../fixtures/benchmark/keryx/ablation-mutating-results-codex.json", import.meta.url);

    console.error("\n# deltas (context-on vs context-off, informational — not a speed claim)");
    for (const input of taskInputs) {
      const delta = computeAblationDelta(input);
      console.error(
        `${delta.taskId}: successRate on=${delta.successRateOn} off=${delta.successRateOff}; ` +
          `medianToolCalls on=${delta.medianToolCallsOn} off=${delta.medianToolCallsOff}; ` +
          `medianTokens on=${delta.medianTokensOn ?? "n/a"} off=${delta.medianTokensOff ?? "n/a"}`,
      );
    }

    const manifest = buildAblationManifest(taskInputs, { ladder: "harness", model: MODEL, leakageAssertion: "passed" });
    const result = validatePairedBenchmark(manifest);
    const code = await finalizeMutatingCodexRun(resultsFixture, manifest, result, {
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
    console.error(`run-ablation-mutating-codex failed: ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/ablation-runner.test.ts");
    process.exit(1);
  });
}
