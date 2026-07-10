import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { securityDataRoot } from "./config";
import type { DetectorMatch, SecurityLocation } from "./types";

// Redaction and hashing safety (specification.md §10a).
//
// - Masks are FIXED-WIDTH and length-hiding: a secret always becomes the constant
//   token `[REDACTED:secret]`; PII uses a typed constant (`[REDACTED:email]`).
//   Never a partial reveal, never length-preserving.
// - `redactedPreview` shows only surrounding NON-sensitive context with the span
//   replaced by the mask — never a prefix/suffix of the sensitive value.
// - `hash` is HMAC-SHA256(value, key) with a per-project key stored local-only.
//   A plain sha256 of a small-space value is brute-forceable and is itself a leak.

const PREVIEW_WINDOW = 24;

export function maskFor(match: DetectorMatch): string {
  return `[REDACTED:${match.mask ?? "sensitive"}]`;
}

// Collapse whitespace/newlines so a preview stays a single tidy line.
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Build a safe preview: fixed non-sensitive context on each side with the target
// span replaced by its mask. Any OTHER sensitive span (secret/PII) that falls in
// the surrounding window is masked too, so a finding's preview can never reveal a
// neighbouring secret or PII value. The sensitive value itself is never included.
export function buildRedactedPreview(
  content: string,
  target: DetectorMatch,
  allMatches: DetectorMatch[] = [target],
): string {
  const winStart = Math.max(0, target.start - PREVIEW_WINDOW);
  const winEnd = Math.min(content.length, target.end + PREVIEW_WINDOW);

  // Spans to mask inside the window: every redactable span plus the target.
  const spans = allMatches
    .filter(
      (m) =>
        (m.mask !== undefined || m === target) &&
        m.end > winStart &&
        m.start < winEnd,
    )
    .sort((a, b) => a.start - b.start);

  let out = "";
  let cursor = winStart;
  for (const span of spans) {
    const s = Math.max(span.start, winStart);
    const e = Math.min(span.end, winEnd);
    if (s < cursor) {
      // Overlapping span: its lead is already covered, but it may extend past
      // the cursor — advance so those bytes are never emitted raw.
      cursor = Math.max(cursor, e);
      continue;
    }
    out += content.slice(cursor, s);
    out += maskFor(span);
    cursor = e;
  }
  out += content.slice(cursor, winEnd);

  const lead = winStart > 0 ? "…" : "";
  const trail = winEnd < content.length ? "…" : "";
  return `${lead}${tidy(out)}${trail}`.replace(/\s+/g, " ").trim();
}

export function locationFor(content: string, match: DetectorMatch): SecurityLocation {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < match.start; i += 1) {
    if (content[i] === "\n") {
      line += 1;
      lastNewline = i;
    }
  }
  return {
    line,
    column: match.start - lastNewline,
    start: match.start,
    end: match.end,
  };
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
    .sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const match of redactable) {
    const start = Math.max(match.start, cursor);
    if (start >= match.end) {
      continue; // fully covered by a prior mask
    }
    out += content.slice(cursor, start);
    out += maskFor(match);
    cursor = Math.max(cursor, match.end);
  }
  out += content.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Local-only HMAC key management (§10a / §14). The key lives under
// data/security/raw/ (gitignored) and is generated on first use. It is never
// committed and never leaves the machine.
// ---------------------------------------------------------------------------

const KEY_FILE = "hmac.key";

export function keyDir(cwd: string): string {
  return path.join(securityDataRoot(cwd), "raw");
}

export async function getHmacKey(cwd: string): Promise<string> {
  const dir = keyDir(cwd);
  const file = path.join(dir, KEY_FILE);
  if (await pathExists(file)) {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing.length > 0) {
      return existing;
    }
  }
  await mkdir(dir, { recursive: true });
  const key = randomBytes(32).toString("hex");
  await writeFile(file, `${key}\n`, "utf8");
  try {
    await chmod(file, 0o600);
  } catch {
    // Best-effort on platforms without POSIX permissions.
  }
  return key;
}

export function hmacHash(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
