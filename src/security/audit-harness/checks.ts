// Flow 308 (W8 Design part A, Lane A) — the audit-harness check catalog.
// One exported pure function per check id, independently testable. Every
// function takes already-read content (never touches the filesystem itself)
// and returns `RawFinding[]` — no id, no suppression: `index.ts` assigns
// those once, after every check has run, against the baseline.

import { detectInjection } from "../detect/injection";
import { detectSecrets } from "../detect/secrets";
import { scanMcpManifest } from "../detect/mcp";
import { touchesAgentCredentials } from "../../lib/command-risk";
import { redactSensitiveText } from "../redact";
import { agentSentinelFormatOf, structuralSentinelModelTier, type AgentSentinelFormat } from "../../agents/sentinel";
import type { DetectorMatch } from "../types";
import type { AuditSeverity, FindingLocation, InternalProposal, RawFinding, SurfaceId } from "./types";

function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

// --- R2-F10: evasion-resistant text normalization ---------------------------
//
// `checkAutoRunDirective` and `checkInjectionInText` (via `detectInjection`)
// both match plain-ASCII-word regexes against raw content. Round 2 showed
// four ways to slip a directive past that word-shaped matching while a human
// (and an LLM reading the rendered text) still reads it as the same words:
// zero-width characters/soft hyphens spliced INSIDE a keyword, a Cyrillic or
// Greek look-alike letter substituted for a Latin one, full-width forms
// (｢ignore｣-style), a combining-mark (NFD) sequence splitting one visual
// letter into two codepoints, and an HTML entity spelling out a character the
// raw-text regex never sees. `normalizeForDetection` closes all four with a
// single length-changing pass; every check below matches against the
// NORMALIZED text but reports its `location` (and any raw excerpt) against
// the ORIGINAL content, via `origIndexOf`, so the evidence a human reads is
// never a mangled/decoded rewrite of what the file actually contains.
// Zero-width space through right-to-left mark (5 codepoints), word joiner,
// BOM/zero-width-no-break-space, soft hyphen, and the combining diacritical
// marks block — built from numeric code points (never a literal escape or
// character-class source) so the constant itself can never be silently
// mis-rendered.
//
// R3-F(R2-F10 continuation, flow 313 W4 review round 2/3): the round-2 set
// only dropped the FIVE most common zero-width/bidi marks and ONE combining-
// mark block. Round 3 showed four more evasions splicing invisible
// characters between the letters of a keyword the same way: the remaining
// bidi EMBEDDING/OVERRIDE/ISOLATE controls and the Arabic Letter Mark, the
// invisible-plus (U+2064, used the same way a zero-width space is), and
// combining marks OUTSIDE the original 0x0300-0x036F block (Unicode defines
// four more combining-mark blocks a splicing attack can use identically).
const DROPPED_SINGLE_CODEPOINTS: ReadonlySet<number> = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x00ad,
  // Bidi controls: Arabic Letter Mark, embeddings/overrides (LRE/RLE/PDF/LRO/RLO), isolates (LRI/RLI/FSI/PDI).
  0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  // Invisible plus (visually nothing, but a word-boundary-defeating splice point like zero-width space).
  0x2064,
  // Unicode tag block's two non-mirroring control tags (language-tag start,
  // deprecated; cancel tag) — the MIRRORING tag range (U+E0020-U+E007E) is
  // folded back to its ASCII equivalent below, not dropped, because IT
  // carries the hidden letters an attacker spells with it.
  0xe0001, 0xe007f,
]);
// All five Unicode "combining mark" blocks — not just the original Combining
// Diacritical Marks block — since a splicing evasion works identically with
// a combining character from any of them.
const COMBINING_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x20d0, 0x20ff], // Combining Diacritical Marks for Symbols
  [0xfe20, 0xfe2f], // Combining Half Marks
];
function isDroppedForDetection(codePoint: number): boolean {
  if (DROPPED_SINGLE_CODEPOINTS.has(codePoint)) return true;
  return COMBINING_MARK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

// R2-F10/R3-F10-continuation: Mathematical Alphanumeric Symbols (U+1D400-
// U+1D7FF) — bold/italic/script/fraktur/double-struck/sans-serif/monospace
// letters and digits that visually spell an ordinary word but sit far
// outside the ASCII/homoglyph tables above. Each style block is 52 code
// points (A-Z then a-z) at a fixed start; a handful of letters in the
// script/fraktur/double-struck styles were never assigned IN that block —
// Unicode instead reuses pre-existing "letterlike symbol" code points for
// those — so those are folded via a small explicit exceptions table instead
// of the range formula.
const MATH_ALPHANUMERIC_LETTER_STYLE_STARTS: readonly number[] = [
  0x1d400, // bold
  0x1d434, // italic
  0x1d468, // bold italic
  0x1d49c, // script
  0x1d4d0, // bold script
  0x1d504, // fraktur
  0x1d538, // double-struck
  0x1d56c, // bold fraktur
  0x1d5a0, // sans-serif
  0x1d5d4, // sans-serif bold
  0x1d608, // sans-serif italic
  0x1d63c, // sans-serif bold italic
  0x1d670, // monospace
];
const MATH_ALPHANUMERIC_DIGIT_STYLE_STARTS: readonly number[] = [
  0x1d7ce, // bold
  0x1d7d8, // double-struck
  0x1d7e2, // sans-serif
  0x1d7ec, // sans-serif bold
  0x1d7f6, // monospace
];
const MATH_ALPHANUMERIC_EXCEPTIONS: Readonly<Record<number, string>> = {
  // Script capitals reused from the pre-existing Letterlike Symbols block.
  0x212c: "B", 0x2130: "E", 0x2131: "F", 0x210b: "H", 0x2110: "I", 0x2112: "L", 0x2133: "M", 0x211b: "R",
  // Script lowercase reused likewise.
  0x212f: "e", 0x210a: "g", 0x2134: "o",
  // Fraktur capitals reused likewise.
  0x212d: "C", 0x210c: "H", 0x2111: "I", 0x211c: "R", 0x2128: "Z",
  // Double-struck capitals reused likewise.
  0x2102: "C", 0x210d: "H", 0x2115: "N", 0x2119: "P", 0x211a: "Q", 0x211d: "R", 0x2124: "Z",
  // Italic lowercase h reused likewise (Planck-constant symbol).
  0x210e: "h",
};
function foldMathAlphanumeric(codePoint: number): string | undefined {
  const exception = MATH_ALPHANUMERIC_EXCEPTIONS[codePoint];
  if (exception !== undefined) return exception;
  for (const start of MATH_ALPHANUMERIC_LETTER_STYLE_STARTS) {
    if (codePoint >= start && codePoint < start + 26) return String.fromCharCode(65 + (codePoint - start));
    if (codePoint >= start + 26 && codePoint < start + 52) return String.fromCharCode(97 + (codePoint - start - 26));
  }
  for (const start of MATH_ALPHANUMERIC_DIGIT_STYLE_STARTS) {
    if (codePoint >= start && codePoint < start + 10) return String.fromCharCode(48 + (codePoint - start));
  }
  return undefined;
}

/** R2-F10/R3 continuation: the mirroring range of the Unicode tag block (U+E0020-U+E007E) is a byte-for-byte invisible shadow of ASCII 0x20-0x7E (offset -0xE0000) — an attacker spells a hidden word in tag characters that render as NOTHING, folded back to the plain ASCII it shadows so detection sees it. */
function foldTagCharacter(codePoint: number): string | undefined {
  return codePoint >= 0xe0020 && codePoint <= 0xe007e ? String.fromCharCode(codePoint - 0xe0000) : undefined;
}
const HTML_ENTITY_AT_RE = /^&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/;
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// A small, documented confusables table: only the Cyrillic/Greek letters that
// are visually IDENTICAL (or near-identical) to a Latin letter appearing in
// the auto-run/injection keyword lists above (ignore, execute, always, run,
// ask, confirm, permission, instructions, system, admin, ...). Not an attempt
// at a general Unicode confusables database — deliberately small, so it never
// folds unrelated non-Latin text into false Latin matches.
const HOMOGLYPH_FOLD: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ѕ: "s", ј: "j", һ: "h", ԁ: "d", ԛ: "q", ⅼ: "l",
  А: "A", Е: "E", О: "O", Р: "P", С: "C", Х: "X", В: "B", Ѕ: "S", Ј: "J", Ԁ: "D", Ԛ: "Q",
  α: "a", ο: "o", ρ: "p", ν: "v", κ: "k",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y",
};

