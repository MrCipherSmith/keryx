// AC-5 dogfood demonstration (specification.md §7: "A dogfood case whose gold
// artifact is reachable by the agent fails its leakage assertion and is excluded from
// scoring"). Real finding this closes (docs/requirements/keryx-benchmark-suite/plan.md):
// every M1 ablation producer's worktree is a full `git worktree add --detach <path>
// HEAD` checkout (src/harness/child/git-worktree-port.ts) — which includes
// scripts/benchmark/ablation-tasks.ts and mutating-tasks.ts THEMSELVES, containing the
// exact expectedFile/expectedSymbol answer key (and, for mutating tasks, the seeded
// test that IS the solution spec). An agent with `read_file` could read its own answer
// key directly. This was never checked before AC-5.
//
// No LLM call is needed to demonstrate this: leakage is a property of the worktree's
// real filesystem state, decided BEFORE any agent ever runs — so this script proves the
// vulnerability was real (an unmodified worktree really does expose the gold files) and
// that the fix (stripping them, now wired into run-ablation.ts / run-ablation-codex.ts /
// run-ablation-mutating.ts) really closes it, purely with real `git worktree` operations
// and src/metrics/leakage.ts's checkGoldLeakage — never mocked, never assumed.
//
// Regenerate with: bun scripts/benchmark/run-leakage-check.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGoldLeakage } from "../../src/metrics/leakage";
import { createGitWorktreePort } from "../../src/harness/child/git-worktree-port";
import { ABLATION_GOLD_ARTIFACT_PATH } from "./ablation-tasks";
import { MUTATING_GOLD_ARTIFACT_PATH } from "./mutating-tasks";

const GOLD_ARTIFACT_PATHS = [ABLATION_GOLD_ARTIFACT_PATH, MUTATING_GOLD_ARTIFACT_PATH];

async function main(): Promise<void> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const worktreesDir = await mkdtemp(join(tmpdir(), "keryx-leakage-check-"));
  const port = createGitWorktreePort({ repoRoot, worktreesDir });

  const findings: Array<{ case: string; assertion: string; reachablePaths: string[] }> = [];
  try {
    // Case 1: an UNMODIFIED worktree — the real, unpatched state every ablation
    // producer had before this fix. This is the actual "dogfood case whose gold
    // artifact is reachable" AC-5 requires demonstrating.
    const unstripped = await port.create("leakage-check-unstripped");
    const before = checkGoldLeakage(unstripped.path, GOLD_ARTIFACT_PATHS);
    console.error(`unstripped worktree: assertion=${before.assertion} reachable=[${before.reachablePaths.join(", ")}]`);
    findings.push({ case: "unmodified-worktree", assertion: before.assertion, reachablePaths: [...before.reachablePaths] });
    if (before.assertion !== "failed") {
      throw new Error(
        "expected the unmodified worktree to demonstrate real leakage (gold artifacts reachable) — " +
          "if this no longer fails, the repository layout changed and this script needs a fresh finding, not a forced pass",
      );
    }
    // AC-5: a leaked case must be excluded from scoring, not run — no live case is
    // attempted here. This mirrors exactly what the real producer scripts now do:
    // they throw before ever calling the model when the strip did not work.

    // Case 2: the FIX applied — strip the gold artifacts before the agent ever sees
    // the worktree, exactly like run-ablation.ts / run-ablation-codex.ts /
    // run-ablation-mutating.ts do today.
    const stripped = await port.create("leakage-check-stripped");
    for (const relPath of GOLD_ARTIFACT_PATHS) {
      await rm(join(stripped.path, relPath), { force: true });
    }
    const after = checkGoldLeakage(stripped.path, GOLD_ARTIFACT_PATHS);
    console.error(`stripped worktree:   assertion=${after.assertion} reachable=[${after.reachablePaths.join(", ")}]`);
    findings.push({ case: "stripped-worktree", assertion: after.assertion, reachablePaths: [...after.reachablePaths] });
    if (after.assertion !== "passed") {
      throw new Error(`AC-5 fix did not work: gold artifacts still reachable after strip: ${after.reachablePaths.join(", ")}`);
    }

    const resultsFixture = {
      note:
        "AC-5 dogfood demonstration (specification.md §7): a REAL git worktree checkout " +
        "of this repository at HEAD genuinely exposes its own ablation gold artifacts " +
        "(scripts/benchmark/ablation-tasks.ts, mutating-tasks.ts) to an agent's read_file " +
        "tool — this is the real vulnerability every M1 ablation producer had before this " +
        "fix, not a contrived example. checkGoldLeakage (src/metrics/leakage.ts) correctly " +
        "flags it as leakageAssertion: failed on the unmodified worktree, and correctly " +
        "reports leakageAssertion: passed once the gold artifacts are stripped (the fix " +
        "now wired into run-ablation.ts, run-ablation-codex.ts, run-ablation-mutating.ts). " +
        "No live case is run against the leaked worktree — per AC-5 it is excluded from " +
        "scoring, not scored and zeroed. validatePairedBenchmarkV2's own hard invariant " +
        "(a manifest containing any leakageAssertion: failed run is invalid) is separately " +
        "unit-tested in src/metrics/benchmark.test.ts.",
      generated_by: "bun scripts/benchmark/run-leakage-check.ts",
      captured: new Date().toISOString().slice(0, 10),
      goldArtifactPaths: GOLD_ARTIFACT_PATHS,
      findings,
    };
    const resultsUrl = new URL("../../fixtures/benchmark/keryx/leakage-check.json", import.meta.url);
    await Bun.write(resultsUrl, `${JSON.stringify(resultsFixture, null, 2)}\n`);
    console.error("\n# AC-5 leakage check: real vulnerability demonstrated, real fix verified");
    console.error("wrote fixtures/benchmark/keryx/leakage-check.json");
  } finally {
    for (const id of ["leakage-check-unstripped", "leakage-check-stripped"]) {
      await port.remove(id).catch((cause) => {
        console.error(`worktree[${id}] cleanup failed: ${(cause as Error).message}`);
      });
    }
    await rm(worktreesDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`run-leakage-check failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
