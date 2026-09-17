// Stateful, incremental parser for MiniMax-style inline `<think>…</think>`
// reasoning tags embedded in an OpenAI-compat `delta.content` stream (flow 268
// T10 / AC4). MiniMax's DEFAULT wire shape puts reasoning inline in
// `delta.content` rather than a separate field — see
// docs/analysis/minimax-shell-hang/2026-09-17/report.md. This module is the
// pure, unit-testable piece that turns that inline stream into ordered
// `{ kind: "reasoning" | "text", text }` segments; `openai-compat-provider.ts`
// wires it in only when a custom provider's `reasoning.format` is
// `"inline-tags"`.
//
// Pure and side-effect free beyond its own instance state: feed content
// chunks via `push()` as they arrive over SSE, get back ordered segments, and
// call `flush()` once at stream end (on a NORMAL termination — `[DONE]`, a
// `finish_reason`, or a clean EOF; never on abort/timeout, which discard
// in-flight state instead) to emit whatever text is still held back.
//
// Rules (kept deliberately simple, per the frozen AC4 wording):
//  - Text between an exact lowercase `<think>` and `</think>` is reasoning;
//    text outside is the answer.
//  - A tag may be split across chunks (`<thi` + `nk>`): a possible partial
//    tag match at the tail of a chunk is held back — never emitted — until
//    the next push() either completes it into a real tag or proves it was
//    never one.
//  - A stray `</think>` with no open `<think>` in effect is dropped: it is
//    neither reasoning nor text, it simply vanishes.
//  - `flush()` emits whatever is still held: an unclosed `<think>` at stream
//    end means everything after it was reasoning (the held text is flushed
//    in whatever mode the parser was last in).
//  - Only exact lowercase `<think>` / `</think>` are recognized. Any other
//    casing, or a `<think>` reopened while already inside a reasoning block,
//    is NOT special-cased — it is left as literal content of whatever mode
//    the parser is currently in. Nested/re-opened tags are not a case this
//    parser tries to model; MiniMax does not emit them.
//  - The first text segment immediately after a `</think>` close has its
//    leading newlines trimmed (answers commonly start with a blank line
//    right after the model's closing tag). Symmetrically, the first
//    reasoning segment immediately after a `<think>` open has its leading
//    newlines trimmed too (flow 268 T25 live evidence: MiniMax-M3 opens
//    `"<think>\nThe user …"`, which otherwise leaves the thought block's
//    first line blank). Nothing else is ever trimmed.
export type ThinkTagSegmentKind = "reasoning" | "text";

export interface ThinkTagSegment {
  readonly kind: ThinkTagSegmentKind;
  readonly text: string;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Longest suffix of `s` that equals a PROPER (non-full-length) prefix of one
 * of `tags`. Exported for reuse by `./think-tag-stripper.ts`, which holds
 * back the same kind of chunk-boundary partial tag match.
 */
export function partialTagSuffixLength(s: string, tags: readonly string[]): number {
  let best = 0;
  for (const tag of tags) {
    const maxLen = Math.min(s.length, tag.length - 1);
    for (let len = maxLen; len > 0; len--) {
      if (s.slice(s.length - len) === tag.slice(0, len)) {
        if (len > best) best = len;
        break;
      }
    }
  }
  return best;
}

export class ThinkTagParser {
  private mode: ThinkTagSegmentKind = "text";
  private pending = "";
  private trimNextText = false;
  private trimNextReasoning = false;

  /** Feed the next content chunk; returns the segments it resolves, in order. */
  push(chunk: string): ThinkTagSegment[] {
    const segments: ThinkTagSegment[] = [];
    let buf = this.pending + chunk;
    this.pending = "";

    for (;;) {
      const candidates = this.mode === "text" ? [OPEN_TAG, CLOSE_TAG] : [CLOSE_TAG];
      let tagIndex = -1;
      let tag = "";
      for (const candidate of candidates) {
        const idx = buf.indexOf(candidate);
        if (idx !== -1 && (tagIndex === -1 || idx < tagIndex)) {
          tagIndex = idx;
          tag = candidate;
        }
      }

      if (tagIndex === -1) {
        // No complete tag left in `buf`. Hold back a possible partial match at
        // the tail so a tag split across the chunk boundary can complete on
        // the next push(); emit everything before it now.
        const holdLen = partialTagSuffixLength(buf, candidates);
        this.emit(segments, buf.slice(0, buf.length - holdLen));
        this.pending = buf.slice(buf.length - holdLen);
        return segments;
      }

      this.emit(segments, buf.slice(0, tagIndex));
      buf = buf.slice(tagIndex + tag.length);

      if (tag === OPEN_TAG) {
        this.mode = "reasoning";
        // Live evidence (MiniMax-M3, 2026-09-17, flow 268 T25): content opens
        // `"<think>\nThe user …"` — the leading newline right after the open
        // tag is not part of the thought, it just separates the tag from the
        // text. Mirror the post-close trim below so the reasoning block's
        // first line isn't blank.
        this.trimNextReasoning = true;
        continue;
      }
      // tag === CLOSE_TAG: a real close (reasoning -> text) re-enters text
      // mode and arms the post-close trim; a STRAY close (already in text
      // mode) is simply dropped — its content was already emitted above, and
      // mode/trim state are left untouched.
      if (this.mode === "reasoning") {
        this.mode = "text";
        this.trimNextText = true;
      }
    }
  }

  /** Emit whatever is still held back. Call once, at a NORMAL stream end. */
  flush(): ThinkTagSegment[] {
    const segments: ThinkTagSegment[] = [];
    this.emit(segments, this.pending);
    this.pending = "";
    return segments;
  }

  private emit(segments: ThinkTagSegment[], content: string): void {
    if (content.length === 0) return;
    if (this.mode === "text" && this.trimNextText) {
      const trimmed = content.replace(/^(?:\r\n|\n)+/, "");
      if (trimmed.length === 0) {
        // Still nothing but newlines since the close — keep waiting for the
        // first real answer text so it gets trimmed too.
        return;
      }
      this.trimNextText = false;
      segments.push({ kind: "text", text: trimmed });
      return;
    }
    if (this.mode === "reasoning" && this.trimNextReasoning) {
      const trimmed = content.replace(/^(?:\r\n|\n)+/, "");
      if (trimmed.length === 0) {
        // Still nothing but newlines since the open tag — keep waiting for
        // the first real thought text so it gets trimmed too (the newline
        // may arrive in a later chunk than the tag itself).
        return;
      }
      this.trimNextReasoning = false;
      segments.push({ kind: "reasoning", text: trimmed });
      return;
    }
    segments.push({ kind: this.mode, text: content });
  }
}