interface NormalizedText {
  text: string;
  /** `origIndexOf[i]` is the offset into the ORIGINAL content that normalized char `i` came from. */
  origIndexOf: number[];
}

/** Full-width Latin/digits/punctuation (U+FF01-U+FF5E) fold to their ASCII form one-for-one (offset -0xFEE0), the same range `String.prototype.normalize("NFKC")` collapses — done manually here to keep the 1:1 index mapping `origIndexOf` needs. */
function foldFullWidth(ch: string): string {
  const code = ch.codePointAt(0)!;
  return code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch;
}

/** Decodes exactly ONE entity at the very start of `text` (`^`-anchored), or returns undefined if `text` does not start with a recognized entity. */
function decodeEntityStep(text: string): string | undefined {
  const match = HTML_ENTITY_AT_RE.exec(text);
  if (!match) return undefined;
  const body = match[1]!;
  if (body.startsWith("#x")) {
    const code = Number.parseInt(body.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : undefined;
  }
  if (body.startsWith("#")) {
    const code = Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : undefined;
  }
  return NAMED_HTML_ENTITIES[body];
}

function entityMatchLength(text: string): number {
  const match = HTML_ENTITY_AT_RE.exec(text);
  return match ? match[0].length : 0;
}

function normalizeForDetection(content: string): NormalizedText {
  let text = "";
  const origIndexOf: number[] = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    if (content[i] === "&") {
      const rest0 = content.slice(i, i + 12);
      const step0 = decodeEntityStep(rest0);
      if (step0 !== undefined) {
        let totalLen = entityMatchLength(rest0);
        let result = step0;
        // R2-F10 (double/chained-encoded entities): literal source text
        // `&amp;#x67;` decodes its first entity (`&amp;`) to a literal `&`,
        // and the RAW text right after that match (`#x67;`) then forms a
        // second, real entity together with that just-decoded `&`. Bounded
        // to 4 extra rounds so a chain of double/triple-encoded entities
        // collapses to the same plain character a renderer would eventually
        // show, without looping on adversarial input.
        for (let iter = 0; iter < 4 && result === "&"; iter += 1) {
          const probe = "&" + content.slice(i + totalLen, i + totalLen + 12);
          const nextLen = entityMatchLength(probe);
          if (nextLen <= 1) break;
          const nextStep = decodeEntityStep(probe);
          if (nextStep === undefined) break;
          totalLen += nextLen - 1;
          result = nextStep;
        }
        for (const dch of result) {
          text += dch;
          origIndexOf.push(i);
        }
        i += totalLen;
        continue;
      }
    }
    const codePoint = content.codePointAt(i)!;
    const charLen = codePoint > 0xffff ? 2 : 1;
    if (isDroppedForDetection(codePoint)) {
      i += charLen;
      continue;
    }
    const ch = content.slice(i, i + charLen);
    const folded =
      HOMOGLYPH_FOLD[ch] ?? foldMathAlphanumeric(codePoint) ?? foldTagCharacter(codePoint) ?? foldFullWidth(ch);
    for (const fch of folded) {
      text += fch;
      origIndexOf.push(i);
    }
    i += charLen;
  }
  return { text, origIndexOf };
}

/** Maps a normalized-text offset back to the original content, clamped to content length. */
function originalOffset(normalized: NormalizedText, originalContent: string, normalizedOffset: number): number {
  if (normalizedOffset < normalized.origIndexOf.length) {
    return normalized.origIndexOf[normalizedOffset]!;
  }
  return originalContent.length;
}

// --- secret-in-instructions / skill-script-secret --------------------------
//
// R3-F5 (flow 313 W4 review round 3): documented, well-known PLACEHOLDER
// values legitimately appear in security documentation this repo (and any
// other project) legitimately bundles — AWS's own docs use the literal
// access key `AKIAIOSFODNN7EXAMPLE` (any key ending in the literal word
// `EXAMPLE`) as ITS placeholder convention, and this repo's own security-
// baseline rule quotes it while teaching that exact recognition rule. A
// real credential never ends in the literal word `EXAMPLE`. This exemption
// is scoped to the audit-harness ONLY (here, not in `detect/secrets.ts`
// itself, which is a shared choke point other consumers — output
// redaction, `resolve.ts`, `export-audit.ts` — deliberately keep
// unconditional and fail-closed on ANY AWS-shaped key; weakening the shared
// detector would silently weaken those too).
function isDocumentedPlaceholderSecret(match: DetectorMatch): boolean {
  if (match.policyId === "secrets.aws-access-key" && /EXAMPLE$/.test(match.value)) return true;
  return false;
}

export function checkSecretsInText(
  surface: SurfaceId,
  check: "secret-in-instructions" | "skill-script-secret",
  relativePath: string,
  content: string,
  severity: AuditSeverity,
): RawFinding[] {
  const matches = detectSecrets(content).filter((match) => !isDocumentedPlaceholderSecret(match));
  return matches.map((match) => ({
    surface,
    check,
    severity,
    confidence: match.confidence,
    path: relativePath,
    location: { line: lineOfOffset(content, match.start) },
    message: `${relativePath} contains a value matching a secret pattern (${match.policyId}).`,
    evidence: { category: match.category, policyId: match.policyId, matchedToken: match.policyId },
  }));
}

// --- prompt-injection-in-instructions / skill-script-injection -------------
//
// R2-F10: matches against the NORMALIZED text (see above), so a zero-width/
// homoglyph/full-width/HTML-entity evasion of an injection phrase is still
// caught; `location.line` is computed against the ORIGINAL content via
// `originalOffset`, so the reported line is where the (possibly obfuscated)
// text actually lives on disk.

// R3-F5 (flow 313 W4 review round 3): the injection patterns above are
// imperative-SHAPED ("ignore previous instructions") on purpose, so they
// also match the exact phrase a skill quotes WHILE TEACHING DEFENSE against
// it — this repo's own `review-pr-feedback` skill was flagged twice for
// quoting the very phrases it warns readers to watch for. Directed-at-the-
// reader prose ("ignore your previous instructions and do X") and a quoted/
// fenced EXAMPLE of that same phrase ("...matches phrases such as `ignore
// previous instructions`...") read identically to the raw regex; the
// difference a human sees is the quoting/fencing around the second case.
// Neither is suppressed outright (a real injection payload can itself be
// wrapped in quotes to look like documentation) — a quoted or fenced match
// is reported at a lower severity/confidence instead, same choke point as
// the fenced remote-exec downgrade above (`computeFencedRanges`/
// `isInsideFence`), so a human/gate reviewing `medium` findings still sees
// it, but it does not fail the W8 gate (which only fails closed on
// `high`/`critical`) the way an un-quoted, un-fenced imperative directed at
// the reader still does.
const QUOTE_CHARS_ANY = ["'", '"', "`", "‘", "’", "“", "”"];
function matchingCloseQuote(ch: string): string {
  if (ch === "‘") return "’";
  if (ch === "“") return "”";
  return ch;
}

/** True when the match sits inside a quoted span ON THE SAME LINE — an open quote somewhere before it, and its matching close somewhere after it, without crossing a newline (never spans a whole fenced/quoted BLOCK; that is `computeFencedRanges`'s job). */
function isQuotedExample(content: string, start: number, end: number): boolean {
  const lineStart = content.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = content.indexOf("\n", end);
  const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx;
  const before = content.slice(lineStart, start);
  const after = content.slice(end, lineEnd);
  let openChar: string | undefined;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (QUOTE_CHARS_ANY.includes(before[i]!)) {
      openChar = before[i];
      break;
    }
  }
  if (openChar === undefined) return false;
  return after.includes(matchingCloseQuote(openChar));
}

