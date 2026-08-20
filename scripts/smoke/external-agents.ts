// Live smoke for the external agent runtime (flow 176, T19).
// Package: docs/requirements/keryx-external-agent-runtime.
//
// Points the REAL spawn port and the REAL git worktree port at the REAL vendor
// CLIs, through the whole runtime. Everything else in `src/harness/external/` is
// proven offline against the recorded transcripts in `fixtures/external/` with a
// fake process port — this is the one thing that cannot be, and it exists
// because the design rests on vendor CLI behaviour that drifts:
//
//   - `codex exec --json` publishes no stable event schema;
//   - `claude -p` changed its flag surface enough that a reference
//     implementation shipped a removed flag for months;
//   - the argv ordering rule exists because a variadic flag silently ate a
//     prompt, and the streaming shape exists because the obvious argv is a
//     silent no-op that three specification versions prescribed.
//
// None of those are catchable by a test that never runs the binary. Run this
// after a vendor CLI update, and after any change to a codec or the runtime.
//
// SPENDS SUBSCRIPTION QUOTA — three short runs, a few cents. It is not part of
// `bun test` for that reason, and never should be.
//
//   bun scripts/smoke/external-agents.ts
//
// Exits non-zero when any case fails or when containment leaked.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { createBunSpawnPort } from "../../src/harness/external/bun-spawn-port";
import { runExternalChild } from "../../src/harness/external/runtime";
import type { ExternalEvent } from "../../src/harness/external/types";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/** A trivial, read-only task: the point is the plumbing, not the model. */
const TASK = "Reply with exactly the word ok and nothing else. Do not read any files. Do not run any commands.";

interface SmokeCase {
  readonly name: string;
  readonly agent: string;
  readonly steerable: boolean;
}

const CASES: readonly SmokeCase[] = [
  { name: "codex one-shot", agent: "codex-cli", steerable: false },
  { name: "claude one-shot", agent: "claude-cli", steerable: false },
  // The steerable shape has no positional prompt and feeds stdin instead.
  // Getting this wrong is silent: the CLI exits 0 with zero output.
  { name: "claude steerable (stdin route)", agent: "claude-cli", steerable: true },
];

async function main(): Promise<void> {
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-external-smoke-"));
  const worktree = createGitWorktreePort({ repoRoot: REPO, worktreesDir });
  const spawn = createBunSpawnPort();
  const before = gitPorcelain();

  let failures = 0;
  try {
    for (const [i, c] of CASES.entries()) {
      console.log(`\n${"=".repeat(70)}\n${c.name}\n${"=".repeat(70)}`);
      const kinds: string[] = [];
      const warnings: string[] = [];
      const started = Date.now();

      const outcome = await runExternalChild(
        {
          runtime: { kind: "external", agent: c.agent, sandbox: "read-only" },
          allowedActions: ["read", "run-command"],
          taskTitle: "smoke",
          taskDescription: TASK,
          acceptanceCriteria: ["the reply is the single word ok"],
          worktreeId: `smoke-${i}`,
          sessionId: `00000000-0000-4000-8000-00000000000${i}`,
          maxPromptBytes: 65_536,
          timeoutMs: 180_000,
          parentEnv: process.env,
          depth: 0,
          steerable: c.steerable,
        },
        {
          spawn,
          worktree,
          // The gate is exercised by its own tests; this smoke is about the
          // process path, so it is granted here rather than reconfigured.
          capability: () => ({ enabled: true }),
          maxExternalDepth: 2,
          onEvent: (e: ExternalEvent) => kinds.push(e.kind),
          onWarning: (w) => warnings.push(w),
        },
      );

      console.log(`status:       ${outcome.status}`);
      console.log(`output:       ${JSON.stringify(outcome.output).slice(0, 300)}`);
      console.log(`sessionRef:   ${outcome.sessionRef ?? "(none announced)"}`);
      console.log(`cost:         ${outcome.costUnits ?? "MISSING"}`);
      console.log(`skippedLines: ${outcome.skippedLines ?? "(not counted)"}`);
      console.log(`elapsed:      ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(`events:       ${kinds.join(", ") || "(none)"}`);
      if (warnings.length > 0) console.log(`warnings:     ${warnings.join(" | ")}`);

      if (outcome.status !== "Completed") {
        failures += 1;
        console.log(`FAIL: expected Completed`);
      }
      // A non-zero skip count means the CLI emitted a line no codec recognises —
      // the version-drift signal this whole file exists to surface.
      if ((outcome.skippedLines ?? 0) > 0) {
        console.log(`WARN: ${outcome.skippedLines} unrecognised line(s) — the CLI may have changed its event schema`);
      }
      // The answer is checked loosely: the point is that a reply arrived and was
      // parsed, not that a model obeyed a one-word instruction.
      if (!outcome.output.toLowerCase().includes("ok")) {
        failures += 1;
        console.log(`FAIL: no recognisable answer in the output`);
      }
    }
  } finally {
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // The point of the containment design: this repository must be untouched.
  console.log(`\n${"=".repeat(70)}\ncontainment\n${"=".repeat(70)}`);
  const after = gitPorcelain();
  const introduced = after.filter((line) => !before.includes(line));
  if (introduced.length > 0) {
    failures += 1;
    console.log(`FAIL: the working tree changed:\n${introduced.join("\n")}`);
  } else {
    console.log(`working tree unchanged (${before.length} pre-existing entr${before.length === 1 ? "y" : "ies"})`);
  }
  const leaked = gitLines(["worktree", "list"]).filter((l) => l.includes("keryx-external-smoke-"));
  if (leaked.length > 0) {
    failures += 1;
    console.log(`FAIL: worktrees leaked:\n${leaked.join("\n")}`);
  } else {
    console.log("no smoke worktrees remain registered");
  }

  console.log(`\nfailed checks: ${failures}`);
  if (failures > 0) process.exit(1);
}

function gitLines(args: readonly string[]): string[] {
  const proc = Bun.spawnSync(["git", ...args], { cwd: REPO });
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

function gitPorcelain(): string[] {
  return gitLines(["status", "--porcelain"]);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`external-agents smoke failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
