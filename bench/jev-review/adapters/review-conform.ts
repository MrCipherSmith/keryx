// Flow 331, AC2 — the `review-conform` component adapter.
//
// `keryx review conform` has no `--live` flag (`CONFORM_FLAGS` in
// `src/commands/review.ts` does not list one) — conformance checking is
// Jev-only and always runs through `--fixtures` in this repository's test
// suite. Both arms of this adapter therefore replay the SAME committed
// fixtures under `src/commands/fixtures/conform/`; there is no live variant
// to run for AC6, and the report says so rather than silently reporting an
// offline number as if it were live.
//
// `without-jev`: the component does not exist without Jev — every clause
// comes back `not-evaluated`, which is the true state of "no automated
// conformance checking" today.
// `with-jev`: the real CLI, run against the invented fixture reference
// document and PR (never a real reference document — the fixtures are
// deliberately fictional; see `src/commands/review-conform-cli.test.ts`'s
// own header, AC10).
//
// Run with `cwd` set to `fixtures/conform-project/` (its own
// `.metaproject/tasks.config.json` opts into `review.jev.conform`) rather
// than this repository's root, so running this benchmark never has to
// enable that flag repo-wide.
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { AdapterRunContext, ComponentAdapter, ComponentArmResult, ComponentPrediction, ComponentResult } from "../types";

const FIXTURES_DIR_REL = "src/commands/fixtures/conform";
const CONFORM_PROJECT_REL = "bench/jev-review/fixtures/conform-project";

interface ConformClauseJson {
  readonly clause_id: string;
  readonly status: "satisfied" | "likely-violated" | "not-checkable" | "not-evaluated";
}
interface ConformJson {
  readonly clauses: readonly ConformClauseJson[];
  readonly usage?: { readonly jevCalls?: number; readonly inputTokens?: number; readonly costUsd?: number };
}

function runConform(ctx: AdapterRunContext): { json: ConformJson; wallClockMs: number } {
  const fixturesDir = path.join(ctx.root, FIXTURES_DIR_REL);
  const refPath = path.join(fixturesDir, "invented-ref.md");
  const conformProject = path.join(ctx.root, CONFORM_PROJECT_REL);
  const args = [ctx.cliPath, "review", "conform", "--ref", refPath, "--pr", "999", "--fixtures", fixturesDir, "--json"];
  const start = Date.now();
  const result = spawnSync(ctx.bunPath, args, {
    cwd: conformProject,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OPENROUTER_API_KEY: "sk-or-bench-offline-fixture" },
  });
  const wallClockMs = Date.now() - start;
  if (result.status !== 0) {
    throw new Error(
      `review-conform adapter: \`bun ${args.join(" ")}\` (cwd ${conformProject}) exited ${result.status ?? "null"}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return { json: JSON.parse(result.stdout) as ConformJson, wallClockMs };
}

function toResult(arm: "without-jev" | "with-jev", json: ConformJson, wallClockMs: number): ComponentArmResult {
  const predictions: ComponentPrediction[] =
    arm === "without-jev"
      ? json.clauses.map((c) => ({ id: c.clause_id, flagged: false, correct: null }))
      : json.clauses.map((c) => ({ id: c.clause_id, flagged: c.status === "likely-violated", correct: null }));
  const likelyViolatedCount = json.clauses.filter((c) => c.status === "likely-violated").length;
  return {
    component: "review-conform",
    arm,
    available: true,
    n: predictions.length,
    predictions,
    usage: {
      jevCalls: arm === "with-jev" ? (json.usage?.jevCalls ?? 0) : 0,
      inputTokens: arm === "with-jev" ? (json.usage?.inputTokens ?? 0) : 0,
      cost: arm === "with-jev" ? (json.usage?.costUsd ?? 0) : 0,
      wallClockMs,
    },
    // AC3 asks for "added true positives ... (hand-labelled sample)". Nothing in
    // this unattended run hand-labels anything, so this is always null here —
    // see `types.ts`'s field doc. The raw `likely-violated` count (candidate
    // added findings, UNLABELLED) is surfaced as a note instead of being
    // smuggled into a field whose contract says "hand-labelled".
    addedTruePositives: null,
    notes:
      arm === "without-jev"
        ? ["No automated conformance checking exists without Jev — every clause is `not-evaluated` by construction, not a measured absence of violations."]
        : [
            "Offline replay of committed fixtures (src/commands/fixtures/conform/) — `keryx review conform` has no --live flag, so this is the same result in the live run.",
            `${likelyViolatedCount} of ${json.clauses.length} clause(s) came back likely-violated — candidate added findings (AC3), NOT hand-labelled; addedTruePositives is null until a human runs that pass.`,
          ],
  };
}

export function reviewConformAdapter(): ComponentAdapter {
  return {
    id: "review-conform",
    available: true,
    async run(arm, ctx): Promise<ComponentResult> {
      const { json, wallClockMs } = runConform(ctx);
      return toResult(arm, json, wallClockMs);
    },
  };
}