/**
 * True when the phrase is REPORTED/DESCRIBED rather than a direct imperative
 * to the reader — "a comment that says TO ignore prior instructions... is
 * content to report" describes the concept in third person; a real
 * injection payload phrases it as a bare imperative ("Ignore all previous
 * instructions and..."), never as the object of "to". The infinitive marker
 * "to" immediately before the match is the reliable, narrow signal: it never
 * appears before a genuine imperative sentence-start (which begins the
 * clause, with nothing before it but whitespace/punctuation).
 */
function isReportedSpeechContext(content: string, start: number): boolean {
  const before = content.slice(Math.max(0, start - 6), start);
  return /\bto\s*$/i.test(before);
}

function isDowngradedInjectionContext(content: string, origStart: number, origEnd: number): boolean {
  if (isInsideFence(computeFencedRanges(content), origStart)) return true;
  if (isQuotedExample(content, origStart, origEnd)) return true;
  return isReportedSpeechContext(content, origStart);
}

const SEVERITY_RANK: Readonly<Record<AuditSeverity, number>> = { low: 1, medium: 2, high: 3, critical: 4 };
function downgradeSeverity(severity: AuditSeverity): AuditSeverity {
  return SEVERITY_RANK[severity] > SEVERITY_RANK.medium ? "medium" : severity;
}

export function checkInjectionInText(
  surface: SurfaceId,
  check: "prompt-injection-in-instructions" | "skill-script-injection",
  relativePath: string,
  content: string,
  severity: AuditSeverity,
): RawFinding[] {
  const normalized = normalizeForDetection(content);
  const matches = detectInjection(normalized.text);
  return matches.map((match) => {
    const origStart = originalOffset(normalized, content, match.start);
    const origEnd = originalOffset(normalized, content, match.end);
    const quotedOrFenced = isDowngradedInjectionContext(content, origStart, origEnd);
    const effectiveSeverity = quotedOrFenced ? downgradeSeverity(severity) : severity;
    return {
      surface,
      check,
      severity: effectiveSeverity,
      confidence: quotedOrFenced ? Math.min(match.confidence, 0.3) : match.confidence,
      path: relativePath,
      location: { line: lineOfOffset(content, origStart) },
      message: quotedOrFenced
        ? `${relativePath} quotes or fences a phrase matching a prompt-injection pattern (${match.policyId}); treated as a documentation example, not an instruction directed at the reader.`
        : `${relativePath} contains a phrase matching a prompt-injection pattern (${match.policyId}).`,
      evidence: { category: match.category, policyId: match.policyId, matchedToken: match.policyId },
    };
  });
}

// --- auto-run-directive -----------------------------------------------------

const AUTO_RUN_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: "audit.auto-run.always-run-without-asking", regex: /\balways\s+run\b[^.\n]{0,40}\bwithout\s+asking\b/i },
  { id: "audit.auto-run.automatically-execute", regex: /\bautomatically\s+execute\b/i },
  { id: "audit.auto-run.no-confirmation", regex: /\bdo\s+not\s+ask\s+for\s+confirmation\b/i },
  { id: "audit.auto-run.never-ask-permission", regex: /\bnever\s+ask\s+permission\b/i },
  { id: "audit.auto-run.run-immediately", regex: /\brun\s+the\s+following\s+immediately\b/i },
];

// R2-F10: matched against `normalizeForDetection(content)`, not `content`
// itself — see the comment on that function above.
export function checkAutoRunDirective(
  surface: SurfaceId,
  relativePath: string,
  content: string,
): RawFinding[] {
  const findings: RawFinding[] = [];
  const normalized = normalizeForDetection(content);
  for (const pattern of AUTO_RUN_PATTERNS) {
    const match = pattern.regex.exec(normalized.text);
    if (match) {
      findings.push({
        surface,
        check: "auto-run-directive",
        severity: "high",
        confidence: 0.7,
        path: relativePath,
        location: { line: lineOfOffset(content, originalOffset(normalized, content, match.index)) },
        message: `${relativePath} directs an agent to run commands without confirmation (${pattern.id}).`,
        evidence: { category: "prompt-injection", policyId: pattern.id, matchedToken: pattern.id },
      });
    }
  }
  return findings;
}

// --- settings-surface helpers ------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const WILDCARD_ALLOW_PATTERNS = new Set(["*", "Bash(*)", "Bash", "Bash(:*)"]);

export function checkOverPermissiveAllowlist(relativePath: string, settings: unknown): RawFinding[] {
  const permissions = asRecord(asRecord(settings)?.permissions);
  const allow = asStringArray(permissions?.allow);
  const findings: RawFinding[] = [];
  allow.forEach((entry, index) => {
    if (WILDCARD_ALLOW_PATTERNS.has(entry)) {
      const pointer = `/permissions/allow/${index}`;
      const internalProposal: InternalProposal = {
        proposal: {
          id: `remove-allow-${index}-${entry}`,
          rationale: `Remove the unscoped allowlist entry "${entry}" and replace it with a narrowed pattern.`,
          patch: `- ${JSON.stringify(entry)}\n+ (removed; add a narrowed Bash(<cmd>:*) pattern instead)`,
        },
        edit: { kind: "json-remove", path: relativePath, pointer },
      };
      findings.push({
        surface: "settings",
        check: "over-permissive-allowlist",
        severity: "medium",
        confidence: 0.9,
        path: relativePath,
        location: { pointer },
        message: `${relativePath} allows unscoped command execution ("${entry}") with no path/argument restriction.`,
        evidence: { category: "artifact-safety", matchedToken: `entry:${index}` },
        internalProposal,
      });
    }
  });
  return findings;
}

export function checkMissingDenyList(relativePath: string, settings: unknown): RawFinding[] {
  const permissions = asRecord(asRecord(settings)?.permissions);
  const allow = asStringArray(permissions?.allow);
  const deny = asStringArray(permissions?.deny);
  if (allow.length === 0) {
    return [];
  }
  const coversCredentials = deny.some((pattern) => touchesAgentCredentials(pattern));
  if (coversCredentials && deny.length > 0) {
    return [];
  }
  const pointer = "/permissions/deny";
  const internalProposal: InternalProposal = {
    proposal: {
      id: `add-deny-list-${relativePath}`,
      rationale: "Add a deny list covering credential and destructive command families.",
      patch: `+ "deny": ["Bash(rm -rf:*)", "Read(**/.env)", "Read(**/permissions.json)", "Read(**/auth.json)"]`,
    },
    edit: {
      kind: "json-set",
      path: relativePath,
      pointer,
      value: ["Bash(rm -rf:*)", "Read(**/.env)", "Read(**/permissions.json)", "Read(**/auth.json)"],
    },
  };
  return [
    {
      surface: "settings",
      check: "missing-deny-list",
      severity: "medium",
      confidence: 0.8,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} has an allow list but no deny entries covering credential/destructive command families.`,
      evidence: { category: "artifact-safety", matchedToken: "permissions.deny" },
      internalProposal,
    },
  ];
}

const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--yolo",
  "--dangerously-bypass-approvals-and-sandbox",
];

function collectStrings(value: unknown, into: Array<{ text: string; pointer: string }>, pointer: string): void {
  if (typeof value === "string") {
    into.push({ text: value, pointer });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, into, `${pointer}/${index}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as JsonRecord)) {
      collectStrings(nested, into, `${pointer}/${key}`);
    }
  }
}

