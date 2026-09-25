// Flow 331, AC2 — the `ci-triage` component adapter.
//
// `without-jev`: there is no non-Jev CI-triage in this codebase to compare
// against — Jev IS the classifier. The honest baseline is the pipeline's
// behaviour BEFORE this component existed: every red CI run gets escalated
// as a real regression (the conservative default; a human decides). That is
// a synthetic comparator, not a measurement of a system that ever ran in
// production, and is labelled as such everywhere it is reported (AC4).
//
// `with-jev`: shells to `bun <cliPath> review ci-triage --eval <manifest>
// --json [--live]` — the actual CLI under test in THIS worktree (never the
// installed `keryx` binary; see flow 331 context.md item 3), reusing
// `--eval`'s existing offline/`--live` split rather than re-implementing
// it. Offline replays the committed fixtures under
// `src/commands/fixtures/ci-triage-eval/cases/*` (hermetic, no network);
// `--live` calls the real `gh`/Jev per case.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AdapterRunContext, ComponentAdapter, ComponentArmResult, ComponentPrediction, ComponentResult } from "../types";

export const CI_TRIAGE_EVAL_MANIFEST = "src/commands/fixtures/ci-triage-eval/manifest.json";

interface EvalCase {
  readonly id: string;
  readonly truth: string;
}
interface EvalManifest {
  readonly cases: readonly EvalCase[];
}

interface EvalCaseResult {
  readonly id: string;
  readonly truth: string;
  readonly predictedAfter: string;
  readonly correctAfter: boolean;
  readonly usageAfter?: { readonly input_tokens?: number; readonly cost?: number };
}
interface EvalJson {
  readonly live: boolean;
  readonly cases: number;
  readonly after: { readonly accuracy: number; readonly costUsd: number };
  readonly results: readonly EvalCaseResult[];
}

function readManifest(root: string): EvalManifest {
  return JSON.parse(readFileSync(path.join(root, CI_TRIAGE_EVAL_MANIFEST), "utf8")) as EvalManifest;
}

function naiveBaseline(root: string): ComponentArmResult {
  const manifest = readManifest(root);
  const predictions: ComponentPrediction[] = manifest.cases.map((c) => ({
    id: c.id,
    flagged: true,
    correct: c.truth === "real-regression",
  }));
  return {
    component: "ci-triage",
    arm: "without-jev",
    available: true,
    n: predictions.length,
    predictions,
    usage: { jevCalls: 0, inputTokens: 0, cost: 0, wallClockMs: 0 },
    addedTruePositives: null,
    notes: [
      "Synthetic comparator, not a system that ran in production: predicts \"real-regression\" for every failing job " +
        "(the conservative pre-triage default — escalate everything to a human) and scores it against the eval set's truth labels.",
    ],
  };
}

function runEval(ctx: AdapterRunContext, live: boolean): { json: EvalJson; wallClockMs: number } {
  const manifestPath = path.join(ctx.root, CI_TRIAGE_EVAL_MANIFEST);
  const args = [ctx.cliPath, "review", "ci-triage", "--eval", manifestPath, "--json", ...(live ? ["--live"] : [])];
  const start = Date.now();
  // Offline mode never sends this key anywhere (the fixture answers every
  // question), but `resolveJevApiKeyResolution` still requires SOME value
  // to be present as a preflight gate — a synthetic one keeps the offline
  // path hermetic instead of depending on whatever credential happens to be
  // saved in the ambient environment (AC5/AC7). `--live` uses the real
  // environment untouched, so the real saved/env credential resolves.
  const env = live ? process.env : { ...process.env, OPENROUTER_API_KEY: "sk-or-bench-offline-fixture" };
  const result = spawnSync(ctx.bunPath, args, { cwd: ctx.root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  const wallClockMs = Date.now() - start;
  if (result.status !== 0) {
    throw new Error(
      `ci-triage adapter: \`bun ${args.join(" ")}\` exited ${result.status ?? "null"}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return { json: JSON.parse(result.stdout) as EvalJson, wallClockMs };
}

function withJev(ctx: AdapterRunContext): ComponentArmResult {
  const { json, wallClockMs } = runEval(ctx, ctx.live);
  const predictions: ComponentPrediction[] = json.results.map((r) => ({ id: r.id, flagged: true, correct: r.correctAfter }));
  // Conservative call-count estimate: `usageAfter` is reported once per case
  // in the eval JSON, but the harness also computes a `usageBefore` pass
  // internally (visible in the non-adapter `--json` output) — counted here
  // as up to two Jev calls per case so the cost-cap pre-flight (AC5/AC6)
  // never under-estimates.
  const jevCalls = json.results.length * 2;
  const inputTokens = json.results.reduce((sum, r) => sum + (r.usageAfter?.input_tokens ?? 0), 0);
  return {
    component: "ci-triage",
    arm: "with-jev",
    available: true,
    n: predictions.length,
    predictions,
    usage: { jevCalls, inputTokens, cost: json.after.costUsd, wallClockMs },
    addedTruePositives: null,
    notes: [
      json.live
        ? "Live: real gh + Jev calls via `keryx review ci-triage --eval --live`."
        : "Offline: replayed from committed fixtures under src/commands/fixtures/ci-triage-eval/cases/* — hermetic, no network.",
    ],
  };
}

export function ciTriageAdapter(): ComponentAdapter {
  return {
    id: "ci-triage",
    available: true,
    async run(arm, ctx): Promise<ComponentResult> {
      if (arm === "without-jev") return naiveBaseline(ctx.root);
      return withJev(ctx);
    },
  };
}
