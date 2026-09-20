// flow 268 T18 — guard test: next-step suggestion must build its prompt from
// answer text only, never from a history message's `reasoning` field (AC12).
//
// `sanitizeNextStepSuggestion` itself only ever sees `result.text` from
// `runModelTurn` — already pinned reasoning-clean by
// `single-turn.reasoning-guard.test.ts` — so this file covers the two load
// -bearing halves of AC12 for this consumer:
//
//   1. The pure, directly-testable unit (`sanitizeNextStepSuggestion`) is
//      exercised with a reply that legitimately CONTAINS the marker (as if a
//      leak had already happened upstream) to prove the sanitizer itself does
//      no reasoning-vs-answer filtering — it is a length/shape guard, not a
//      leak guard. The leak guard is the "only reachable by source audit"
//      half below.
//
//   2. `tui-shell.ts`'s `suggestNextStep` closure (not exported, no headless
//      injection seam — see `next-step-suggestion.ts`'s own top-of-file
//      comment, and note `tui-shell.ts` is off-limits to edit for this task:
//      another flow-268 agent owns it concurrently) builds its prompt from
//      `history` entries. This is a SOURCE-TEXT AUDIT, matching this
//      repository's own established convention for closures with no seam
//      (see `tui-shell.test.ts`'s "source-text audit" blocks, referenced by
//      `next-step-suggestion.ts` itself). It pins that the prompt-building
//      lines read `.content` from the last user/assistant history messages,
//      and never read `.reasoning` anywhere in the `suggestNextStep`
//      function body.

import { describe, expect, test } from "bun:test";
import { buildNextStepPrompt, sanitizeNextStepSuggestion } from "./next-step-suggestion";

const REASONING_MARKER = "REASONING-MARKER-268";

describe("flow 268 T18: next-step suggestion never surfaces reasoning text (AC12)", () => {
  test("sanitizeNextStepSuggestion is a pure length/shape guard — it does not itself strip a marker", () => {
    // Documents the boundary: sanitizeNextStepSuggestion has no way to know
    // "reasoning" from "answer" — that distinction must never reach it in the
    // first place. A short, markup-free reply containing the marker text
    // passes through unchanged (proving this function is not where the
    // reasoning/answer guarantee lives).
    const short = `do X ${REASONING_MARKER}`;
    expect(sanitizeNextStepSuggestion(short)).toBe(short);
  });

  // Flow 277 (P2): this was a source-text audit. It sliced `suggestNextStep`
  // out of `tui-shell.ts` and asserted the body did not match /\.reasoning\b/.
  //
  // That could only ever say a string was absent from a region of a file. It
  // could not say that reasoning cannot REACH the model — a caller that
  // passed reasoning through under another field name, or a prompt built from
  // the whole message object, would both have passed it.
  //
  // `buildNextStepPrompt` now reads `role` and `content` and nothing else, so
  // the guarantee is a property of a function and can be exercised: hand it
  // messages that carry reasoning and check the prompt for it.
  test("AC12: reasoning carried on a history message never reaches the prompt", () => {
    const prompt = buildNextStepPrompt([
      { role: "user", content: "add a login flow" },
      {
        role: "assistant",
        content: "Done.",
        // A richer message than the type asks for — exactly what a future
        // caller would pass if the history gained reasoning.
        reasoning: `secret chain of thought ${REASONING_MARKER}`,
      } as unknown as Parameters<typeof buildNextStepPrompt>[0][number],
    ]);
    expect(prompt.user).toContain("add a login flow");
    expect(prompt.user).toContain("Done.");
    expect(prompt.user).not.toContain(REASONING_MARKER);
    expect(prompt.system).not.toContain(REASONING_MARKER);
  });

  test("BOUNDARY — the prompt really is built from the history it was given", () => {
    // Without this, a `buildNextStepPrompt` that returned a constant string
    // would satisfy the test above: it contains no marker either.
    const a = buildNextStepPrompt([
      { role: "user", content: "alpha request" },
      { role: "assistant", content: "alpha reply" },
    ]);
    const b = buildNextStepPrompt([
      { role: "user", content: "beta request" },
      { role: "assistant", content: "beta reply" },
    ]);
    expect(a.user).toContain("alpha request");
    expect(b.user).toContain("beta request");
    expect(a.user).not.toEqual(b.user);
  });

  test("the LAST user and assistant messages are the ones sent, not the first", () => {
    // The closure reversed the history to find them. That is behaviour, and
    // it was never asserted — the audit only checked the `.reverse()` call
    // was present in the text.
    const prompt = buildNextStepPrompt([
      { role: "user", content: "stale question" },
      { role: "assistant", content: "stale answer" },
      { role: "user", content: "current question" },
      { role: "assistant", content: "current answer" },
    ]);
    expect(prompt.user).toContain("current question");
    expect(prompt.user).toContain("current answer");
    expect(prompt.user).not.toContain("stale question");
    expect(prompt.user).not.toContain("stale answer");
  });

  test("an empty history produces a prompt rather than throwing", () => {
    // `?? ""` in the original. A turn can settle with nothing to summarise.
    expect(() => buildNextStepPrompt([])).not.toThrow();
  });
});