export function checkBypassFlagPresent(relativePath: string, settings: unknown): RawFinding[] {
  const findings: RawFinding[] = [];
  const root = asRecord(settings);
  const permissions = asRecord(root?.permissions);
  const defaultMode = root?.defaultMode ?? permissions?.defaultMode;
  if (defaultMode === "bypassPermissions") {
    const pointer = permissions?.defaultMode === "bypassPermissions" ? "/permissions/defaultMode" : "/defaultMode";
    findings.push({
      surface: "settings",
      check: "bypass-flag-present",
      severity: "critical",
      confidence: 0.95,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} sets defaultMode to "bypassPermissions", disabling the approval gate.`,
      evidence: { category: "artifact-safety", matchedToken: "defaultMode:bypassPermissions" },
      internalProposal: {
        proposal: {
          id: `reset-default-mode-${relativePath}`,
          rationale: 'Set defaultMode back to "default" so the approval gate applies.',
          patch: '- "defaultMode": "bypassPermissions"\n+ "defaultMode": "default"',
        },
        edit: { kind: "json-set", path: relativePath, pointer, value: "default" },
      },
    });
  }
  const strings: Array<{ text: string; pointer: string }> = [];
  collectStrings(settings, strings, "");
  for (const { text, pointer } of strings) {
    for (const flag of BYPASS_FLAGS) {
      if (text.includes(flag)) {
        findings.push({
          surface: "settings",
          check: "bypass-flag-present",
          severity: "critical",
          confidence: 0.95,
          path: relativePath,
          location: { pointer: pointer || "/" },
          message: `${relativePath} records a permission-bypass flag (${flag}).`,
          evidence: { category: "artifact-safety", matchedToken: `flag:${flag}` },
        });
      }
    }
  }
  return findings;
}

// --- unpinned-mcp-launcher ---------------------------------------------------

/**
 * Whether an npm-style package spec (`pkg`, `pkg@1.2.3`, `@scope/pkg`,
 * `@scope/pkg@1.2.3`, `pkg@latest`) is pinned to a real version. A scoped
 * package with no SECOND `@` is unpinned; `@latest` never counts as a pin.
 */
export function isPinnedPackageSpec(spec: string): boolean {
  if (spec.length === 0) return false;
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    if (secondAt === -1) return false;
    const version = spec.slice(secondAt + 1);
    return version.length > 0 && version !== "latest";
  }
  const at = spec.indexOf("@");
  if (at === -1) return false;
  const version = spec.slice(at + 1);
  return version.length > 0 && version !== "latest";
}

function packageArgFromLauncher(command: string, argv: string[]): { launcher: boolean; spec: string | undefined } {
  const base = command.split("/").pop() ?? command;
  const isPnpmDlx = base === "pnpm" && argv[0] === "dlx";
  const isDirectLauncher = base === "npx" || base === "uvx" || base === "bunx";
  if (!isDirectLauncher && !isPnpmDlx) {
    return { launcher: false, spec: undefined };
  }
  const rest = isPnpmDlx ? argv.slice(1) : argv;
  const spec = rest.find((arg) => arg !== "-y" && arg !== "--yes" && !arg.startsWith("-"));
  return { launcher: true, spec };
}

export function checkUnpinnedMcpLauncher(
  relativePath: string,
  serverName: string,
  command: string,
  argv: string[],
  location: FindingLocation,
): RawFinding[] {
  const { launcher, spec } = packageArgFromLauncher(command, argv);
  if (!launcher || spec === undefined) {
    return [];
  }
  if (isPinnedPackageSpec(spec)) {
    return [];
  }
  return [
    {
      surface: "mcp-configs",
      check: "unpinned-mcp-launcher",
      severity: "high",
      confidence: 0.85,
      path: relativePath,
      location,
      message: `MCP server "${serverName}" launches an unpinned package via ${command} (no @version pin).`,
      evidence: { category: "artifact-safety", matchedToken: `server:${serverName}` },
      internalProposal: {
        proposal: {
          id: `pin-mcp-launcher-${serverName}`,
          rationale: "Pin the launched package to an explicit version.",
          patch: `- "${spec}"\n+ "${spec}@<version>"`,
        },
        edit: { kind: "manual" },
      },
    },
  ];
}

// --- mcp-tool-poisoning / mcp-rug-pull --------------------------------------

export function checkMcpManifest(
  relativePath: string,
  manifest: unknown,
  baseline: Record<string, string> | undefined,
): RawFinding[] {
  const matches = scanMcpManifest(manifest, { baseline, source: relativePath });
  return matches.map((match) => {
    const isRugPull = match.policyId.startsWith("mcp.rug-pull");
    return {
      surface: "mcp-configs",
      check: isRugPull ? "mcp-rug-pull" : "mcp-tool-poisoning",
      severity: match.severity as AuditSeverity,
      confidence: match.confidence,
      path: relativePath,
      message: match.remediation ?? `MCP manifest ${relativePath} matched ${match.policyId}.`,
      evidence: { category: match.category, policyId: match.policyId, matchedToken: match.value },
    };
  });
}

// --- hooks -------------------------------------------------------------------

const TOOL_INPUT_VAR = "(?:TOOL_INPUT|CLAUDE_TOOL_INPUT|tool_input|ARGUMENTS|1)";
const INTERP_VAR_RE = new RegExp(`\\$\\{?\\s*${TOOL_INPUT_VAR}\\s*\\}?`);
const INSIDE_SUBSHELL_RE = new RegExp(`\\$\\([^)]*\\$${TOOL_INPUT_VAR}\\b[^)]*\\)`);
const INSIDE_BACKTICK_RE = new RegExp(`\`[^\`]*\\$${TOOL_INPUT_VAR}\\b[^\`]*\``);
const INSIDE_DQUOTE_RE = new RegExp(`"[^"]*\\$\\{?\\s*${TOOL_INPUT_VAR}\\s*\\}?[^"]*"`);

export function checkHookCommandInjection(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  if (!INTERP_VAR_RE.test(hookCommand)) return [];
  const interpolated =
    INSIDE_SUBSHELL_RE.test(hookCommand) ||
    INSIDE_BACKTICK_RE.test(hookCommand) ||
    INSIDE_DQUOTE_RE.test(hookCommand) ||
    hookCommand.includes("$(") ||
    hookCommand.includes("`");
  if (!interpolated) return [];
  return [
    {
      surface: "hooks",
      check: "hook-command-injection",
      severity: "critical",
      confidence: 0.8,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} shell-interpolates a tool-input-derived value into a hook command instead of passing it as an argv element.`,
      evidence: { category: "prompt-injection", matchedToken: "hook-command" },
    },
  ];
}

const NETWORK_CLIENTS = ["curl", "wget", "nc"];

export function checkHookExfiltrationShape(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  const usesClient = NETWORK_CLIENTS.some((client) => new RegExp(`\\b${client}\\b`).test(hookCommand));
  if (!usesClient) return [];
  const fedFromStdin =
    /\|\s*(curl|wget|nc)\b/.test(hookCommand) ||
    /-d\s+@-/.test(hookCommand) ||
    /--data-binary\s+@-/.test(hookCommand);
  if (!fedFromStdin) return [];
  return [
    {
      surface: "hooks",
      check: "hook-exfiltration-shape",
      severity: "high",
      confidence: 0.75,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} pipes tool output/stdin into a network client, an exfiltration shape.`,
      evidence: { category: "egress", matchedToken: "hook-command" },
    },
  ];
}

