// Stateful stripper for a literal `<think>`/`</think>` tag leaking into an
// otherwise plain FIELD-sourced reasoning text stream (flow 268 T24). Unlike
// `ThinkTagParser` (`./think-tag-parser.ts`), which classifies `delta.content`
// into alternating reasoning/text segments for `format: "inline-tags"`, this
// module never reclassifies anything — every character it is fed is already
// known to be reasoning text (it came from `delta.reasoning`/
// `delta.reasoning_content`/`delta.reasoning_details`, i.e. `format: "field"`
// or `format: "split"`). Its only job is to remove a stray literal tag a
// gateway sometimes echoes INSIDE that field — MiniMax's split-mode reasoning
// stream was observed (live smoke test, 2026-09-17) to end with a literal
// `</think>` line even though `delta.content` never carries the tags in split
// mode.
//
// Rules (deliberately narrow, mirroring `ThinkTagParser`'s tag-matching):
//  - Only exact lowercase `<think>` / `</think>` are recognized and removed.
//  - A tag may be split across chunks (`"\n</thi"` + `"nk>"`): a possible
//    partial match at the tail of a chunk is held back until the next push()
//    either completes it into a real tag or proves it was never one.
//  - The newline directly adjacent to a removed tag — immediately before it
//    and immediately after it — is removed along with the tag, so a tag that
//    sits alone on its own line (`"…manner.\n</think>\n"`) leaves no blank
//    line behind (`"…manner."`). No other whitespace is ever touched. This
//    holds EVEN WHEN the newline and the tag arrive in different chunks
//    (`"…manner.\n</thi"` + `"nk>"`, the actual split MiniMax was observed
//    to send): the trailing-newline candidates below make `push()` hold the
//    newline back rather than emit it before the tag it precedes is known.
//  - Everything else passes through unchanged, including text that never
//    contained a tag at all.
import { partialTagSuffixLength } from "./think-tag-parser";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const TAGS = [OPEN_TAG, CLOSE_TAG] as const;
// Used only to size the chunk-boundary HOLD, never as a literal match: a
// tag candidate prefixed with a newline means a trailing "\n" (or "\r\n")
// that MIGHT turn out to immediately precede a tag is held back too, instead
// of being emitted a push() early — which is exactly what the tag-strip
// below needs to find and remove it once the tag itself completes.
const HOLD_CANDIDATES = [
  OPEN_TAG,
  CLOSE_TAG,
  `\n${OPEN_TAG}`,
  `\n${CLOSE_TAG}`,
  `\r\n${OPEN_TAG}`,
  `\r\n${CLOSE_TAG}`,
] as const;
const LEADING_NEWLINE = /^(?:\r\n|\n)/;
const TRAILING_NEWLINE = /(?:\r\n|\n)$/;

export class FieldThinkTagStripper {
  private pending = "";

  /** Feed the next reasoning-field text chunk; returns the stripped text to emit (may be empty). */
  push(chunk: string): string {
    let buf = this.pending + chunk;
    this.pending = "";
    let out = "";

    for (;;) {
      let tagIndex = -1;
      let tagLen = 0;
      for (const tag of TAGS) {
        const idx = buf.indexOf(tag);
        if (idx !== -1 && (tagIndex === -1 || idx < tagIndex)) {
          tagIndex = idx;
          tagLen = tag.length;
        }
      }

      if (tagIndex === -1) {
        // No complete tag left in `buf`. Hold back a possible partial match —
        // OF A TAG, OR OF A NEWLINE THAT MIGHT PRECEDE ONE — at the tail so a
        // tag (and its adjacent newline) split across the chunk boundary can
        // complete on the next push(); emit everything before it now.
        const holdLen = partialTagSuffixLength(buf, HOLD_CANDIDATES);
        out += buf.slice(0, buf.length - holdLen);
        this.pending = buf.slice(buf.length - holdLen);
        return out;
      }

      const before = buf.slice(0, tagIndex).replace(TRAILING_NEWLINE, "");
      const after = buf.slice(tagIndex + tagLen).replace(LEADING_NEWLINE, "");
      out += before;
      buf = after;
    }
  }

  /** Emit whatever is still held back. Call once, at a NORMAL stream end. */
  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}
