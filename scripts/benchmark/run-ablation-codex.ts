// Producer for the M1 ablation runner's FRONTIER-model leg, driven by the `codex` CLI
// (docs/requirements/keryx-benchmark-suite/plan.md, "Remaining in M1: Ablation runner").
// Complements run-ablation.ts (deepseek-v4-flash, driven by src/commands/agent.ts's
// runAgentTurn with an injectable tool array) — reported as a SEPARATE manifest, never
// averaged with it, because codex is a structurally different agent: it has its own
// built-in multi-turn tool loop (generic shell `command_execution`, not an injectable
// `InteractiveTool[]`) and it auto-discovers this repo's root `AGENTS.md`, which in turn
// instructs it to read `.metaproject/index.md` before anything else. That means
// context-on/off cannot be operationalized as "which tools are offered" here (codex
// always has a shell) — instead:
//   - context-on:  the worktree is an unmodified checkout — AGENTS.md + .metaproject/
//     present, so codex naturally discovers and calls `keryx ctx rg` / `keryx gdgraph
//     find` / `keryx ctx read` on its own initiative (observed directly in a manual
//     smoke test before this script was written).
//   - context-off: the worktree has AGENTS.md, CLAUDE.md, and .metaproject/ REMOVED
//     before codex ever sees it, so it has no route to keryx tooling and falls back to
//     its own generic shell (grep/sed/find) — still a real, non-trivial baseline (unlike
//     run-ablation.ts's context-off, which has no search tool at all), so this is
//     honestly a DIFFERENT and somewhat fairer ablation than the deepseek leg; that
//     difference is called out in plan.md rather than papered over.
// Each variant runs in its own isolated git worktree (`src/harness/child/git-worktree-port.ts`).
// Sandbox is always `read-only` (`codex exec -s read-only`) — matches the read-only,
// non-mutating investigation tasks in ./ablation-tasks.ts, so no approval flow is needed.
//
// Regenerate with (needs `codex` on PATH, already authenticated — no API key):
//   bun scripts/benchmark/run-ablation-codex.ts [--model <id>]
//
// The pure scorer (buildAblationManifest) is fully unit-tested offline
// (src/metrics/ablation-runner.test.ts), so a failure here never blocks that coverage — it
// only means the fixture was not refreshed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePairedBenchmark } from "../../src/metrics/benchmark";
import {
  buildAblationManifest,
  computeAblationDelta,
  type AblationSeedSample,
  type AblationTaskInput,
  type AblationVariant,
} from "../../src/metrics/ablation-runner";
import { checkGoldLeakage } from "../../src/metrics/leakage";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { ABLATION_GOLD_ARTIFACT_PATH, ABLATION_TASKS, checkAblationAnswer, type AblationTask } from "./ablation-tasks";

const SEEDS = [1, 2, 3] as const;
// codex CLI resolves its own default model under the active ChatGPT auth
// (`codex doctor` reports `model: gpt-5.6-sol · openai`). Bare `-m terra` / `-m sol`
// were tried and rejected by the API ("not supported when using Codex with a ChatGPT
// account") — the registered id needs the full `gpt-5.6-sol` form; the default is left
// unset here (no `-m` passed to `codex exec`) so codex always resolves its own current
// default rather than this script pinning a value that could drift from it.
const MODEL = process.argv.includes("--model")
  ? (process.argv[process.argv.indexOf("--model") + 1] as string)
  : "gpt-5.6-sol";
const CONTEXT_STRIP_PATHS = [".metaproject", "AGENTS.md", "CLAUDE.md"];

type CodexEvent =
  | { type: "item.completed"; item: { id: string; type: string; text?: string } }
  | { type: "turn.completed"; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: string; [key: string]: unknown };

function parseCodexJsonl(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // A non-JSON line (stray log output) is skipped rather than failing the whole run.
    }
  }
  return events;
}