// --- hook-remote-exec / bundle-hook-remote-exec -----------------------------
//
// R1-F13 (flow 313 W4 review round 1, and round 2's R1-F13 residual):
// `checkHookExfiltrationShape` above only flags a command that PIPES OUTPUT
// INTO curl/wget (exfiltration). It has nothing to say about the opposite,
// and more common, shape: a download tool's OUTPUT piped into (or
// substituted into) a shell/interpreter — the classic `curl ... | bash`
// supply-chain footgun. Round 2 found the first pass missed 14 everyday
// variants of the same shapes (a `sudo -E`/`env`/absolute-path wrapper on the
// interpreter, an intermediate `tee`, combined `-lc`-style flag clusters,
// backticks instead of `$(...)`, `source`/`.` instead of an interpreter name,
// download-to-file-then-separately-execute, and three PowerShell spellings)
// — every shape below is now wrapped through `WRAPPER_PREFIX`, which
// recognizes: leading `VAR=value` assignments, `sudo` (with flags),
// `env` (with flags/assignments), and an absolute path prefix, in any
// combination, before the actual interpreter name.
//   1. `curl|wget ... | [tee <path> |] [wrapper] sh|bash|zsh|dash|ksh|python[3]|node|perl|ruby`
//   2. `sh|bash|... -[flags]c["'] $(curl|wget ...)` or backtick-quoted (command substitution fed to a `c`-bearing flag cluster, e.g. `-c`, `-lc`, `-ic`)
//   3. `sh|bash|... <(curl|wget ...)` (process substitution)
//   4. `source|. <(curl|wget ...)` (sourcing a process substitution)
//   5. `eval $(curl|wget ...)` or backtick-quoted
//   6. `curl|wget ... -o|-O|--output ... && [wrapper] sh|bash|...` (download to a file, then separately execute it)
//   7. PowerShell `iex (iwr ...)` / `Invoke-Expression (Invoke-WebRequest ...)`
//   8. PowerShell `iwr|irm ... | iex` (download piped straight into Invoke-Expression)
//   9. PowerShell `iex (... DownloadString(...))` (`Net.WebClient` instead of `iwr`)
// Each shape is checked independent of an interpreter's own `-s`/`-`
// stdin-marker flags, which never gate whether the shape is dangerous — only
// whether the flag is present or absent, both still execute remote content.
//
// R2-F12: "fetch" was dropped from `DOWNLOAD_TOOLS` — unlike `curl`/`wget`
// it is not a de-facto standard CLI download tool name, and is instead an
// extremely common identifier (the JS/browser `fetch()` API, shell
// completions, unrelated CLIs), which made ordinary documentation ("fetch
// the file, then pipe it to...") match as if it were a download command. The
// two real CLI tools are enough to catch the shape without that false-
// positive rate; `checkHookRemoteExec` (hook-config JSON commands, never
// markdown) is unaffected by the fenced-code rule below, which only applies
// to free text via `checkRemoteExecInText`.
const SHELL_INTERPRETERS = "sh|bash|zsh|dash|ksh|python3?|node|perl|ruby";
// R2-F12 (flow 313 W4 review round 2/3 residual): a shell (`sh`/`bash`/...)
// piped a download's output ALWAYS executes it as commands — there is no
// legitimate "pipe into a shell as a filter" usage. A scripting-language
// interpreter (`python3`/`node`/`perl`/`ruby`) is different: `curl ... |
// python3 -m json.tool` and `curl ... | node -e 'console.log(1)'` are
// ordinary, common documentation for piping a download into a FILTER/
// pretty-printer, not into code execution — the interpreter never reads its
// own PROGRAM from stdin when it is given a module/flag/script argument.
// Split the interpreter list so the pipe-to-shell shape only fires
// unconditionally for the shell-likes; a pipe into a scripting interpreter
// is only the "download that gets executed" shape when the interpreter is
// BARE (reads its program from stdin) — nothing else on the line after its
// name — which is exactly what `PIPE_TO_SCRIPT_STDIN_RE` below requires via
// its trailing lookahead.
const SHELL_LIKE_INTERPRETERS = "sh|bash|zsh|dash|ksh";
const SCRIPT_STDIN_INTERPRETERS = "python3?|node|perl|ruby";
const DOWNLOAD_TOOLS = "curl|wget";
const ABS_PATH_PREFIX = "(?:/usr/bin/|/bin/|/usr/local/bin/)?";
// Leading `VAR=value` assignments, then an optional `sudo`, then an optional
// `env`, then an optional absolute path — each independently optional, any
// combination, in that order — right before the interpreter name itself.
const WRAPPER_PREFIX =
  `(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*` +
  `(?:${ABS_PATH_PREFIX}sudo(?:\\s+-[A-Za-z]+)*\\s+)?` +
  `(?:${ABS_PATH_PREFIX}env(?:\\s+-[A-Za-z]+)*(?:\\s+[A-Za-z_][A-Za-z0-9_]*=\\S+)*\\s+)?` +
  `${ABS_PATH_PREFIX}`;
// A single `| tee <path> |` hop between the download and the final shell
// (`curl ... | tee save.sh | bash`), tee'ing the payload to disk on the way
// to execution — still a download-and-execute shape.
const TEE_HOP = `(?:tee\\s+\\S+\\s*\\|\\s*)?`;
// Backtick, spelled via ` so it never has to appear as a literal
// backtick character inside these template-literal regex sources.
const BACKTICK = "\\u0060";

const PIPE_TO_SHELL_RE = new RegExp(
  `\\b(?:${DOWNLOAD_TOOLS})\\b[^\\n]*\\|\\s*${TEE_HOP}${WRAPPER_PREFIX}(?:${SHELL_LIKE_INTERPRETERS})(?!-)\\b`,
  "i",
);
// R2-F12 residual: only a BARE scripting interpreter (nothing after its name
// but a separator/end-of-line) counts as "reads and executes the piped
// download" — `(?=\s*(?:[;&|]|\n|$))` requires that boundary.
const PIPE_TO_SCRIPT_STDIN_RE = new RegExp(
  `\\b(?:${DOWNLOAD_TOOLS})\\b[^\\n]*\\|\\s*${TEE_HOP}${WRAPPER_PREFIX}(?:${SCRIPT_STDIN_INTERPRETERS})(?!-)\\b(?=\\s*(?:[;&|]|\\n|$))`,
  "i",
);
const DASH_C_COMMAND_SUB_RE = new RegExp(
  `\\b(?:${SHELL_INTERPRETERS})\\s+-[a-zA-Z]*c[a-zA-Z]*\\s+["']?(?:\\$\\(|${BACKTICK})\\s*(?:${DOWNLOAD_TOOLS})\\b`,
  "i",
);
const PROCESS_SUB_RE = new RegExp(`\\b(?:${SHELL_INTERPRETERS})\\s+<\\(\\s*(?:${DOWNLOAD_TOOLS})\\b`, "i");
const SOURCE_PROCESS_SUB_RE = new RegExp(`(?:\\bsource\\b|(?:^|[;&|]\\s*)\\.)\\s+<\\(\\s*(?:${DOWNLOAD_TOOLS})\\b`, "i");
const EVAL_COMMAND_SUB_RE = new RegExp(`\\beval\\b[^\\n]*(?:\\$\\(|${BACKTICK})\\s*(?:${DOWNLOAD_TOOLS})\\b`, "i");
const DOWNLOAD_THEN_EXEC_RE = new RegExp(
  `\\b(?:${DOWNLOAD_TOOLS})\\b[^\\n]*\\s(?:-o|-O|--output)\\b[^\\n]*(?:&&|;)\\s*${WRAPPER_PREFIX}(?:${SHELL_INTERPRETERS})(?!-)\\b`,
  "i",
);
const POWERSHELL_IEX_RE = /\b(?:iex|invoke-expression)\b[^\n]*\(\s*(?:iwr|invoke-webrequest)\b/i;
const POWERSHELL_PIPE_IEX_RE = /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b/i;
const POWERSHELL_DOWNLOADSTRING_RE = /\b(?:iex|invoke-expression)\b[^\n]*downloadstring/i;

const REMOTE_EXEC_SHAPES: Array<{ id: string; regex: RegExp }> = [
  { id: "audit.hook.remote-exec.pipe-to-shell", regex: PIPE_TO_SHELL_RE },
  { id: "audit.hook.remote-exec.pipe-to-script-stdin", regex: PIPE_TO_SCRIPT_STDIN_RE },
  { id: "audit.hook.remote-exec.dash-c-command-substitution", regex: DASH_C_COMMAND_SUB_RE },
  { id: "audit.hook.remote-exec.process-substitution", regex: PROCESS_SUB_RE },
  { id: "audit.hook.remote-exec.source-process-substitution", regex: SOURCE_PROCESS_SUB_RE },
  { id: "audit.hook.remote-exec.eval-command-substitution", regex: EVAL_COMMAND_SUB_RE },
  { id: "audit.hook.remote-exec.download-then-execute", regex: DOWNLOAD_THEN_EXEC_RE },
  { id: "audit.hook.remote-exec.powershell-iex", regex: POWERSHELL_IEX_RE },
  { id: "audit.hook.remote-exec.powershell-pipe-iex", regex: POWERSHELL_PIPE_IEX_RE },
  { id: "audit.hook.remote-exec.powershell-downloadstring", regex: POWERSHELL_DOWNLOADSTRING_RE },
];

function matchRemoteExecShape(text: string): { id: string; index: number } | undefined {
  for (const shape of REMOTE_EXEC_SHAPES) {
    const match = shape.regex.exec(text);
    if (match) return { id: shape.id, index: match.index };
  }
  return undefined;
}

// R1-F13 (flow 313 W4 review round 1/3): the literal SHAPES above (a
// specific download tool piped/substituted into a specific interpreter) can
// never enumerate every schema-valid hook argv that fetches and runs remote
// code — round 3 showed 15 of 18 schema-valid shapes slipping past unflagged:
// `python3 -c "exec(urlopen(...).read())"`, `node -e "fetch(..).then(eval)"`,
// `perl -MLWP::Simple -e ...`, a reverse shell via `/dev/tcp` or `nc -e`,
// `busybox sh`, a base64-decoded payload piped to a shell, and quote/
// variable-split obfuscation of a download tool's own name (`c''url`,
// `c${X}url`). Rather than adding yet more literal shapes (a denylist of
// known-bad forms can never close a behavior CLASS), these are matched by
// BEHAVIOR: "an interpreter is told to execute a literal program string" or
// "a raw TCP/reverse-shell primitive is invoked" or "a decoded/obfuscated
// payload is piped into a shell" — always reported at MEDIUM (never blocks
// the W8 gate on its own), because a `-c`/`-e` flag legitimately appears in
// tooling that never fetches remote code; a human/reviewer still sees it.
const INTERPRETER_EXEC_FLAG_RE =
  /\b(?:python3?|node|perl|ruby|php)\b(?:\s+(?:-[A-Za-z][A-Za-z0-9:]*|--[A-Za-z][A-Za-z0-9-]*(?:=\S+)?))*\s+-[A-Za-z]*[ceM][A-Za-z]*\b/;
const REVERSE_SHELL_RE = /\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^\n]{0,20}-e\b|\bbusybox\s+sh\b/i;
const BASE64_PIPE_SHELL_RE = new RegExp(
  `\\bbase64\\b[^\\n]{0,20}(?:-d|--decode)\\b[^\\n]{0,20}\\|\\s*${TEE_HOP}${WRAPPER_PREFIX}(?:${SHELL_INTERPRETERS})(?!-)\\b`,
  "i",
);

