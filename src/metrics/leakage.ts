// Real gold-artifact leakage check (specification.md §7, AC-5: "A dogfood case whose
// gold artifact is reachable by the agent fails its leakage assertion and is excluded
// from scoring"). This module is the deterministic check that decision rests on — never
// a guess, never "probably fine": it looks at the real filesystem state of the exact
// root an agent's tools are confined to and reports whether the gold artifact is
// actually there.
//
// Real finding this closes (docs/requirements/keryx-benchmark-suite/plan.md): the M1
// ablation runner's worktrees are a full `git worktree add --detach <path> HEAD`
// checkout (src/harness/child/git-worktree-port.ts) — which includes
// scripts/benchmark/ablation-tasks.ts and mutating-tasks.ts THEMSELVES, containing the
// exact expectedFile/expectedSymbol answer key (and, for mutating tasks, the seeded
// test that IS the solution spec). An agent with `read_file` could read its own answer
// key directly. This was never checked before AC-5; the fix is two-part: strip these
// gold-bearing files from every worktree before the agent ever sees it (the producer
// scripts do this), AND this module is the check that PROVES a given worktree is clean
// before a case is trusted, or catches it when it is not.

import { existsSync } from "node:fs";
import path from "node:path";
import type { LeakageAssertion } from "./benchmark";

export type LeakageCheckResult = {
  readonly assertion: LeakageAssertion;
  /** Repo-relative gold-artifact paths that were actually found reachable, if any. */
  readonly reachablePaths: readonly string[];
};

/**
 * Check whether any of `goldArtifactPaths` (repo-relative) exist under `agentRoot` —
 * the exact directory an agent's file-reading tools are confined to for this case.
 * `"failed"` when ANY gold artifact is reachable (AC-5's unsafe state); `"passed"` when
 * none are. Never `"not-applicable"` — this function is only called for cases that
 * genuinely have a gold artifact to check.
 */
export function checkGoldLeakage(agentRoot: string, goldArtifactPaths: readonly string[]): LeakageCheckResult {
  const reachablePaths = goldArtifactPaths.filter((relPath) => existsSync(path.join(agentRoot, relPath)));
  return { assertion: reachablePaths.length > 0 ? "failed" : "passed", reachablePaths };
}
