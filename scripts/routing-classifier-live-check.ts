// Flow 338, AC11 live check — run with:
//   env -u OPENROUTER_API_KEY bun scripts/routing-classifier-live-check.ts
//
// Drives `classifyTurn` (the routing classifier's own fallback chain,
// `src/harness/decision/classify-turn.ts`) over 20 realistic, hand-labeled
// `keryx shell` requests, through REAL Jev (the saved OpenRouter key in
// `~/.local/share/keryx/auth.json` — `OPENROUTER_API_KEY` is deliberately
// unset by the `env -u` above, so this exercises the SAVED-KEY fallback path
// `resolveJevApiKeyResolution` provides, same as `turn-guard-live-check.ts`'s
// own AC8 check). No `sessionProvider`/`sessionModel` is passed, so a case
// that falls through Jev never reaches the main-model classifier either —
// this script needs exactly one credential (OpenRouter), never a second one.
//
// Some requests are decided BEFORE Jev is ever called (AC2's deterministic
// shortcuts — a chit-chat greeting, or a request naming "review") — that is
// the intended fallback-chain behavior, not a bug in this check, and each
// case's report line names which layer decided it. Budget: at most ~40 Jev
// calls; 20 requests, at most one Jev HTTP call each (both questions are
// batched into one request), is nowhere near the cap. Never prints the key
// itself — only usage/cost/latency figures from Jev's own response.

import { classifyTurn } from "../src/harness/decision/classify-turn";
import { ROUTING_CATEGORIES, type RoutingCategory } from "../src/harness/routing/table";

const CANDIDATE_CATEGORIES: readonly RoutingCategory[] = ROUTING_CATEGORIES.filter((c) => c !== "default");

interface Case {
  readonly label: string;
  readonly request: string;
  readonly expected: RoutingCategory;
}

const CASES: readonly Case[] = [
  { label: "review-1", request: "Can you review the diff on this branch before I open a PR?", expected: "review" },
  { label: "review-2", request: "Please do a code review of src/commands/shell.ts and flag anything risky.", expected: "review" },
  { label: "review-3", request: "Is PR #482 safe to merge? Take a look and tell me.", expected: "review" },
  { label: "subagents-1", request: "Spawn a subagent to investigate why the flaky test keeps failing intermittently.", expected: "subagents" },
  { label: "subagents-2", request: "Dispatch three parallel subagents to audit each provider adapter for missing timeouts.", expected: "subagents" },
  { label: "subagents-3", request: "Fan this out — one subagent per package to update its changelog entry.", expected: "subagents" },
  { label: "quick-1", request: "hi", expected: "quick" },
  { label: "quick-2", request: "thanks!", expected: "quick" },
  { label: "quick-3", request: "what does LGTM mean?", expected: "quick" },
  { label: "quick-4", request: "sounds good", expected: "quick" },
  { label: "coding-1", request: "Add a retry loop with exponential backoff to the OpenRouter fetch call in providers.ts.", expected: "coding" },
  { label: "coding-2", request: "Fix the null pointer exception thrown in src/harness/provider/single-turn.ts on an empty reply.", expected: "coding" },
  { label: "coding-3", request: "Refactor the shell-config loader so nested objects merge instead of getting replaced whole.", expected: "coding" },
  { label: "coding-4", request: "Implement a debounce helper for the composer input box.", expected: "coding" },
  { label: "planning-1", request: "Help me plan the migration from the old routing table to the new one across three releases.", expected: "planning" },
  { label: "planning-2", request: "What's the best way to sequence rolling the classifier feature flag out across teams?", expected: "planning" },
  { label: "planning-3", request: "Draft an implementation plan for adding OAuth support to the CLI, milestone by milestone.", expected: "planning" },
  { label: "docs-1", request: "Update the README to document the new /route command and its default-off behavior.", expected: "docs" },
  { label: "docs-2", request: "Write API reference docs for the TaskClassifier interface and its three implementations.", expected: "docs" },
  { label: "unattended-1", request: "Run this as an unattended nightly job that checks CI health and reports failures.", expected: "unattended" },
];

async function main(): Promise<void> {
  if (typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.length > 0) {
    console.error("Refusing to run: OPENROUTER_API_KEY is set. Run this with: env -u OPENROUTER_API_KEY bun scripts/routing-classifier-live-check.ts");
    process.exit(1);
  }

  let correct = 0;
  let jevCalls = 0;
  let totalCost = 0;
  let totalLatencyMs = 0;
  let latencyCount = 0;
  const perSource: Record<string, { n: number; correct: number }> = {};

  for (const c of CASES) {
    const startedAt = Date.now();
    const outcome = await classifyTurn(c.request, CANDIDATE_CATEGORIES, { jevEnabled: true });
    const elapsedMs = Date.now() - startedAt;
    const jevTrace = outcome?.trace.find((t) => t.source === "jev");
    if (jevTrace !== undefined) {
      jevCalls += 1;
      const usage = jevTrace.result.ok ? jevTrace.result.usage : jevTrace.result.usage;
      if (usage?.cost !== undefined) totalCost += usage.cost;
    }
    const got = outcome?.result.ok ? outcome.result.category : undefined;
    const source = outcome?.result.ok ? outcome.result.source : "none";
    const gotItRight = got === c.expected;
    if (gotItRight) correct += 1;
    perSource[source] ??= { n: 0, correct: 0 };
    perSource[source]!.n += 1;
    if (gotItRight) perSource[source]!.correct += 1;
    if (outcome?.result.ok && outcome.result.source !== "deterministic") {
      totalLatencyMs += elapsedMs;
      latencyCount += 1;
    }

    console.log(`\n=== ${c.label} ===`);
    console.log(`request: ${JSON.stringify(c.request)}`);
    console.log(`expected: ${c.expected}   got: ${got ?? "(none)"}   source: ${source}   ${gotItRight ? "CORRECT" : "WRONG"}`);
    if (outcome === undefined) {
      console.log("reason: classifyTurn returned undefined");
    } else if (!outcome.result.ok) {
      console.log(`reason: ${outcome.result.reason}`);
    }
    console.log(`elapsed: ${elapsedMs}ms`);
    for (const step of outcome?.trace ?? []) {
      console.log(`  trace[${step.source}]: ${step.result.ok ? `ok -> ${step.result.category} (${step.result.confidence.toFixed(2)})` : `refused: ${step.result.reason}`}`);
    }
  }

  console.log("\n=== summary ===");
  console.log(`n = ${CASES.length}, accuracy = ${correct}/${CASES.length} (${((correct / CASES.length) * 100).toFixed(0)}%)`);
  for (const [source, stats] of Object.entries(perSource)) {
    console.log(`  by source "${source}": ${stats.correct}/${stats.n}`);
  }
  console.log(`Jev calls made: ${jevCalls} (budget: ~40)`);
  console.log(`total reported Jev cost: $${totalCost.toFixed(6)}`);
  if (latencyCount > 0) {
    console.log(`average classifier latency (non-deterministic cases): ${Math.round(totalLatencyMs / latencyCount)}ms`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
