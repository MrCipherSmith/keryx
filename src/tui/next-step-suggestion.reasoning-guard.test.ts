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
import { readFileSync } from "node:fs";
import path from "node:path";
import { sanitizeNextStepSuggestion } from "./next-step-suggestion";

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

  test("source audit: suggestNextStep builds its prompt from history .content only, never .reasoning", () => {
    const source = readFileSync(path.join(import.meta.dir, "tui-shell.ts"), "utf8");
    const start = source.indexOf("const suggestNextStep = async (): Promise<void> => {");
    expect(start).toBeGreaterThan(-1);
    // Bound the audit to the closure body, up to its own closing brace +
    // trailing `};` (matches the next top-level statement,
    // `const foregroundIo = ...`, which is the line right after in the
    // source at the time this test was written).
    const end = source.indexOf("const foregroundIo = createForegroundAgentIoFacade", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    // The two history reads that feed the model prompt.
    expect(body).toContain("history].reverse().find((m) => m.role === \"user\")?.content");
    expect(body).toContain("history].reverse().find((m) => m.role === \"assistant\")?.content");

    // The load-bearing negative: no reasoning field is ever read inside this
    // closure — if a future edit starts pulling `.reasoning` into the prompt
    // (e.g. to give the advisor "more context"), this fails loudly.
    expect(body).not.toMatch(/\.reasoning\b/);
    expect(body).not.toContain(REASONING_MARKER);
  });
});