async function runSeed(task: AblationTask, variant: AblationVariant, seed: number, root: string): Promise<AblationSeedSample> {
  const proc = Bun.spawn(
    ["codex", "exec", "-s", "read-only", "--json", "-C", root, task.prompt],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;

  const events = parseCodexJsonl(stdout);
  const toolCalls = events.filter((e) => e.type === "item.completed" && (e as { item?: { type?: string } }).item?.type === "command_execution").length;
  const messages = events.filter((e) => e.type === "item.completed" && (e as { item?: { type?: string } }).item?.type === "agent_message");
  const lastMessage = messages.at(-1) as { item?: { text?: string } } | undefined;
  const finalText = lastMessage?.item?.text ?? "";
  const turnCompleted = events.find((e) => e.type === "turn.completed") as
    | { usage?: { input_tokens?: number; output_tokens?: number } }
    | undefined;
  const tokens =
    turnCompleted?.usage !== undefined
      ? (turnCompleted.usage.input_tokens ?? 0) + (turnCompleted.usage.output_tokens ?? 0)
      : null;

  return { seed, success: checkAblationAnswer(task, finalText), tokens, toolCalls };
}

async function main(): Promise<void> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-ablation-codex-"));
  const port = createGitWorktreePort({ repoRoot, worktreesDir });

  const worktreePaths = new Map<AblationVariant, string>();
  try {
    for (const variant of ["context-on", "context-off"] as const) {
      const created = await port.create(`ablation-codex-${variant}`);
      worktreePaths.set(variant, created.path);
      console.error(`worktree[${variant}]: ${created.path}`);
      // AC-5: strip the gold artifact (this repo's own answer key) from BOTH variants
      // BEFORE codex ever sees this worktree — codex has a real shell in both variants,
      // so context-off's routing-file strip below is not sufficient on its own here.
      await rm(join(created.path, ABLATION_GOLD_ARTIFACT_PATH), { force: true });
      const leakage = checkGoldLeakage(created.path, [ABLATION_GOLD_ARTIFACT_PATH]);
      if (leakage.assertion === "failed") {
        throw new Error(`AC-5: gold artifact still reachable in ${variant} worktree after strip: ${leakage.reachablePaths.join(", ")}`);
      }
    }

    // context-off: strip the routing files BEFORE codex ever sees this worktree, so it
    // has no route to keryx tooling and falls back to its own generic shell.
    const contextOffRoot = worktreePaths.get("context-off") as string;
    for (const relPath of CONTEXT_STRIP_PATHS) {
      await rm(join(contextOffRoot, relPath), { recursive: true, force: true });
    }
    console.error(`context-off: stripped ${CONTEXT_STRIP_PATHS.join(", ")} from ${contextOffRoot}`);

    const taskInputs: AblationTaskInput[] = [];
    for (const task of ABLATION_TASKS) {
      console.error(`\n# task: ${task.name}`);
      const contextOnSamples: AblationSeedSample[] = [];
      const contextOffSamples: AblationSeedSample[] = [];
      for (const variant of ["context-on", "context-off"] as const) {
        const root = worktreePaths.get(variant) as string;
        const samples = variant === "context-on" ? contextOnSamples : contextOffSamples;
        for (const seed of SEEDS) {
          const sample = await runSeed(task, variant, seed, root);
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
        "RAW per-seed ablation results, codex CLI leg: codex exec (its own built-in agent " +
        "loop, sandbox=read-only) run on THIS repository, twice per seed — context-on (an " +
        "unmodified worktree, AGENTS.md + .metaproject/ present so codex self-discovers " +
        "keryx tooling) vs context-off (AGENTS.md/CLAUDE.md/.metaproject stripped before " +
        "codex ever sees the worktree) — in isolated git worktrees. Captured live via an " +
        "already-authenticated `codex` CLI (ChatGPT account, no API key). Reported " +
        "SEPARATELY from run-ablation.ts's deepseek-v4-flash leg — never averaged: codex " +
        "is a structurally different agent (its own tool loop, not the injectable " +
        "InteractiveTool[] src/commands/agent.ts's runAgentTurn takes), and context-off " +
        "here still has a working shell (grep/sed/find), unlike the deepseek leg's " +
        "no-search-tool baseline.",
      model: MODEL,
      provider: "codex-cli",
      generated_by: "bun scripts/benchmark/run-ablation-codex.ts",
      captured: new Date().toISOString().slice(0, 10),
      tasks: taskInputs,
    };
    const resultsUrl = new URL("../../fixtures/benchmark/keryx/ablation-results-codex.json", import.meta.url);
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
    console.error(`\n# ladder=harness (codex leg) manifest valid: ${result.valid ? "yes" : "no"}`);
    for (const err of result.errors) console.error(`- ${err}`);
    console.error("wrote fixtures/benchmark/keryx/ablation-results-codex.json");
    if (!result.valid) process.exit(1);
  } finally {
    for (const variant of worktreePaths.keys()) {
      await port.remove(`ablation-codex-${variant}`).catch((cause) => {
        console.error(`worktree[${variant}] cleanup failed: ${(cause as Error).message}`);
      });
    }
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-ablation-codex failed: ${(error as Error).message}`);
    console.error("The pure scorer remains fully unit-tested offline: bun test src/metrics/ablation-runner.test.ts");
    process.exit(1);
  });
}
