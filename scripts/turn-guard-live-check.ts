// Flow 329, AC8 live check — run with: env -u OPENROUTER_API_KEY bun scripts/turn-guard-live-check.ts
//
// Drives `runTurnGuard` (the turn guard's module API, `src/tui/turn-guard-
// source.ts`) over 8 synthetic turn transcripts, through REAL Jev (the saved
// OpenRouter key in `~/.local/share/keryx/auth.json` — `OPENROUTER_API_KEY`
// is deliberately unset by the `env -u` above, so this exercises the SAVED-
// KEY fallback path `resolveJevApiKeyResolution` provides, exactly as AC8
// asks). The fake provider is not used here at all — this script only drives
// the guard's own module API directly, never a shell session.
//
// Budget: at most ~40 Jev calls. Each transcript that is not decided
// deterministically (AC3) costs exactly one `callJevSystemOne` request (both
// `done`/`contradiction` questions batched together) — 8 transcripts is
// nowhere near the cap. Never prints the key itself; only usage/cost figures
// from Jev's own response are printed.
//
// The last two cases (PR #720 review item 6) exercise item 1's fix directly
// through a REAL Jev judgement, not just the deterministic path: a `grep`
// with no match and an honestly-acknowledged flaky-test failure both used to
// risk tripping on `shell_exec`'s isError-on-any-nonzero-exit quirk before
// this fix; now neither is even a deterministic candidate (see
// `src/review/turn-guard.test.ts`'s "Item 1" describe block), so both reach
// Jev and are expected to be judged done.

import {
  createTurnGuardCollector,
  runTurnGuard,
  type TurnGuardResult,
} from "../src/tui/turn-guard-source";
import type { TurnGuardTranscript } from "../src/review/turn-guard";

interface Case {
  readonly label: string;
  readonly expectFlagged: boolean;
  readonly note: string;
  readonly transcript: TurnGuardTranscript;
}

function fromCollector(userRequest: string, steps: ReadonlyArray<{ name: string; input: string; output: string; isError?: boolean }>, finalMessage: string): TurnGuardTranscript {
  const c = createTurnGuardCollector();
  c.reset(userRequest);
  for (const step of steps) {
    c.onToolCall(step.name, step.input);
    c.onToolResult(step.name, { output: step.output, isError: step.isError ?? false });
  }
  c.onAssistantText(finalMessage);
  return c.transcript();
}

