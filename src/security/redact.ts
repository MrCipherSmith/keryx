import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { securityDataRoot } from "./config";
import type { DetectorMatch, SecurityLocation } from "./types";
import { detectSecrets } from "./detect/secrets";
import { detectPii } from "./detect/pii";
import { detectExfil } from "./detect/exfil";
import { detectEntropy } from "./detect/entropy";
import { isEntropyBackendEnabled } from "./entropy-gate";

// Redaction and hashing safety (specification.md §10a).
//
// - Masks are FIXED-WIDTH and length-hiding: a secret always becomes the constant
//   token `[REDACTED:secret]`; PII uses a typed constant (`[REDACTED:email]`); a
//   high-entropy match with no NAMED shape (S-6, flow 355) becomes
//   `[REDACTED:entropy]`, distinguishing "matched a known credential pattern"
//   from "merely high-entropy near a sensitive word". Never a partial reveal,
//   never length-preserving.
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

// Scrub secret, PII, auto-fetch exfil, and high-entropy spans from free text
// using the deterministic detector floor (regex + entropy — no model, no
// config, no IO), then fixed-width redact. Used
// to sanitise TOOL OUTPUT before it is appended to provider-bound agent history:
// a contained shell command that reads a credential (`cat ~/.aws/credentials`,
// `env`) must not leak the raw value into the model context and onward to the
// provider (finding F3). Pure; returns the input unchanged when nothing matches.
//
// S-6 (flow 355, AC2): the pattern-only pass never caught an opaque bearer
// token or a bare high-entropy key with no NAMED shape — this is the one
// scrubber every tool output goes through (`commands/agent.ts`'s turn loop)
// and web content (`harness/web/web-content.ts`), so that gap reached the
// model on every session. `detectEntropy` runs the SAME thresholds `keryx
// security scan` uses, and its own allow-shapes (git SHAs, UUIDs, npm/yarn
// integrity strings — `entropy.ts`'s `isAllowShapedValue`) keep the false-
// positive rate on ordinary command output at zero (flow 355 AC2 fixture).
export function redactSensitiveText(text: string): string {
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
    ...(isEntropyBackendEnabled() ? detectEntropy(text) : []),
  ];
  if (matches.length === 0) {
    return text;
  }
  return applyRedaction(text, matches);
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
