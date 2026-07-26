import type { DetectorMatch } from "../types";

// High-entropy string heuristic (specification.md §10). Flags long tokens with
// high Shannon entropy that sit near a sensitive label. Confidence is kept in the
// heuristic band (0.4-0.7) per §7a so it does not over-block.

const SENSITIVE_LABEL = /(key|secret|token|password|passwd|api|credential|auth)/i;
const TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;
const LABEL_WINDOW = 40;

// Only the text after the last newline — the label window must never reach into
// a neighbouring line.
function lastLineOf(before: string): string {
  const newline = before.lastIndexOf("\n");
  return newline < 0 ? before : before.slice(newline + 1);
}

// True for `word-word-word` / `word_word_word` slugs, e.g.
// `ADR-0008-interactive-shell-delegate-risk-gate` or `108-security-eval-corpus`.
// Every `-`/`_` segment must be pure (all letters or all digits) and at least two
// must be alphabetic words of 3+ characters. A UUID (`550e8400-e29b-…`) or a
// prefixed token (`ghp_1234abcdEF…`) has mixed alphanumeric segments and is
// therefore NOT a slug, so real credentials keep flowing through this gate.
function isWordSlug(value: string): boolean {
  const segments = value.split(/[-_]/);
  if (segments.length < 3) {
    return false;
  }
  let words = 0;
  for (const segment of segments) {
    const isAlpha = /^[A-Za-z]+$/.test(segment);
    const isDigits = /^[0-9]+$/.test(segment);
    if (!isAlpha && !isDigits) {
      return false;
    }
    if (isAlpha && segment.length >= 3) {
      words += 1;
    }
  }
  return words >= 2;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function detectEntropy(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(content)) !== null) {
    const value = m[0];
    // Code identifiers (camelCase / PascalCase / snake_case) routinely exceed
    // 20 chars and sit near an "api"/"key" substring embedded in a NEIGHBOURING
    // identifier — e.g. `PipelineVariablesStore` right after `...VariablesApi` —
    // producing false positives. Real credentials are random blobs that almost
    // always contain a digit or a base64 symbol; an alpha/underscore/hyphen-only
    // token is an identifier, not a secret. Require a secret-shaped character.
    // `/` was deliberately DROPPED from this gate: it made every filesystem
    // path ≥20 chars a secret candidate (`src/security/detect/entropy` has no
    // digit and no base64 symbol, but plenty of slashes), which is how real
    // filenames reached agents as `[REDACTED:secret]` and could not be opened.
    // A base64 blob that contains `/` in practice also contains digits or `+`/`=`.
    if (!/[0-9]/.test(value) && !/[+=]/.test(value)) {
      continue;
    }
    // Hyphen/underscore-delimited word slugs — ADR filenames, flow directories,
    // kebab-case identifiers — are never credentials, even though a version-like
    // digit segment satisfies the shape gate above.
    if (isWordSlug(value)) {
      continue;
    }
    const entropy = shannonEntropy(value);
    if (entropy < 3.6) {
      continue;
    }
    // The label look-back is bounded to the CURRENT LINE. It used to run over
    // raw offsets, so a "credential"/"key" word on the PREVIOUS line labelled
    // this line's token — making redaction depend on unrelated neighbouring
    // output, and the same string mask in one context but not another.
    const before = lastLineOf(content.slice(Math.max(0, m.index - LABEL_WINDOW), m.index));
    if (!SENSITIVE_LABEL.test(before)) {
      continue;
    }
    // Map entropy 3.6..5.0 into confidence 0.4..0.7.
    const confidence = Math.min(0.7, 0.4 + (entropy - 3.6) * 0.21);
    matches.push({
      category: "secret",
      policyId: "secrets.high-entropy",
      severity: "medium",
      confidence: Number(confidence.toFixed(2)),
      start: m.index,
      end: m.index + value.length,
      value,
      mask: "secret",
      remediation: "Verify this high-entropy value is not a live credential.",
    });
  }
  return matches;
}
