// Redaction-before-persistence (flow 009, W7 / S4, task-R0-02).
//
// `redactForPersistence` enforces @SC_R11_REDACTION_BEFORE_PERSISTENCE and
// `specification.md` §Storage Structure ("Sensitive content is redacted before
// it is written to either class."): protected content (secrets / PII) is never
// written verbatim. Only a redacted preview, a content hash, the detected
// category, and a provenance descriptor survive; the raw secret/PII appears in
// none of them. A scan that could not complete is a *blocking* state — nothing
// is persisted, because unscanned content might leak.
//
// Determinism / purity: this is a pure function of `(content, deps.scan)`. The
// only non-trivial computation is a sha-256 hash via `node:crypto` (stable for
// identical input). No `Date.now`, `Math.random`, network, or filesystem
// mutation. The secret scanner itself is injected (`deps.scan`) so this module
// never bundles a real scanner and callers stay deterministic in tests.
import { createHash } from "node:crypto";

/**
 * Result of the injected content scan. `hasSecret` marks detected protected
 * content of `category`; `scanFailed` marks an incomplete scan (a blocking
 * condition that overrides everything else).
 */
export interface ScanResult {
  hasSecret: boolean;
  category?: string;
  scanFailed?: boolean;
}

/** Injected dependencies: a deterministic content scanner. */
export interface RedactionDeps {
  scan: (content: string) => ScanResult;
}

/**
 * Discriminated union of what may be persisted.
 * - `blocked: false` — exactly `{ preview, hash, category, provenance }`, none
 *   of which contains the raw protected content.
 * - `blocked: true` — exactly `{ reason }`; no preview/hash/category is emitted
 *   so unscanned content can never leak.
 */
export type RedactionResult =
  | {
      blocked: false;
      preview: string;
      /** Lowercase sha-256 hex of the raw content (64 chars). */
      hash: string;
      category: string;
      provenance: RedactionProvenance;
    }
  | { blocked: true; reason: string };

/** Non-sensitive provenance describing how the content was redacted. */
export interface RedactionProvenance {
  source: "harness-redaction";
  category: string;
  /** "full" when protected content was masked; "none" for clean content. */
  redaction: "full" | "none";
}

/** Category used when a scan reports no protected content. */
const CLEAN_CATEGORY = "none";

/** Deterministic sha-256 hex of the raw content. */
function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Redact `content` for persistence.
 *
 * On a completed scan, returns a non-blocking result whose `preview` never
 * embeds the raw protected content (when flagged, the preview is a safe
 * placeholder rather than the original text). On scan failure, returns a
 * blocking result carrying only a `reason`.
 */
export function redactForPersistence(content: string, deps: RedactionDeps): RedactionResult {
  const scan = deps.scan(content);

  // Scan failure is terminal: persist nothing that could leak unscanned content.
  if (scan.scanFailed === true) {
    return {
      blocked: true,
      reason:
        "content scan failed; persistence blocked to avoid writing unscanned, potentially protected content",
    };
  }

  const flagged = scan.hasSecret === true;
  const category = flagged ? scan.category ?? "unknown" : CLEAN_CATEGORY;

  // When flagged, the scanner reports only a category (no spans), so the safe
  // deterministic preview fully masks the content and records its length —
  // never the raw text. Clean content is previewed verbatim.
  const preview = flagged
    ? `[redacted:${category}] ${content.length} chars withheld`
    : content;

  return {
    blocked: false,
    preview,
    hash: hashContent(content),
    category,
    provenance: {
      source: "harness-redaction",
      category,
      redaction: flagged ? "full" : "none",
    },
  };
}
