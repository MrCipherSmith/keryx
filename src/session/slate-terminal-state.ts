// SLATE-11: structured stop record for an unattended session (flow 161, T11 —
// AC3). Replaces `commands/agent.ts`'s `finishWithBudgetSummary` free-text
// `"Do NOT call tools."` push on the unattended path, and is also emitted
// when an unattended session's model calls `ask_user` (no human is present
// to answer it) — see `agent.ts`'s `runAgentTurnCore` for both call sites.
//
// Pure storage/rendering only — no dependency on `commands/*`/`harness/*`,
// mirroring `slate.ts`/`slate-lifecycle.ts`/`slate-course.ts`'s own
// one-concept-per-file convention and layering.

import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { estimateTokens } from "../gdgraph/repomap";
import { redactSensitiveText } from "../security/redact";
import { redactAndBoundTouched, type SlateAnchors, type SlateCourse } from "./slate";

/** Why an unattended turn stopped. `"other"` is reserved for a future caller. */
export type TerminalStateReason = "ask_user_unanswerable" | "budget_exhausted" | "other";

/**
 * A structured, machine-readable stop record (spec's "Data contracts"
 * section). `courseSnapshot`/`anchorsSnapshot` are the RAW `Slate["course"]`/
 * `Slate["anchors"]` values straight off disk at the moment the turn stopped
 * — never `slate-course.ts`'s live `CourseProjection` — so a future SLATE-10
 * catch-up can reconstruct exactly what the slate looked like at the stop
 * point, not a re-derived projection of it.
 */
export interface TerminalState {
  status: "blocked";
  reason: TerminalStateReason;
  courseSnapshot: SlateCourse;
  anchorsSnapshot: SlateAnchors;
  occurredAt: string;
}

/**
 * Default token budget for {@link renderTerminalStateBlock}'s rendered
 * `anchorsSnapshot.touched` (F-004, review remediation) when the caller
 * passes no `opts.maxTokens`. Mirrors `slate.ts`'s `renderAnchorsBlock`
 * default (`DEFAULT_RENDER_MAX_TOKENS`, also 2000) — the same "generous for
 * a normal session, still bounded for a pathologically long one" rationale
 * applies here, since `anchors.touched` is the same unbounded, append-only
 * array in both cases.
 */
const DEFAULT_TERMINAL_STATE_MAX_TOKENS = 2000;

/**
 * Build a rendering-only copy of `anchors` (F-004, review remediation) whose
 * `touched`/`fence` string fields are redacted, and whose `touched` array is
 * token-bounded — mirroring `renderAnchorsBlock`'s (slate.ts) own two rules
 * exactly: most-recent-first selection so a tight budget drops the OLDEST
 * entries (not the newest), survivors restored to chronological
 * (oldest-survivor-first) order, and `root`/`tree`/`runtime` (small,
 * fixed-size fields) always kept in full — only `touched` can grow
 * unboundedly across a long session, so only `touched` is ever trimmed.
 * `touched`'s own redaction + bounding is delegated to `slate.ts`'s shared
 * `redactAndBoundTouched` (review finding 1 / finding 7) — the SAME
 * implementation `renderAnchorsBlock` itself now uses, so the two can no
 * longer independently drift the way they did before this fix (this
 * module's `touched` redaction predates `renderAnchorsBlock`'s own).
 *
 * Redaction happens BEFORE token-budgeting (not after) so a raw secret's
 * length never buys it a bigger token cost than what actually survives —
 * the budget is spent against what will really be emitted.
 *
 * This is a pure, LOCAL copy: `state.anchorsSnapshot` itself (the raw value
 * passed to `io.onTerminalState`, e.g. for a future SLATE-10 catch-up that
 * needs the true on-disk shape) is never mutated — only the human/log-facing
 * rendered text produced by this module is bounded/redacted.
 */
