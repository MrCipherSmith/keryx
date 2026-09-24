// Shared text-bounding helper for signal drafts (schema: `trigger`/`action`
// are free text, 8-400 chars — see `learned-pattern.schema.json`). Every
// signal builds its trigger/action strings through this so none of them can
// accidentally write a record `writePattern`/`validateLearnedPattern` would
// then refuse.
const MIN_LEN = 8;
const MAX_LEN = 400;

/** Collapses whitespace, truncates at `MAX_LEN` (word-boundary ellipsis), and pads a too-short string up to `MIN_LEN`. */
export function clampLearningText(text: string, max = MAX_LEN, min = MIN_LEN): string {
  let value = text.trim().replace(/\s+/g, " ");
  if (value.length > max) {
    const head = value.slice(0, max - 1);
    const boundary = head.lastIndexOf(" ");
    value = `${(boundary > max / 2 ? head.slice(0, boundary) : head).trimEnd()}…`;
  }
  if (value.length < min) {
    value = value.length === 0 ? "unspecified" : value;
    value = value.padEnd(min, ".");
  }
  return value;
}

/** Best-effort basename for text (never a full path) — read from an observation `inputPreview`'s canonical-JSON `"file_path":"…"` field, present on Edit-shaped tool inputs. Falls back to `"a file"` when absent or truncated/redacted. */
export function basenameFromInputPreview(preview: string): string {
  const match = /"file_path"\s*:\s*"([^"]*)"/.exec(preview);
  if (!match || match[1] === undefined || match[1].length === 0) return "a file";
  const value = match[1];
  const base = value.split(/[/\\]/).pop();
  return base !== undefined && base.length > 0 ? base : "a file";
}
