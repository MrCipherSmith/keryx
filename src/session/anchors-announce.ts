// Flow 387 T9: one full `Anchors:` block in model-bound history, then deltas.
//
// Before this, every `touched` change pushed a fresh full block (each up to
// ~7K chars once `touched` grew), so a long session carried ~20 copies of the
// same text. Now the FIRST announcement is the full block and every later
// change is a short `Anchors update:` message with only the entries that
// changed. History is append-only here — an earlier message is never rewritten
// (that would invalidate the provider's prefix cache).
//
// The "what has the model already been told" state is DERIVED FROM `history`
// itself (the last full block plus the deltas after it), not kept beside it:
// that survives a resumed session, a `/compact` and the in-place splice of the
// automatic context guard without any extra bookkeeping. After a compaction
// drops the old blocks, `compactMessages` folds them back into ONE full block
// (see `consolidateAnchors`), and this module finds that block again.

import type { NormalizedMessage } from "../harness/provider/types";
import { renderAnchorsBlock, type SlateAnchors } from "./slate";

const FULL_HEADER = "Anchors:";
const DELTA_HEADER = "Anchors update:";
/** Most `touched` entries a consolidated block carries after a compaction. */
const MAX_CONSOLIDATED_TOUCHED = 60;

type HeadKey = "root" | "tree" | "runtime";
const HEAD_KEYS: readonly HeadKey[] = ["root", "tree", "runtime"];

export interface AnchorsState {
  head: Partial<Record<HeadKey, string>>;
  touched: string[];
}

/** A full `Anchors:` block (not a delta). */
export function isFullAnchorsContent(content: string): boolean {
  return content === FULL_HEADER || content.startsWith(`${FULL_HEADER}\n`);
}

/** An `Anchors update:` delta message. */
export function isAnchorsDeltaContent(content: string): boolean {
  return content === DELTA_HEADER || content.startsWith(`${DELTA_HEADER}\n`);
}

/** Either form — used by compaction to recognise legacy (unmarked) anchors. */
export function isAnchorsContent(content: string): boolean {
  return isFullAnchorsContent(content) || isAnchorsDeltaContent(content);
}

function applyHeadLine(state: AnchorsState, line: string): boolean {
  for (const key of HEAD_KEYS) {
    if (line.startsWith(`${key}: `)) {
      state.head[key] = line.slice(key.length + 2);
      return true;
    }
  }
  return false;
}

function parseFull(content: string): AnchorsState {
  const state: AnchorsState = { head: {}, touched: [] };
  let inTouched = false;
  for (const line of content.split("\n").slice(1)) {
    if (line === "touched:") {
      inTouched = true;
    } else if (inTouched && line.startsWith("- ")) {
      state.touched.push(line.slice(2));
    } else if (!inTouched) {
      applyHeadLine(state, line);
    }
  }
  return state;
}

function applyDelta(state: AnchorsState, content: string): void {
  for (const line of content.split("\n").slice(1)) {
    if (line.startsWith("+ ")) {
      const entry = line.slice(2);
      if (!state.touched.includes(entry)) {
        state.touched.push(entry);
      }
    } else {
      applyHeadLine(state, line);
    }
  }
}

/**
 * What the model has been told so far: the LAST full block in `history` with
 * every delta after it applied. `undefined` when no full block is present (a
 * fresh history, or one a compaction trimmed).
 */
export function foldAnchorsState(history: readonly NormalizedMessage[]): AnchorsState | undefined {
  let fullAt = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m !== undefined && m.role === "user" && isFullAnchorsContent(m.content)) {
      fullAt = i;
      break;
    }
  }
  if (fullAt < 0) {
    return undefined;
  }
  const state = parseFull(history[fullAt]?.content ?? "");
  for (let i = fullAt + 1; i < history.length; i++) {
    const m = history[i];
    if (m !== undefined && m.role === "user" && isAnchorsDeltaContent(m.content)) {
      applyDelta(state, m.content);
    }
  }
  return state;
}

function renderState(state: AnchorsState): string {
  const lines: string[] = [FULL_HEADER];
  for (const key of HEAD_KEYS) {
    const value = state.head[key];
    if (value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }
  if (state.touched.length > 0) {
    lines.push("touched:", ...state.touched.map((t) => `- ${t}`));
  }
  return lines.join("\n");
}

function anchorsMessage(content: string, ts?: string): NormalizedMessage {
  return {
    role: "user",
    content,
    provenance: "project",
    // Harness-injected, not operator input: compaction must not count it as a turn.
    injected: true,
    ...(ts !== undefined ? { ts } : {}),
  };
}

/**
 * The message to append so the model's view of the anchors matches `anchors`,
 * or `undefined` when it already does. The first announcement (no full block in
 * `history`) is the full block; afterwards only the changed head lines and the
 * newly touched entries are sent. `scrub` is applied to the rendered text BEFORE
 * it is compared with what history holds, so both sides are scrubbed alike.
 */
export function anchorsAnnouncement(
  history: readonly NormalizedMessage[],
  anchors: SlateAnchors,
  scrub: (text: string) => string = (t) => t,
  ts?: string,
): NormalizedMessage | undefined {
  const fullText = scrub(renderAnchorsBlock(anchors));
  const announced = foldAnchorsState(history);
  if (announced === undefined) {
    return anchorsMessage(fullText, ts);
  }
  const next = parseFull(fullText);
  const seen = new Set(announced.touched);
  const lines: string[] = [];
  for (const key of HEAD_KEYS) {
    const value = next.head[key];
    if (value !== undefined && value !== announced.head[key]) {
      lines.push(`${key}: ${value}`);
    }
  }
  for (const entry of next.touched) {
    if (!seen.has(entry)) {
      lines.push(`+ ${entry}`);
    }
  }
  if (lines.length === 0) {
    return undefined;
  }
  return anchorsMessage([DELTA_HEADER, ...lines].join("\n"), ts);
}

/**
 * Compaction support: fold every anchors message in `removed` into ONE full
 * block (or `undefined` when there were none). The caller emits it only when the
 * kept window holds no full block of its own.
 */
export function consolidateAnchors(removed: readonly NormalizedMessage[]): NormalizedMessage | undefined {
  const state = foldAnchorsState(removed);
  if (state === undefined) {
    return undefined;
  }
  return anchorsMessage(
    renderState({ head: state.head, touched: state.touched.slice(-MAX_CONSOLIDATED_TOUCHED) }),
  );
}
