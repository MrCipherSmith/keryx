// RED tests for SLATE-11's `TerminalState` (flow 161, T10 — AC3).
//
// Pins the module `src/session/slate-terminal-state.ts` (does NOT exist yet;
// T11 creates it). Every test below fails at IMPORT time until then — that is
// the expected RED failure for the whole file, not a per-test bug.
//
// PINNED API (see subagent-result / the tests-creator dispatch brief):
//   export type TerminalStateReason = "ask_user_unanswerable" | "budget_exhausted" | "other";
//   export interface TerminalState {
//     status: "blocked";
//     reason: TerminalStateReason;
//     courseSnapshot: Slate["course"];
//     anchorsSnapshot: Slate["anchors"];
//     occurredAt: string;
//   }
//   export function renderTerminalStateBlock(state: TerminalState): string;
//
// Shape is the literal `TerminalState` type from
// docs/requirements/slate/specification.md's "Data contracts" section — see
// that file (search "SLATE-11's terminal state"). `renderTerminalStateBlock`
// is the KERYX_INSTALLATION_RESULT-style sentinel text block SLATE-11 emits
// via `io.onSystem`/`io.write` for human/log visibility (see
// docs/docs/agent-installation-playbook.md:290-309 for the pattern this
// mirrors) — pinned sentinel line: `KERYX_TERMINAL_STATE`.

import { expect, test } from "bun:test";
import type { TerminalState } from "./slate-terminal-state";
import { renderTerminalStateBlock } from "./slate-terminal-state";
import type { SlateAnchors, SlateCourse } from "./slate";

const anchors: SlateAnchors = { root: "/repo", tree: "main", touched: ["src/foo.ts", "src/bar.ts"] };
const course: SlateCourse = { flowRef: "161" };

test("renderTerminalStateBlock: budget_exhausted — sentinel, status, reason, occurredAt, and both snapshots all present", () => {
  const state: TerminalState = {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: course,
    anchorsSnapshot: anchors,
    occurredAt: "2026-08-16T00:00:00.000Z",
  };
  const block = renderTerminalStateBlock(state);
  expect(block).toContain("KERYX_TERMINAL_STATE");
  expect(block).toContain("status: blocked");
  expect(block).toContain("reason: budget_exhausted");
  expect(block).toContain("2026-08-16T00:00:00.000Z");
  // The two snapshots must be genuinely present in SOME machine-readable form
  // (a future SLATE-10 catch-up parses this programmatically, per spec) — a
  // JSON serialization of each snapshot is the minimum bar.
  expect(block).toContain(JSON.stringify(course));
  expect(block).toContain(JSON.stringify(anchors));
});

test("renderTerminalStateBlock: ask_user_unanswerable — reason renders correctly", () => {
  const state: TerminalState = {
    status: "blocked",
    reason: "ask_user_unanswerable",
    courseSnapshot: { state: "unbound" } as unknown as SlateCourse, // minimal/empty course shape (no bound Flow)
    anchorsSnapshot: { root: "", touched: [] },
    occurredAt: "2026-08-16T01:02:03.000Z",
  };
  const block = renderTerminalStateBlock(state);
  expect(block).toContain("reason: ask_user_unanswerable");
  expect(block).toContain("status: blocked");
});

test("renderTerminalStateBlock: reason 'other' renders correctly (third union member is not dead code)", () => {
  const state: TerminalState = {
    status: "blocked",
    reason: "other",
    courseSnapshot: {},
    anchorsSnapshot: { root: "/repo", touched: [] },
    occurredAt: "2026-08-16T02:00:00.000Z",
  };
  const block = renderTerminalStateBlock(state);
  expect(block).toContain("reason: other");
});

test("renderTerminalStateBlock: pure — same input always renders the same output", () => {
  const state: TerminalState = {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: course,
    anchorsSnapshot: anchors,
    occurredAt: "2026-08-16T00:00:00.000Z",
  };
  expect(renderTerminalStateBlock(state)).toBe(renderTerminalStateBlock({ ...state }));
});

// --- F-004: bound + redact anchorsSnapshot in the rendered block --------

test("F-004: renderTerminalStateBlock bounds anchorsSnapshot.touched under a tight maxTokens budget, keeping the MOST RECENTLY touched entries and dropping the oldest", () => {
  const touched = Array.from(
    { length: 500 },
    (_, i) => `src/module-${String(i).padStart(3, "0")}-quite-a-long-descriptive-synthetic-file-name-for-budgeting.ts`,
  );
  const state: TerminalState = {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: {},
    anchorsSnapshot: { root: "/repo", touched },
    occurredAt: "2026-08-16T00:00:00.000Z",
  };

  const block = renderTerminalStateBlock(state, { maxTokens: 200 });

  // The most recently touched entry (end of the append-only array) survives.
  expect(block).toContain(touched[touched.length - 1] as string);
  // The oldest entry (start of the array) is dropped by the trim.
  expect(block).not.toContain(touched[0] as string);
  // Sanity bound on the render's own size: an UNBOUNDED render of 500 long
  // synthetic entries would run tens of thousands of characters; a properly
  // bounded one stays a small fraction of that.
  expect(block.length).toBeLessThan(5000);
});

test("F-004: renderTerminalStateBlock always keeps root even under a very small maxTokens budget (mirrors renderAnchorsBlock's required-candidate contract)", () => {
  const touched = Array.from({ length: 50 }, (_, i) => `src/file-${i}-with-a-long-enough-name-to-cost-tokens.ts`);
  const state: TerminalState = {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: {},
    anchorsSnapshot: { root: "/repo", touched },
    occurredAt: "2026-08-16T00:00:00.000Z",
  };

  const block = renderTerminalStateBlock(state, { maxTokens: 1 });

  expect(block).toContain("/repo");
});

test("F-004: renderTerminalStateBlock redacts a secret-shaped anchors.touched entry before it reaches the rendered block", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const state: TerminalState = {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: {},
    anchorsSnapshot: { root: "/repo", touched: [`src/config-with-token=${token}.ts`] },
    occurredAt: "2026-08-16T00:00:00.000Z",
  };

  const block = renderTerminalStateBlock(state);

  expect(block).not.toContain(token);
  expect(block).toContain("[REDACTED:");
});

test("F-004: renderTerminalStateBlock redacts a secret-shaped anchors.fence entry too", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const state: TerminalState = {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: {},
    anchorsSnapshot: { root: "/repo", touched: [], fence: [`token=${token}`] },
    occurredAt: "2026-08-16T00:00:00.000Z",
  };

  const block = renderTerminalStateBlock(state);

  expect(block).not.toContain(token);
  expect(block).toContain("[REDACTED:");
});

test("renderTerminalStateBlock: never mentions Course/Seeds field names as bare prose outside the JSON snapshot bodies is not required — but the block IS the machine-readable emission path, unlike Anchors' own render", () => {
  // Sanity/contract check, not a security assertion: renderAnchorsBlock
  // (slate.ts) is REQUIRED to never leak course/seeds — this function is the
  // opposite case (TerminalState legitimately carries a courseSnapshot), so
  // it must actually surface course content when the snapshot has one, or a
  // consumer (human or SLATE-10 catch-up) loses real diagnostic information.
  const state: TerminalState = {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: { flowRef: "161" },
    anchorsSnapshot: { root: "/repo", touched: [] },
    occurredAt: "2026-08-16T00:00:00.000Z",
  };
  const block = renderTerminalStateBlock(state);
  expect(block).toContain("161");
});
