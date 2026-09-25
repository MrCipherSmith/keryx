// Flow 338 — PR #737 review fix. A FRESH, held-out companion to
// `routing-classifier-live-check.ts` (AC11). That script's 20 hand-labeled
// cases were used BOTH to tune `DEFAULT_JEV_CLASSIFIER_CONFIDENCE_THRESHOLD`
// (0.6 -> 0.45, `src/harness/decision/jev-classifier.ts`) AND to report the
// resulting 20/20 accuracy — tuning on the test set. This script's 20 cases
// are NEW: none of the request text below appears in
// `routing-classifier-live-check.ts`'s `CASES`, and no threshold decision was
// made by looking at how this script scores. Run it AFTER a threshold is
// already fixed, to get an honest read of how that threshold generalizes.
//
// Run with:
//   env -u OPENROUTER_API_KEY bun scripts/routing-classifier-live-check-holdout.ts
//
// Same saved-key fallback path as the tuning script (`resolveJevApiKeyResolution`,
// `~/.local/share/keryx/auth.json`'s `OPENROUTER_API_KEY`), same ~3-4 deterministic
// shortcuts expected to short-circuit (a chit-chat greeting or a line naming
// "review"/"PR"), same "never print the key, only usage/cost/latency" contract.
// Budget: at most ~20 Jev calls (fewer than the tuning script's own 14, since
// this set is comparably sized), well under the ~30-call ceiling for this
// review pass.
//
// Covers all 7 wired categories (review, subagents, quick, coding, planning,
// docs, unattended) plus several DELIBERATELY hard/ambiguous requests (a diff
// that could be "review" or "coding", a readiness question that could be
// "review" or "planning", a work-breakdown request that names "subagent" but
// is really a "planning" ask) — the kind of request the tuning set's fairly
// clean-cut cases did not stress.

import { classifyTurn } from "../src/harness/decision/classify-turn";
import { ROUTING_CATEGORIES, type RoutingCategory } from "../src/harness/routing/table";

const CANDIDATE_CATEGORIES: readonly RoutingCategory[] = ROUTING_CATEGORIES.filter((c) => c !== "default");

interface Case {
  readonly label: string;
  readonly request: string;
  readonly expected: RoutingCategory;
  readonly hard?: boolean;
}

const CASES: readonly Case[] = [
  { label: "review-1", request: "Would you review my error-handling changes in single-turn.ts before I merge?", expected: "review" },
  { label: "review-2", request: "Take a pass over my last three commits and flag anything risky before I push.", expected: "review" },
  { label: "subagents-1", request: "Kick off a few parallel workers, one per module, to check for unused exports.", expected: "subagents" },
  { label: "subagents-2", request: "Split this security audit across several background workers so it finishes today.", expected: "subagents" },
  { label: "quick-1", request: "np", expected: "quick" },
  { label: "quick-2", request: "what's the difference between let and const in JS?", expected: "quick" },
  { label: "quick-3", request: "quick one — does keryx run on Windows?", expected: "quick" },
  { label: "quick-4", request: "k", expected: "quick" },
  { label: "coding-1", request: "There's a race condition in the classifier cache writer — add a mutex around it.", expected: "coding" },
  { label: "coding-2", request: "Port the retry helper from providers.ts so the Jev client reuses it too.", expected: "coding" },
  { label: "coding-3", request: "The shell hangs when the provider list is empty — track down and fix the bug.", expected: "coding" },
  { label: "planning-1", request: "Sketch the rollout order for turning /route on by default across every team.", expected: "planning" },
  { label: "planning-2", request: "Help me think through whether the derived layer should ship before or after the docs pass.", expected: "planning" },
  { label: "docs-1", request: "The CLI reference is missing a section on /route — write one.", expected: "docs" },
  {
    label: "docs-2-hard",
    request: "Rewrite the header comment in derive-default-table.ts so a new contributor understands the ranking rules.",
    expected: "docs",
    hard: true, // touches a code file, but the deliverable is prose explanation, not new logic — could plausibly read as "coding"
  },
  { label: "unattended-1", request: "Schedule a nightly run of the live-check script and post the accuracy to the channel.", expected: "unattended" },
  { label: "unattended-2", request: "Set this up to run on its own every morning and alert me only if it fails.", expected: "unattended" },
  {
    label: "hard-diff-fix",
    request: "Look at this diff and just fix whatever's wrong with it.",
    expected: "coding",
    hard: true, // "look at this diff" reads like review, but the ask is to FIX (write code), not just report findings
  },
  {
    label: "hard-ready-to-ship",
    request: "Is this ready to ship, or should I keep iterating?",
    expected: "review",
    hard: true, // could plausibly read as planning (a go/no-go sequencing call) instead of an assessment of existing work
  },
  {
    label: "hard-subagent-planning",
    request: "Break the OAuth migration into subagent-sized chunks and tell me what order to run them in.",
    expected: "planning",
    hard: true, // names "subagent" explicitly but the ask is HOW to sequence the work, not to spawn one
  },
];

async function main(): Promise<void> {
  if (typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.length > 0) {
    console.error("Refusing to run: OPENROUTER_API_KEY is set. Run this with: env -u OPENROUTER_API_KEY bun scripts/routing-classifier-live-check-holdout.ts");
    process.exit(1);
  }

  let correct = 0;
  let hardCorrect = 0;
  let hardTotal = 0;
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
    if (c.hard === true) {
      hardTotal += 1;
      if (gotItRight) hardCorrect += 1;
    }
    perSource[source] ??= { n: 0, correct: 0 };
    perSource[source]!.n += 1;
    if (gotItRight) perSource[source]!.correct += 1;
    if (outcome?.result.ok && outcome.result.source !== "deterministic") {
      totalLatencyMs += elapsedMs;
      latencyCount += 1;
    }

    console.log(`\n=== ${c.label}${c.hard === true ? " [HARD]" : ""} ===`);
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

  console.log("\n=== summary (HELD-OUT set — not used to pick the confidence threshold) ===");
  console.log(`n = ${CASES.length}, accuracy = ${correct}/${CASES.length} (${((correct / CASES.length) * 100).toFixed(0)}%)`);
  if (hardTotal > 0) {
    console.log(`  hard/ambiguous subset: ${hardCorrect}/${hardTotal}`);
  }
  for (const [source, stats] of Object.entries(perSource)) {
    console.log(`  by source "${source}": ${stats.correct}/${stats.n}`);
  }
  console.log(`Jev calls made: ${jevCalls} (budget: ~30 total for this review pass)`);
  console.log(`total reported Jev cost: $${totalCost.toFixed(6)}`);
  if (latencyCount > 0) {
    console.log(`average classifier latency (non-deterministic cases): ${Math.round(totalLatencyMs / latencyCount)}ms`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