const CASES: readonly Case[] = [
  {
    label: "done-1: add a small helper, final message matches the work",
    expectFlagged: false,
    note: "genuinely done",
    transcript: fromCollector(
      "Add a formatDate helper function to src/utils/date.ts that formats a Date as YYYY-MM-DD.",
      [{ name: "apply_patch", input: JSON.stringify({ path: "src/utils/date.ts" }), output: "applied" }],
      "Added formatDate(date: Date): string to src/utils/date.ts, formatting as YYYY-MM-DD.",
    ),
  },
  {
    label: "done-2: run the tests, they pass, final message says so accurately",
    expectFlagged: false,
    note: "genuinely done",
    transcript: fromCollector(
      "Run the test suite and tell me if it passes.",
      [{ name: "shell_exec", input: JSON.stringify({ command: "bun test" }), output: " 10 pass\n 0 fail\n" }],
      "Ran the test suite: all 10 tests passed.",
    ),
  },
  {
    label: "done-3: read a config value and report it",
    expectFlagged: false,
    note: "genuinely done",
    transcript: fromCollector(
      "Read config.json and tell me what port the server listens on.",
      [{ name: "read_file", input: JSON.stringify({ path: "config.json" }), output: '{"port": 8080}' }],
      "The server listens on port 8080 (from config.json).",
    ),
  },
  {
    label: "not-done-1: a failed test run, never mentioned in the final message",
    expectFlagged: true,
    note: "failed test not mentioned (AC3 deterministic contradiction — no Jev call expected)",
    transcript: fromCollector(
      "Implement the new export feature and make sure the tests pass.",
      [{ name: "shell_exec", input: JSON.stringify({ command: "bun test" }), output: " 8 pass\n 2 fail\n", isError: true }],
      "Implemented the export feature.",
    ),
  },
  {
    label: "not-done-2: half the request done, the rest silently dropped",
    expectFlagged: true,
    note: "unanswered part of the request",
    transcript: fromCollector(
      "Add input validation to the signup form AND write a unit test for the new validation logic.",
      [{ name: "apply_patch", input: JSON.stringify({ path: "src/signup-form.ts" }), output: "applied" }],
      "Added input validation to the signup form.",
    ),
  },
  {
    label: "not-done-3: claims a fix with no edit ever made",
    expectFlagged: true,
    note: "claimed fix with no edit",
    transcript: fromCollector(
      "Fix the bug where the login button does not respond to clicks.",
      [{ name: "read_file", input: JSON.stringify({ path: "src/login-button.tsx" }), output: "// component source" }],
      "Fixed the login button bug — it now responds correctly to clicks.",
    ),
  },
  {
    label: "done-4: grep found no match, reported honestly (item 1 regression case)",
    expectFlagged: false,
    note: "grep exits nonzero on no match — must not be mistaken for a failure",
    transcript: fromCollector(
      "Check whether any file in src/ still references the old OLD_CONFIG_KEY setting.",
      [{ name: "shell_exec", input: JSON.stringify({ command: "grep -r OLD_CONFIG_KEY src" }), output: "(no output; exit 1)", isError: true }],
      "Searched src/ with grep for OLD_CONFIG_KEY — it found zero matches (grep's own exit 1 for " +
        "\"no matches\", not a failure). Nothing in src/ references the old key anymore.",
    ),
  },
  {
    label: "done-5: one flaky test failed, honestly acknowledged (item 1 regression case)",
    expectFlagged: false,
    note: "a failing test run that IS mentioned, with the failure explained, is not a contradiction",
    transcript: fromCollector(
      "Run the test suite and tell me the results.",
      [{ name: "shell_exec", input: JSON.stringify({ command: "bun test" }), output: " 9 pass\n 1 fail\n", isError: true }],
      "Ran the suite: 9 passed, 1 failed. The failing test is a known flaky one unrelated to this change — the rest pass cleanly.",
    ),
  },
];

async function main(): Promise<void> {
  if (typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.length > 0) {
    console.error("Refusing to run: OPENROUTER_API_KEY is set. Run this with: env -u OPENROUTER_API_KEY bun scripts/turn-guard-live-check.ts");
    process.exit(1);
  }

  const results: Array<{ readonly case: Case; readonly result: TurnGuardResult }> = [];
  let totalCost = 0;
  let jevCalls = 0;
  let correct = 0;

  for (const c of CASES) {
    const result = await runTurnGuard(c.transcript, { enabled: true });
    results.push({ case: c, result });
    const gotItRight = result.verdict.flagged === c.expectFlagged;
    if (gotItRight) correct += 1;
    // A Jev call happened iff `usage` came back — the deterministic-
    // contradiction path also reports `skipped: false` (it DECIDED the
    // verdict) but never calls Jev at all, so `usage` is the honest signal.
    if (result.usage !== undefined) {
      jevCalls += 1;
      if (typeof result.usage.cost === "number") totalCost += result.usage.cost;
    }
    console.log(`\n=== ${c.label} ===`);
    console.log(`note: ${c.note}`);
    console.log(`expected flagged: ${c.expectFlagged}   got: ${result.verdict.flagged}   ${gotItRight ? "CORRECT" : "WRONG"}`);
    console.log(`reason: ${result.verdict.reason}`);
    if (result.verdict.doneProbability !== undefined) console.log(`  done probability: ${result.verdict.doneProbability}`);
    if (result.verdict.contradictionProbability !== undefined) console.log(`  contradiction probability: ${result.verdict.contradictionProbability}`);
    if (result.verdict.deterministic !== undefined) console.log(`  deterministic: ${result.verdict.deterministic.kind}`);
    console.log(`skipped: ${result.skipped}${result.skipReason !== undefined ? ` (${result.skipReason})` : ""}`);
    if (result.usage !== undefined) console.log(`  usage: ${JSON.stringify(result.usage)}`);
  }

  console.log("\n=== summary ===");
  console.log(`cases: ${CASES.length}, correct: ${correct}/${CASES.length}`);
  console.log(`Jev calls made: ${jevCalls} (budget: ~40)`);
  console.log(`total reported cost: $${totalCost.toFixed(6)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