const BEHAVIOR_CLASS_SHAPES: Array<{ id: string; regex: RegExp }> = [
  { id: "audit.hook.remote-exec.interpreter-exec-flag", regex: INTERPRETER_EXEC_FLAG_RE },
  { id: "audit.hook.remote-exec.reverse-shell-primitive", regex: REVERSE_SHELL_RE },
  { id: "audit.hook.remote-exec.base64-pipe-to-shell", regex: BASE64_PIPE_SHELL_RE },
];

/**
 * Quote/variable-split obfuscation (`c''url`, `c${X}url`, `c"u"rl`) hides a
 * download tool's or interpreter's name from every regex above by splicing
 * an empty-string shell expansion INSIDE the literal word — the shell itself
 * collapses these back to the plain word before exec, so a detector reading
 * the RAW text has to do the same collapse to see what will actually run.
 * Only empty/trivial expansions are collapsed (an adjacent empty quote pair,
 * or a `${NAME}` reference) — never a guess at what a variable's runtime
 * value is, so this can only ever reveal a shape, never hallucinate one that
 * ISN'T there in some other resolution of the variable.
 */
function deobfuscateShellText(text: string): string {
  return text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "").replace(/(['"])\1/g, "");
}

function matchBehaviorClassShape(text: string): { id: string; index: number } | undefined {
  for (const shape of BEHAVIOR_CLASS_SHAPES) {
    const match = shape.regex.exec(text);
    if (match) return { id: shape.id, index: match.index };
  }
  const deobfuscated = deobfuscateShellText(text);
  if (deobfuscated !== text) {
    const direct = matchRemoteExecShape(deobfuscated);
    if (direct) return { id: `${direct.id}.obfuscated`, index: direct.index };
    for (const shape of BEHAVIOR_CLASS_SHAPES) {
      const match = shape.regex.exec(deobfuscated);
      if (match) return { id: `${shape.id}.obfuscated`, index: match.index };
    }
  }
  return undefined;
}

/** Hook-config `command` strings (JSON, pointer-addressed) — both the live `hooks` surface and, via `bundle-hook-remote-exec`, a staged bundle's `hook-config` entries. Never inside markdown, so the fenced-code severity rule in `checkRemoteExecInText` does not apply here — always `high`. */
export function checkHookRemoteExec(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  const match = matchRemoteExecShape(hookCommand);
  if (match) {
    return [
      {
        surface: "hooks",
        check: "hook-remote-exec",
        severity: "high",
        confidence: 0.85,
        path: relativePath,
        location: { pointer },
        message: `${relativePath} downloads and executes remote content (${match.id}), a download-and-execute shape.`,
        evidence: { category: "egress", policyId: match.id, matchedToken: match.id },
      },
    ];
  }
  const behavior = matchBehaviorClassShape(hookCommand);
  if (!behavior) return [];
  return [
    {
      surface: "hooks",
      check: "hook-remote-exec",
      severity: "medium",
      confidence: 0.55,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} matches a remote-execution behavior class (${behavior.id}) — an interpreter/shell primitive that can run fetched or decoded content.`,
      evidence: { category: "egress", policyId: behavior.id, matchedToken: behavior.id },
    },
  ];
}

// R2-F12: a `curl ... | python3 -m json.tool`-shaped documentation example is
// legitimate and common inside a fenced code block explaining CLI usage —
// the regex above cannot tell "download piped into an interpreter to run
// unknown remote code" apart from "download piped into an interpreter as a
// benign filter", so instead of missing the real shape entirely, a match
// found strictly INSIDE a markdown fenced code block (```...``` or ~~~...~~~)
// is reported at `medium` (never blocks the W8 audit gate, which only fails
// closed on `high`/`critical`) while the exact same shape found OUTSIDE a
// fence — in a script that is actually executed, or in prose instructing an
// agent to run it — stays `high`.
// R3-F6 (flow 313 W4 review round 3, choke point f): the previous version
// treated ANY line whose TRIMMED start began with ``` or ~~~ as a fence
// marker, with no indentation limit, and — if a fence was never explicitly
// closed — silently spanned the "fence" all the way to end-of-content. Both
// let an attacker force the medium-severity downgrade above onto content
// that a real markdown renderer would never treat as fenced: an 8-space-
// indented ``` (CommonMark caps fence-marker indentation at 3 spaces; wider
// indentation is either an indented code block with no closing rule, or
// plain paragraph text) or an unterminated fence (open ``` with no matching
// close before the file ends) both used to "close" over everything that
// followed. A fence range is now only ever produced from a MATCHED opening/
// closing marker PAIR, each indented at most 3 spaces, mirroring how a
// CommonMark renderer decides a block is fenced; an unclosed trailing fence
// contributes no range at all (nothing after it is treated as "inside a
// fence").
const MAX_FENCE_INDENT = 3;

function computeFencedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fenceStart: number | undefined;
  let fenceMarker: string | undefined;
  for (const line of content.split("\n")) {
    const indentMatch = /^ */.exec(line);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const trimmed = line.slice(indent);
    const marker =
      indent <= MAX_FENCE_INDENT && trimmed.startsWith("```")
        ? "`"
        : indent <= MAX_FENCE_INDENT && trimmed.startsWith("~~~")
          ? "~"
          : undefined;
    if (marker !== undefined) {
      if (fenceStart === undefined) {
        fenceStart = offset;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        ranges.push([fenceStart, offset + line.length]);
        fenceStart = undefined;
        fenceMarker = undefined;
      }
    }
    offset += line.length + 1;
  }
  // An unterminated trailing fence (fenceStart still set) produces no range:
  // nothing after an unclosed opening marker is "inside a fence".
  return ranges;
}

function isInsideFence(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Free-text content (skill scripts/instructions, line-addressed) — used against a staged bundle's `skill` entry text under `bundle-hook-remote-exec`. */
export function checkRemoteExecInText(surface: SurfaceId, relativePath: string, content: string): RawFinding[] {
  const match = matchRemoteExecShape(content);
  if (match) {
    const fenced = isInsideFence(computeFencedRanges(content), match.index);
    const severity: AuditSeverity = fenced ? "medium" : "high";
    return [
      {
        surface,
        check: "hook-remote-exec",
        severity,
        confidence: fenced ? 0.6 : 0.85,
        path: relativePath,
        location: { line: lineOfOffset(content, match.index) },
        message: fenced
          ? `${relativePath} shows a download-and-execute shape (${match.id}) inside a fenced code block; treated as a documentation example, not confirmed executable content.`
          : `${relativePath} downloads and executes remote content (${match.id}), a download-and-execute shape.`,
        evidence: { category: "egress", policyId: match.id, matchedToken: match.id },
      },
    ];
  }
  const behavior = matchBehaviorClassShape(content);
  if (!behavior) return [];
  return [
    {
      surface,
      check: "hook-remote-exec",
      severity: "medium",
      confidence: 0.5,
      path: relativePath,
      location: { line: lineOfOffset(content, behavior.index) },
      message: `${relativePath} matches a remote-execution behavior class (${behavior.id}) — an interpreter/shell primitive that can run fetched or decoded content.`,
      evidence: { category: "egress", policyId: behavior.id, matchedToken: behavior.id },
    },
  ];
}

// I2 (review round 3, investigated): only the SEPARATOR set was widened here
// (adding `||`, alongside the already-handled `;`/`&&`) — the anchor to the
// END of the string stays. A genuinely mid-command `exit 0` with more
// command chained after it (`echo hi && exit 0 && continue-cmd`) is NOT
// stripped here, on purpose, per F20's existing rationale below: removing it
// would not just unsuppress a failing gate, it would also change the
// command's CONTROL FLOW by resurrecting code that `exit 0` currently makes
// unreachable (`continue-cmd` never runs today; strip the `exit 0` and it
// would). That is not a "simple, safe regex change" — a blind global strip
// was tried and reverted here after `F20`'s own test (mid-command exit 0
// must stay a no-op) caught exactly this. `||` is safe to add to the
// TRAILING case because the reasoning is identical to `;`/`&&` there:
// nothing follows a trailing `exit 0` for control flow to change.
const TRAILING_EXIT0_RE = /\s*(?:;|&&|\|\|)\s*exit\s+0\s*$/;

/**
 * N4: strip EVERY `|| true` and `2>/dev/null` occurrence (not just the
 * first), plus a trailing `; exit 0` / `&& exit 0` / `|| exit 0` (I2: now
 * including `||`) (repeated, if the command chains more than one), then
 * trim. Pure string transform — used to build the `json-set` edit's
 * replacement VALUE directly (no text search against the raw file bytes), so
 * a command containing JSON-escaped quotes is unaffected: the value is
 * assigned into the already-parsed object graph and re-serialized, never
 * spliced into the file's text.
 */
function stripHookSuppression(command: string): string {
  let next = command.replace(/\s*\|\|\s*true\b/g, "").replace(/\s*2>\/dev\/null/g, "");
  let previous: string;
  do {
    previous = next;
    next = next.replace(TRAILING_EXIT0_RE, "");
  } while (next !== previous);
  return next.trim();
}

export function checkHookSilentSuppression(relativePath: string, hookCommand: string, pointer: string): RawFinding[] {
  const suppressed =
    /\|\|\s*true\b/.test(hookCommand) ||
    /2>\/dev\/null/.test(hookCommand) ||
    /;\s*exit\s+0\b/.test(hookCommand) ||
    /&&\s*exit\s+0\b/.test(hookCommand) ||
    /\|\|\s*exit\s+0\b/.test(hookCommand);
  if (!suppressed) return [];
  const rewritten = stripHookSuppression(hookCommand);
  // N4: `checkHookSilentSuppression` is only ever called (from `index.ts`)
  // against a `command` string already extracted from a PARSED JSON settings
  // file — the previous `text-replace` edit re-searched the raw file TEXT for
  // `hookCommand` verbatim, which breaks the moment the command contains a
  // character JSON escapes on disk (a `"` becomes `\"`, for instance) and,
  // being a single `String#replace`, only ever removed the FIRST `|| true`.
  // A `json-set` edit at the command's own JSON pointer sidesteps both: it
  // mutates the parsed object graph directly (no text matching at all) and
  // writes the fully-stripped command in one shot. Kept conditional on the
  // path actually being JSON so a hypothetical non-JSON caller still gets a
  // text edit — `applyTextEdit` already refuses an edit whose `from` is not
  // exactly one match in the file (see F2), so that path stays safe too.
  const isJsonFile = relativePath.toLowerCase().endsWith(".json");
  return [
    {
      surface: "hooks",
      check: "hook-silent-suppression",
      severity: "high",
      confidence: 0.8,
      path: relativePath,
      location: { pointer },
      message: `${relativePath} silently suppresses a failing gate hook's exit status.`,
      evidence: { category: "artifact-safety", matchedToken: "hook-command" },
      internalProposal: {
        proposal: {
          id: `remove-suppression-${pointer}`,
          rationale: "Remove the suppression so a failing hook actually reports failure.",
          // F4: the raw hook command can embed a secret (a token baked into a
          // curl/wget flag, for instance) — this `patch` is advisory display
          // text (never what the edit below actually writes), so it goes
          // through the same redaction floor used to sanitize tool output
          // before it reaches a report/log.
          patch: redactSensitiveText(`- ${hookCommand}\n+ ${rewritten}`),
        },
        edit: isJsonFile
          ? { kind: "json-set", path: relativePath, pointer, value: rewritten }
          : { kind: "text-replace", path: relativePath, from: hookCommand, to: rewritten },
      },
    },
  ];
}

const EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;

/**
 * The same shell-suppression shapes `checkHookSilentSuppression` looks for
 * in a JSON hook `command` string — a non-JSON hook artifact (a generated
 * script/plugin file, e.g. OpenCode's bridge plugin) can embed the exact same
 * shell fragment as a string literal it shells out with, so the same three
 * patterns apply here too, not just the JS-specific empty-catch shape below.
 */
const SCRIPT_SHELL_SUPPRESSION_RE = /\|\|\s*true\b|2>\/dev\/null|;\s*exit\s+0\b/;

export function checkHookSilentSuppressionInScript(relativePath: string, content: string): RawFinding[] {
  const emptyCatch = EMPTY_CATCH_RE.exec(content);
  const shellSuppression = SCRIPT_SHELL_SUPPRESSION_RE.exec(content);
  const match =
    emptyCatch && shellSuppression
      ? emptyCatch.index <= shellSuppression.index
        ? emptyCatch
        : shellSuppression
      : (emptyCatch ?? shellSuppression);
  if (!match) return [];
  const matchedToken = match === emptyCatch ? "empty-catch" : "shell-suppression";
  const message =
    match === emptyCatch
      ? `${relativePath} has an empty catch block that silently swallows a hook failure.`
      : `${relativePath} silently suppresses a failing hook's exit status.`;
  return [
    {
      surface: "hooks",
      check: "hook-silent-suppression",
      severity: "high",
      confidence: 0.7,
      path: relativePath,
      location: { line: lineOfOffset(content, match.index) },
      message,
      evidence: { category: "artifact-safety", matchedToken },
    },
  ];
}

// --- agent-definitions -------------------------------------------------------
//
// Flow 310 (W2) T13: format-aware. `src/agents/compile.ts` writes three
// non-markdown shapes (`.codex/agents/*.toml`, `.kiro/agents/*.json`) plus
// two markdown shapes (`.claude/agents/*.md`, `.opencode/agents/*.md`) —
// only claude's frontmatter carries a first-party `tools`/`model` field of
// the kind the original markdown-only checks below looked for. Every other
// format's own allowlist/tier signal is checked in its own native shape
// (never re-derived by re-parsing a markdown-shaped check against
// non-markdown content); the check ids and the plain-markdown behavior below
// are UNCHANGED from before this task.

function parseFrontmatter(content: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      fields[kv[1]!.toLowerCase()] = (kv[2] ?? "").trim();
    }
  }
  return fields;
}

/** R2-F6: the frontmatter BLOCK's own raw YAML text (delimiters excluded) — for parsing with `Bun.YAML`, never the whole file (the body may itself contain `---`-shaped text). `undefined` when there is no well-formed block at all. */
function frontmatterBlockText(content: string): string | undefined {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
}

/** Whether a TOML top-level `key = ...` assignment appears anywhere in `content` — a dependency-free FALLBACK for when `Bun.TOML.parse` cannot make sense of `content` at all, sufficient for the single-line keys (`sandbox_mode`, `model`) codex's renderer ever emits. Prefer `tomlHasTopLevelKey` (real TOML parse), which this backs up. */
function tomlHasKey(content: string, key: string): boolean {
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(content);
}

/**
 * R2-F6 (residual): the plain `tomlHasKey` regex scans the WHOLE file, so a
 * `model = ...`-shaped line embedded inside `developer_instructions`'s
 * multi-line body (prose, not real TOML structure) can be mistaken for a
 * genuine top-level key. Parse with `Bun.TOML.parse` (already used
 * elsewhere in this codebase for the same reason — `compile.format-
 * safety.test.ts`) and check the real, structured document; fall back to the
 * regex heuristic only when the content does not parse as TOML at all (a
 * hand-edited/malformed file this audit still wants to say SOMETHING about).
 */
function tomlHasTopLevelKey(content: string, key: string): boolean {
  try {
    const doc = Bun.TOML.parse(content) as Record<string, unknown>;
    if (doc && typeof doc === "object" && key in doc) return true;
    return false;
  } catch {
    return tomlHasKey(content, key);
  }
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `model_tier=<tier>` inside the keryx-managed sentinel — the one tier
 * signal available on a host format with no first-party `model`/
 * `model_tier` field of its own (codex/kiro omit `model` entirely;
 * opencode's documented frontmatter has no tier field). Only ever a
 * FALLBACK: a format's own explicit field is checked first, so this never
 * masks a hand-authored file that carries neither the field nor the
 * sentinel.
 *
 * R2-F6: anchored to `../../agents/sentinel`'s STRUCTURAL candidate position
 * (the line right after frontmatter close, TOML's first line, or — for kiro
 * — only the FIRST LINE of the parsed `prompt` field), never a whole-file or
 * whole-line-of-the-one-physical-JSON-line scan. Before this, a kiro file's
 * `prompt` value is ONE physical text line containing the entire header too
 * (JSON encodes real newlines as `\n`), so prose anywhere in that header
 * could suppress the finding; now only the sentinel's own structural line is
 * ever tested.
 */
function hasSentinelModelTier(content: string, format: AgentSentinelFormat): boolean {
  return structuralSentinelModelTier(content, format) !== undefined;
}

/**
 * R2-F3: whether claude frontmatter's `tools` value is a genuine, non-empty
 * allowlist. Tries `Bun.YAML.parse` on the frontmatter BLOCK first (real
 * type information — YAML null spellings all parse to `null`, distinct from
 * an empty string or an empty sequence), and only falls back to a scalar
 * text check on `fields.tools` (from the hand-rolled `parseFrontmatter`
 * above) when that block does not parse as YAML at all. `undefined`
 * `fields`/absent `tools` key both mean "no allowlist declared" — `false`.
 */
function claudeToolsIsAllowlist(content: string, fields: Record<string, string> | undefined): boolean {
  const block = frontmatterBlockText(content);
  if (block !== undefined) {
    try {
      const parsed = Bun.YAML.parse(block) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "tools" in (parsed as Record<string, unknown>)) {
        const toolsValue = (parsed as Record<string, unknown>).tools;
        if (toolsValue === null || toolsValue === undefined) return false;
        if (typeof toolsValue === "string" && toolsValue.trim().length === 0) return false;
        if (Array.isArray(toolsValue) && toolsValue.length === 0) return false;
        return true;
      }
      // Block parsed but carries no `tools` key at all — no allowlist.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return false;
    } catch {
      // Fall through to the scalar-text fallback below.
    }
  }
  const toolsValue = fields?.tools;
  if (toolsValue === undefined) return false;
  const trimmed = toolsValue.trim();
  const NULL_LIKE = new Set(["null", "Null", "NULL", "~", "[]"]);
  const isNullLike = trimmed.length === 0 || trimmed === '""' || trimmed === "''" || NULL_LIKE.has(trimmed);
  return !isNullLike;
}

export function checkAgentUnrestrictedTools(relativePath: string, content: string): RawFinding[] {
  const format = agentSentinelFormatOf(relativePath);
  let hasAllowlist: boolean;
  if (format === "toml") {
    // codex governs access entirely via `sandbox_mode` (read-only |
    // workspace-write) — it has no per-tool allowlist at all, so the
    // presence of that key IS the closest analog to a restriction here
    // (`compile.ts#renderCodexExport`'s own documented rationale).
    hasAllowlist = tomlHasTopLevelKey(content, "sandbox_mode");
  } else if (format === "kiro-json") {
    // kiro's `tools` is a JSON array of coarse tags/builtin names
    // (`compile.ts#renderKiroExport`).
    const doc = parseJsonObject(content);
    hasAllowlist = Array.isArray(doc?.tools);
  } else {
    // md: claude's `tools` frontmatter key, or opencode's `permission` block
    // (frontmatter `permission:` parses as a present-but-empty-value key
    // above, which is enough to detect the block exists).
    //
    // R1-F12/R2-F3: a PRESENT `tools` key is not by itself a restriction.
    // Claude Code treats an empty/null `tools` (omitted value, `""`, `''`,
    // or any YAML null spelling — `null`/`Null`/`NULL`/`~` — as well as an
    // explicit `[]`) as "no allowlist declared" and grants the subagent
    // every tool — the least-restricted outcome, not a restricted one — so
    // every one of those shapes must still count as
    // agent-unrestricted-tools rather than passing because the key exists.
    // `permission:` has no such empty-means-unrestricted footgun documented
    // for it, so its mere presence still counts as an allowlist.
    //
    // Parsed with `Bun.YAML` first (real type information: null vs "" vs []
    // vs a non-empty scalar/sequence, none of which a hand-rolled string
    // check can tell apart reliably) and falls back to a precise scalar
    // check only when the frontmatter block does not parse as YAML at all.
    const fields = parseFrontmatter(content);
    const hasPermissionBlock = !!fields && "permission" in fields;
    const toolsAllowlistResult = claudeToolsIsAllowlist(content, fields);
    hasAllowlist = toolsAllowlistResult || hasPermissionBlock;
  }
  if (hasAllowlist) return [];
  return [
    {
      surface: "agent-definitions",
      check: "agent-unrestricted-tools",
      severity: "medium",
      confidence: 0.9,
      path: relativePath,
      message: `${relativePath} has no \`tools\` allowlist in its frontmatter.`,
      evidence: { category: "artifact-safety", matchedToken: "frontmatter:tools" },
    },
  ];
}

export function checkAgentMissingModelTier(relativePath: string, content: string): RawFinding[] {
  const format = agentSentinelFormatOf(relativePath);
  let hasTier: boolean;
  if (format === "toml") {
    hasTier = tomlHasTopLevelKey(content, "model") || hasSentinelModelTier(content, format);
  } else if (format === "kiro-json") {
    const doc = parseJsonObject(content);
    hasTier = typeof doc?.model === "string" || hasSentinelModelTier(content, format);
  } else {
    const fields = parseFrontmatter(content);
    hasTier = !!(fields && ("model_tier" in fields || "model" in fields)) || hasSentinelModelTier(content, format);
  }
  if (hasTier) return [];
  return [
    {
      surface: "agent-definitions",
      check: "agent-missing-model-tier",
      severity: "low",
      confidence: 0.9,
      path: relativePath,
      message: `${relativePath} has no \`model_tier\` (or \`model\`) declared in its frontmatter.`,
      evidence: { category: "artifact-safety", matchedToken: "frontmatter:model_tier" },
    },
  ];
}

export { lineOfOffset };
