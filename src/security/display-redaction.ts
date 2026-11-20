// Platform-neutral display redaction for the CLI and Desktop.
import type { DetectorMatch } from "./types";
import { detectSecrets } from "./detect/secrets";
import { detectPii } from "./detect/pii";
import { detectExfil } from "./detect/exfil";
import { detectEntropy } from "./detect/entropy";

export function maskFor(match: DetectorMatch): string {
  return `[REDACTED:${match.mask ?? "sensitive"}]`;
}

// Apply fixed-width masks to every redactable span (matches carrying a `mask`).
// Non-redactable categories (prompt-injection, egress) are left in place.
export function applyRedaction(content: string, matches: DetectorMatch[]): string {
  // Single left-to-right pass over the ORIGINAL content. Sequential in-place
  // splicing with original offsets is unsafe here: masks are fixed-width and
  // almost never equal the span width, so after one splice every later original
  // offset is stale — and overlapping different-category spans (e.g. a PII email
  // nested inside a secret env-assignment) are not deduped, which previously
  // leaked raw bytes of the outer span. Advancing the cursor to the max end seen
  // keeps a covered inner/partial span from ever re-emitting original content.
  const redactable = matches
    .filter((m) => m.mask !== undefined)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  for (const match of redactable) {
    if (match.end <= cursor) {
      continue; // fully covered by a prior mask
    }
    if (match.start < cursor) {
      // A partial overlap (two rules read one run of digits differently) is masked by the marker already
      // written; the union is hidden without a second marker.
      cursor = match.end;
      continue;
    }
    out += content.slice(cursor, match.start);
    out += maskFor(match);
    cursor = match.end;
  }
  out += content.slice(cursor);
  return out;
}

export function redactDisplayText(text: string, includeEntropy = true): string {
  if (text.length === 0) {
    return text;
  }
  const matches = [
    ...detectSecrets(text),
    ...detectPii(text),
    ...detectExfil(text),
    // F-REG-F3 (flow 355 review round): honours `backends.entropy.enabled`,
    // the same gate `keryx security scan` already applies — see
    // `entropy-gate.ts`'s header for why this is a cache, not a config load.
    ...(includeEntropy ? detectEntropy(text) : []),
  ];
  if (matches.length === 0) {
    return text;
  }
  return applyRedaction(text, matches);
}