function boundedRedactedAnchorsSnapshot(anchors: SlateAnchors, maxTokens: number): SlateAnchors {
  const fence = anchors.fence?.map((entry) => redactSensitiveText(entry));
  const base: SlateAnchors = {
    root: anchors.root,
    ...(anchors.tree !== undefined ? { tree: anchors.tree } : {}),
    ...(anchors.runtime !== undefined ? { runtime: anchors.runtime } : {}),
    ...(fence !== undefined ? { fence } : {}),
    touched: [],
  };
  const baseTokens = estimateTokens(JSON.stringify(base));
  const touchedBudget = Math.max(0, maxTokens - baseTokens);

  const touched = redactAndBoundTouched(anchors.touched, touchedBudget, {
    traceRef: "slate-terminal-state-anchors",
    configurationRevision: "slate-terminal-state-anchors-v1",
    policyRef: "slate-terminal-state-anchors",
    policyRevision: "v1",
  });

  return { ...base, touched };
}

/**
 * Render `state` as a `KERYX_TERMINAL_STATE`-sentinel text block for human/
 * log visibility — modeled on `KERYX_INSTALLATION_RESULT`
 * (docs/docs/agent-installation-playbook.md:290-309): a sentinel header line
 * plus `key: value` fields. Pure (same input + same `opts` always renders the
 * same output — no clock/RNG of its own, `occurredAt` is already baked into
 * `state`).
 *
 * Unlike `renderAnchorsBlock` (slate.ts), which must NEVER surface
 * Course/Seeds content (AC5's separate-concerns guard), this function's
 * whole point is to surface `courseSnapshot` — so `courseSnapshot` is always
 * rendered as its full, untouched JSON serialization (not summarized,
 * bounded, or redacted). `anchorsSnapshot`, however, gets the same two
 * safeguards `renderAnchorsBlock` ALSO applies to Anchors elsewhere (F-004 /
 * review finding 1, both fixed via the shared `redactAndBoundTouched`
 * helper in `slate.ts`): `touched`/`fence` entries are redacted via
 * {@link boundedRedactedAnchorsSnapshot}, and `touched` is token-bounded via
 * `opts.maxTokens` (default {@link DEFAULT_TERMINAL_STATE_MAX_TOKENS}) —
 * applied HERE, inside this function, so it holds regardless of which caller
 * renders a given `TerminalState`, not only at today's one call site.
 */
export function renderTerminalStateBlock(state: TerminalState, opts?: { maxTokens?: number }): string {
  const maxTokens = opts?.maxTokens ?? DEFAULT_TERMINAL_STATE_MAX_TOKENS;
  const anchorsSnapshot = boundedRedactedAnchorsSnapshot(state.anchorsSnapshot, maxTokens);
  return [
    "KERYX_TERMINAL_STATE",
    `status: ${state.status}`,
    `reason: ${state.reason}`,
    `occurredAt: ${state.occurredAt}`,
    `courseSnapshot: ${JSON.stringify(state.courseSnapshot)}`,
    `anchorsSnapshot: ${JSON.stringify(anchorsSnapshot)}`,
  ].join("\n");
}

/**
 * Flow 165 (Slate Phase 5), Track A item 4: persist `state` as a sibling of
 * `slate.json` in the session dir — the gap found while grounding that flow
 * (`TerminalState` was built and emitted, but never written to disk anywhere,
 * so a future SLATE-10 catch-up's "blocked" category had no durable data to
 * read). Uses `writeFileAtomic` (`../lib/fs`), the SAME primitive
 * `slate.ts`'s own storage functions use, so a crash mid-write can never
 * leave a partial `terminal-state.json` behind. The raw, unredacted `state`
 * is written verbatim (not the token-bounded/redacted rendering
 * `renderTerminalStateBlock` produces) — a future catch-up reader needs the
 * true on-disk shape, matching this module's own doc comment on
 * `anchorsSnapshot`.
 */
export async function writeTerminalState(dir: string, state: TerminalState): Promise<void> {
  await writeFileAtomic(path.join(dir, "terminal-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}
