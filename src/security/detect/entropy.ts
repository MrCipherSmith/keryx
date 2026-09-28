import type { DetectorMatch } from "../types";

// High-entropy string heuristic (specification.md §10). Flags long tokens with
// high Shannon entropy that sit near a sensitive label. Confidence is kept in the
// heuristic band (0.4-0.7) per §7a so it does not over-block.
//
// REVIEW ROUND (flow 355, PR #776): four findings landed here together, and
// they interact, so the fixes are described together.
//
//   F-LOG-F1 (blocker) — `TOKEN`'s character class includes `/`, so a URL's
//   `host/path/…/<sha40>` was ONE joined candidate. That escaped the
//   allow-shapes (the joined string is not a bare `<sha40>`, so
//   `isAllowShapedValue` never matched it) AND picked up a false label from
//   a hostname substring (the label check had no boundary check at all, so
//   "api" inside "api.github.com" counted). Fixed by never treating a URL's
//   host+path+query+fragment as one run: `findUrlSpans`/`urlComponentSpans`
//   below decompose a URL into its PATH SEGMENTS, QUERY VALUES and FRAGMENT
//   and evaluate each SEPARATELY (label-free — see `looksSecretShaped`'s own
//   comment for why), and the generic per-line scan SKIPS any span inside a
//   recognised URL so the two paths never double- or mis-handle the same
//   bytes. The label check also gained a boundary check (word/segment,
//   `_`/space/`:`/`(`/`)` count as boundaries, a bare concatenation like
//   "apiary" does not) — real, but secondary to the URL fix: a dot-joined
//   hostname label ("api.github.com") still LOOKS boundary-legal by that
//   measure alone, which is exactly why the URL path is excluded from this
//   scan entirely rather than patched with a cleverer boundary regex.
//
//   F-SEC-F2 (major) — an allow-shape used to exempt a value even with an
//   explicit label sitting right next to it: `'leaked token: <40-hex>'` was
//   left unredacted, because the old code checked the allow-shape BEFORE
//   the label and returned early. Fixed: the per-line scan no longer
//   consults the allow-shape list AT ALL — a label is required to flag
//   anything in that path regardless (unchanged), and once a label is
//   present it OVERRIDES an allow-shape rather than being overridden by it.
//   `isAllowShapedValue` still applies unconditionally for the two LABEL-FREE
//   callers (`looksSecretShaped`, the URL-component scan), where there is no
//   label to override it with.
//
//   F-REG-F3 (major) — `HEX_BLOB` accepted a digits-only run, so a 24+-digit
//   order id or phone number could be masked. Fixed: `isHexBlob` now also
//   requires an a–f LETTER. This is not a narrower heuristic bolted on —
//   Shannon entropy over a base-10 alphabet is bounded above by log2(10)
//   ≈ 3.32 bits/char, for a string of ANY length, which is always below this
//   file's 3.6 floor; a digits-only run could only ever have qualified
//   through the hex-blob bypass, never through entropy, so requiring a
//   genuinely hex-alphabet letter closes the gap completely rather than
//   narrowing it by degree.
//
//   F-LOG-F2 (minor) — `SHORT_GIT_SHA_RE` was dead: entropy tops out at
//   log2(N) for a length-N string of all-distinct characters, so nothing
//   under 13 characters can ever reach the 3.6 floor by entropy, and
//   `HEX_BLOB` requires 24+ by shape. A 7–12-character value can therefore
//   never reach `qualifies: true` in the first place, allow-shape or not —
//   removed rather than pinned, since no caller (including the new
//   label-free URL-component path, which has no length floor of its own)
//   can ever make it reachable.
//
// REVIEW ROUND 2 — the coordinator's own probe against REAL urls found two
// more false positives in `containsOutboundSecret` (`harness/web/
// outbound-secret.ts`), both traced back to here:
//
//   - `https://registry.npmjs.org/typescript/-/typescript-5.6.3.tgz` refused:
//     `outbound-secret.ts` evaluated the WHOLE decoded path segment via
//     `looksSecretShaped` directly, bypassing the TOKEN re-tokenisation that
//     already protects the REDACTION path from this exact filename shape
//     (round 1's own fix). Two divergent code paths for the same question is
//     the defect, not just the missed filename.
//   - `https://www.google.com/search?q=bun+test+timeout+flaky` refused AND
//     redacted: `+` is `application/x-www-form-urlencoded`'s space
//     convention, decoded automatically for a query VALUE by
//     `URLSearchParams` — but `detectEntropy`'s OWN URL-component scan reads
//     the RAW, still-`+`-joined query text directly off the url string
//     (`urlComponentSpans`), and `+` sits inside `TOKEN`'s own character
//     class while `isWordSlug` never learned to split on it. A four-word
//     search query was scored as one 23-character, non-slug, entropy-eligible
//     run.
//
// Fixed with ONE shared primitive, `secretShapedCandidatesIn`: `+` is
// swapped for a literal space (length-preserving — both are one character,
// so this is safe even for the offset-sensitive redaction path) and the
// result is re-tokenised with the SAME `TOKEN`/`TOKEN_HEAD`/
// `shapeQualifiesAsSecret` pipeline ordinary prose already gets. Both
// `detectEntropy`'s URL-component pass below and `outbound-secret.ts`'s
// pre-flight check call this ONE function on a component's text — there is
// no second, independent shape decision to drift out of sync with it again.
//
// REVIEW ROUND 2, PASS 2 (flow 355 review round 2 fix package) — four more
// findings, all inside this same shared shape gate:
//
//   SEC-F1 (blocker) — `isWordSlug` exempted a hyphen/underscore run from the
//   entropy gate whenever every segment was PURE alpha, PURE digit, or a
//   single letter-run/digit-run "tag", with no check on the RECONSTITUTED
//   value's own randomness — so a real secret, re-chunked into single-
//   character-class pieces (`aK-9-dQ-2-rN-…`) or wrapped as
//   `log-<scrambled-case letters+digits>-id`, sailed through as a "slug".
//   The gap was that a PURE-alpha segment counted as a legitimate word
//   regardless of its CASING, and `isSingleTransitionTag`'s letter run had no
//   length or casing bound either. Fixed: a segment only counts as a real
//   word if it is plainly cased — all-lowercase, all-uppercase (an acronym),
//   or Capitalised (one leading uppercase letter, the rest lowercase);
//   language never scrambles case letter-by-letter, but a hyphen-chunked
//   secret often does by construction. The same casing rule, plus a short
//   length bound, now applies to a single-transition tag's letter run too, so
//   `cp311`/`x86`/`aarch64` (a handful of characters, plainly cased) still
//   qualify while `abcdefghijklmnopqrstuvwxyzAB1234` (29 scrambled-case
//   letters before its digit run) does not. See `isPlainCasedWord`,
//   `isSingleTransitionTag`, `isWordSlug`.
//
//   REG-F1 (major) — the flip side of the same rule made it TOO strict:
//   Medium's and GitHub Gist's `<slug>-<hex-id>` URL convention ends in a
//   trailing id that interleaves letters and digits many times
//   (`…-actually-fresh-3a9bae9ec8f9`), which fails every segment shape above
//   and poisoned the whole slug, so an entirely ordinary public URL already
//   linked from this repo's own docs was refused. Fixed: `isSlugHexTail`
//   grants the SAME "structured, not random" carve-out to a segment that is
//   the LAST segment of an otherwise-valid word slug and is itself a 10-16
//   character pure-hex run — a public post/gist id, not a secret. Bounded to
//   the final segment only and to that length window so this cannot become a
//   second segmented-secret loophole the way an unbounded carve-out would.
//
//   LOG-F1 (major) — the generic (non-URL) per-line scan still compounded any
//   `/`-bearing run into ONE candidate (a relative doc link, a filesystem
//   path), and `SENSITIVE_LABEL`'s 40-char lookback was same-line PROXIMITY,
//   not true adjacency — any ordinary occurrence of "key"/"password"/"api"/
//   "credential" earlier in the same line/comment was enough to label
//   unrelated text (a "Credential Masking" heading two sentences before an
//   ADR link; "the API." before an unrelated Python assignment; "password" in
//   a sentence before a library-name comment). Fixed: the generic scan now
//   requires `ADJACENT_LABEL` — the label word, its continuation, then only
//   quotes/`:`/`=`/whitespace up to the value — for EVERY match, not only to
//   override an allow-shape; and a `/`-bearing candidate is decomposed into
//   its `/`-delimited pieces and scored piece by piece (`firstQualifyingSlashPiece`),
//   the same decomposition principle a URL's own path segments already get,
//   so a long ordinary path is never flagged on its TOTAL length alone.
//
//   SEC-F2 (major, residual of round 1's F-SEC-F2) — the label-overrides-
//   allow-shape fix was correct, but `bareShapeQualifies`'s OWN entropy floor
//   (3.6 bits, no hex-blob match possible for a hyphenated UUID) ran BEFORE
//   the label was ever consulted, so a labelled UUID's redaction depended on
//   whether its own hex digits happened to repeat enough to clear the floor —
//   the canonical RFC 4122 example UUID (entropy 3.39) did not. Fixed:
//   `labelledPieceQualifies` — reached only once a label is already confirmed
//   adjacent — lets an allow-shape (UUID / full git SHA / npm-yarn integrity
//   string) qualify REGARDLESS of its own entropy. The floor exists to spare
//   UNLABELLED prose from a false positive; that purpose does not apply once
//   a label has already, explicitly, called the value out as leaked.
//
// REVIEW ROUND 3 — pre-existing on `main`, found squarely inside what S-6
// promises: `api_key=kd8Fj2LmQp9xZr4TvWn7Yb3` (a plain, non-URL, LABELLED
// assignment) was not redacted. Two separate gaps, both in how a label is
// recognised, not in the entropy floor itself:
//
//   - `=` sits inside `TOKEN`'s own character class (needed for base64
//     padding: `AB==`), so `api_key=<value>` was captured as ONE 31-character
//     run with the label INSIDE the candidate rather than before it — the
//     label lookback then searched the text BEFORE the whole run, found
//     nothing, and the (otherwise entropy-eligible) value was never
//     separated out. `LABEL: VALUE`/`LABEL:VALUE` never had this problem:
//     `:` is not in `TOKEN`'s class, so the label and the value were already
//     two separate tokens. Fixed by `LABEL_ASSIGNMENT_RE` below, a dedicated
//     pass that finds the assignment directly and evaluates only the VALUE.
//   - `apiKey: "…"` (camelCase) was ALSO missed, for an unrelated reason:
//     the label's boundary check (F-LOG-F1) required a NON-alphanumeric
//     character on both sides of the label word, and camelCase has none
//     between "api" and "Key". Fixed by also accepting a following UPPERCASE
//     letter as a valid trailing boundary.
//
// `token=abcdefghijklmnopqrstuvwx12345678` is DELIBERATELY still missed: its
// value is low-entropy (a near-sequential alphabet-then-digits run), so the
// usual 3.6-bit floor correctly does not fire — the fix is about recognising
// the label, never about lowering the floor a recognised label sits next to.

const SENSITIVE_LABEL_WORDS = "key|secret|token|password|passwd|api|credential|auth|bearer";
// Boundary-aware (F-LOG-F1): a label word must sit at the start/end of the
// text or against a non-alphanumeric character on EITHER side — `api_key`,
// `token=`, `Bearer `, `(api)` all count; a bare concatenation with no
// separator at all ("apiary", "VariablesApi") does not. `_` counts as a
// boundary here though it is a `\w` character in a plain `\b` test — real
// labels are routinely underscore-joined (`api_key`, `auth_token`) and a
// plain `\b` would miss every one of them.
//
// The TRAILING side also accepts a following UPPERCASE letter (review round
// 3): `apiKey: "…"` has no non-alphanumeric character between "api" and
// "Key" at all — camelCase has no separator character, only a case change.
// `PipelineVariablesApi` (the reported false positive this boundary check
// itself was built to fix) is unaffected: that "Api" sits at the LEADING
// side against an alphanumeric character ("s" of "Variables"), which this
// change does not touch.
//
// The words are matched case-insensitively by spelling each letter as a
// two-case class instead of using the `i` flag: under `i` the camelCase
// lookahead `(?=[A-Z])` matches a lowercase letter too, so "keyv" and
// "visitor-keys" (every bun.lock/package-lock line naming those packages)
// counted as a `key` label and their public `sha512-…` integrity strings
// were redacted.
const caseless = (words: string): string =>
  words.replace(/[a-z]/g, (ch) => `[${ch}${ch.toUpperCase()}]`);

// A label that ENDS the text before a value: the label word, an optional
// continuation (`_KEY`, `Key`), then only quotes, `:`/`=` and whitespace.
//
// LOG-F1 (review round 2): this used to gate only whether a label could
// override an allow-shape; a SEPARATE, merely-proximate check
// (`SENSITIVE_LABEL`, same-line, 40 characters back) was enough to label
// anything else. That proximity check is gone — the per-line scan in
// `detectEntropy` now requires THIS adjacency check for every match, not
// just an allow-shape override. A same-line window was far too permissive
// once real prose/comments are the input rather than a config line: a
// "Credential Masking" heading two sentences before an unrelated relative
// doc link, a GitHub noreply email's local part near an unrelated "key", a
// Python `from_attributes=True` assignment near "the API.", a
// `passlib/bcrypt/argon2` library-name comment near "password" — none of
// those labels are ADJACENT to the value they used to tag.
const ADJACENT_LABEL = new RegExp(
  `(?:^|[^A-Za-z0-9])(?:${caseless(SENSITIVE_LABEL_WORDS)})[A-Za-z0-9_-]*["']?\\s*[:=]?\\s*["']?$`,
);

// LABEL=VALUE assignment shapes (review round 3): `=` sits inside `TOKEN`'s
// own character class (needed for base64 padding), so `api_key=<value>` was
// captured as ONE run with the label INSIDE it rather than before it — see
// this file's header. `LABEL: VALUE`/`LABEL:VALUE` never had this problem
// (`:` is not in `TOKEN`'s class) and needs no separate handling here. This
// finds the assignment directly and captures only the VALUE; the label is
// satisfied by construction, so the caller applies `bareShapeQualifies` (no
// allow-shape exemption — F-SEC-F2) with the usual entropy floor. The
// optional `[A-Za-z0-9_-]*` after the label word absorbs a continuation
// (`_KEY` from `API_KEY`, `Key` from `apiKey`) up to the connector; an
// optional quote on either side of `=` covers a JSON-ish `"api_key"= "…"`
// oddity for free, though the common JSON shape (`"api_key": "…"`) already
// works through `:` and the generic scan.
const LABEL_ASSIGNMENT_RE = new RegExp(
  `(?:^|[^A-Za-z0-9])(?:${SENSITIVE_LABEL_WORDS})[A-Za-z0-9_-]*"?\\s*=\\s*"?([A-Za-z0-9+/_=-]{6,})`,
  "gi",
);
// A credential head (20+ token characters) plus any `.`-joined continuation
// segments. `.` is NOT part of the head class: a dotted composite credential
// (`<32 hex>.<16 alnum>`, the Z.AI shape; also the JWT shape) used to be seen as
// two unrelated tokens, so only the first half was ever masked and a tail below
// the 20-character floor was never even a candidate. Half a redacted key is a
// disclosed key. Continuation segments need 6+ characters so an ordinary file
// extension or method call cannot extend a span.
const TOKEN = /[A-Za-z0-9+/=_-]{20,}(?:\.[A-Za-z0-9+/=_-]{6,})*/g;
const TOKEN_HEAD = /^[A-Za-z0-9+/=_-]+/;
const LABEL_WINDOW = 40;
// A long pure-hex blob is a credential alphabet, not prose. 32 hex characters
// carry ~3.7 bits of Shannon entropy, which sits barely above the 3.6 floor
// below — so whether a given real key is redacted comes down to how its own
// digits happen to repeat. Shape decides this case instead of luck; the
// sensitive-label requirement is unchanged, so a bare SHA in ordinary output is
// still not a secret.
const HEX_BLOB = /^[0-9a-f]{24,}$/i;

/** F-REG-F3: hex-blob shape, but never for a digits-only run (see header). */
function isHexBlob(value: string): boolean {
  return HEX_BLOB.test(value) && /[a-f]/i.test(value);
}

// Allow-shapes (S-6 / flow 355 AC2): value SHAPES that must never be treated as
// a secret PROVIDED no explicit label overrides them (F-SEC-F2; see header).
// Checked on the candidate before the entropy gate, so `redactSensitiveText`
// calling this detector on every tool output (S-6) never masks an UNLABELLED
// git commit SHA, UUID, or npm/yarn integrity string — all three are printed
// constantly by ordinary `git`/`bun`/`npm` output this redactor now sees for
// the first time. `SHORT_GIT_SHA_RE` removed — see header, F-LOG-F2.
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGRITY_RE = /^(?:sha256|sha512)-[A-Za-z0-9+/]+=*$/;

function isAllowShapedValue(value: string): boolean {
  return FULL_GIT_SHA_RE.test(value) || UUID_RE.test(value) || INTEGRITY_RE.test(value);
}

// Only the text after the last newline — the label window must never reach into
// a neighbouring line.
function lastLineOf(before: string): string {
  const newline = before.lastIndexOf("\n");
  return newline < 0 ? before : before.slice(newline + 1);
}

// True for `word-word-word` / `word_word_word` slugs, e.g.
// `ADR-0008-interactive-shell-delegate-risk-gate` or `108-security-eval-corpus`.
// Every `-`/`_` segment must be pure (all letters, all digits, or a SINGLE
// letters-then-digits or digits-then-letters tag — see below) and at least
// two must be alphabetic words of 3+ characters. A UUID (`550e8400-e29b-…`)
// or a prefixed token (`ghp_1234abcdEF…`) has MULTI-transition mixed segments
// (letter-digit-letter-digit…) and is therefore still NOT a slug, so real
// credentials keep flowing through this gate.
//
// A "plainly cased" letter run — all-lowercase, all-uppercase (an acronym
// like `ADR`), or Capitalised (one leading uppercase letter, the rest
// lowercase). Real language never hops between cases letter-by-letter; a
// secret re-chunked into hyphen-joined pieces (SEC-F1:
// `aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8`) routinely does. This is the
// gate that decides whether an alpha segment (or a single-transition tag's
// letter run) counts as a real word at all.
function isPlainCasedWord(letters: string): boolean {
  return /^[a-z]+$/.test(letters) || /^[A-Z]+$/.test(letters) || /^[A-Z][a-z]*$/.test(letters);
}

// A real platform/version tag's letter run is a handful of characters
// (`cp`, `x86`, `aarch64`, `win32`) — bounding it stops a scrambled-case
// secret chunk from posing as a "tag" merely by transitioning from a letter
// run to a digit run once (SEC-F1's `log-<29 scrambled-case letters><digits>-id`
// variant: technically single-transition, but nothing like a real tag).
const TAG_MAX_LETTER_RUN = 8;

// The single-transition tag shape (flow 355 review round 2): a package
// manager filename's platform/version tags — `cp311`, `x86`, `manylinux_2_17`
// — are exactly as non-random as a pure word or a pure number, but the
// original rule rejected the WHOLE slug over one such segment
// (`numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.whl`, a false positive a
// `pip`/`uv` install produces constantly). A segment that transitions AT MOST
// once between a letter-run and a digit-run either direction, with a SHORT,
// plainly-cased letter run, is the same kind of "structured, not random"
// evidence a pure segment is; a segment that alternates more than once
// (`A1b2C3d4E5f6`), or whose letter run is long or scrambled-case
// (`abcdefghijklmnopqrstuvwxyzAB1234`, SEC-F1 round 2), still is not, and
// still poisons the whole check — `entropy.test.ts`'s own hyphenated-token
// test pins that a genuinely mixed segment stays flagged.
function isSingleTransitionTag(segment: string): boolean {
  const letterThenDigit = /^([A-Za-z]+)([0-9]+)$/.exec(segment);
  if (letterThenDigit !== null) {
    const letters = letterThenDigit[1] as string;
    return letters.length <= TAG_MAX_LETTER_RUN && isPlainCasedWord(letters);
  }
  const digitThenLetter = /^([0-9]+)([A-Za-z]+)$/.exec(segment);
  if (digitThenLetter !== null) {
    const letters = digitThenLetter[2] as string;
    return letters.length <= TAG_MAX_LETTER_RUN && isPlainCasedWord(letters);
  }
  return false;
}

// REG-F1: Medium's and GitHub Gist's common `<slug>-<hex-id>` URL convention
// — a public post/gist id, not a secret, but one that interleaves letters and
// digits many times (`3a9bae9ec8f9`) and so fails every other segment shape.
// Bounded to 10-16 hex characters AND to the slug's LAST segment only — never
// a mid-slug segment — so this cannot become a second segmented-secret
// loophole the way an unbounded "any hex-ish segment is fine" rule would.
const SLUG_HEX_TAIL_RE = /^[0-9a-f]{10,16}$/i;
function isSlugHexTail(segment: string): boolean {
  return SLUG_HEX_TAIL_RE.test(segment);
}

function isWordSlug(value: string): boolean {
  const segments = value.split(/[-_]/);
  if (segments.length < 3) {
    return false;
  }
  let words = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    const isDigits = /^[0-9]+$/.test(segment);
    if (isDigits) {
      continue;
    }
    if (isPlainCasedWord(segment)) {
      if (segment.length >= 3) {
        words += 1;
      }
      continue;
    }
    if (isSingleTransitionTag(segment)) {
      continue;
    }
    if (i === segments.length - 1 && isSlugHexTail(segment)) {
      continue;
    }
    return false;
  }
  return words >= 1;
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

/**
 * The bare shape decision — digit gate, word-slug exclusion, then
 * hex-blob-or-entropy-floor. Deliberately carries NO allow-shape exemption:
 * whether an allow-shape should exempt a value depends on context a caller
 * decides (F-SEC-F2) — the per-line scan below never exempts once a label is
 * present, and would never reach this function at all without one.
 */
function bareShapeQualifies(head: string): { qualifies: boolean; entropy: number } {
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
  if (!/[0-9]/.test(head) && !/[+=]/.test(head)) {
    return { qualifies: false, entropy: 0 };
  }
  // Hyphen/underscore-delimited word slugs — ADR filenames, flow directories,
  // kebab-case identifiers — are never credentials, even though a version-like
  // digit segment satisfies the shape gate above.
  if (isWordSlug(head)) {
    return { qualifies: false, entropy: 0 };
  }
  const entropy = shannonEntropy(head);
  const hexBlob = isHexBlob(head);
  if (entropy < 3.6 && !hexBlob) {
    return { qualifies: false, entropy };
  }
  return { qualifies: true, entropy };
}

/** `bareShapeQualifies` plus the allow-shape exemption, for LABEL-FREE callers. */
function shapeQualifiesAsSecret(value: string): { qualifies: boolean; entropy: number } {
  if (isAllowShapedValue(value)) {
    return { qualifies: false, entropy: 0 };
  }
  return bareShapeQualifies(value);
}

/**
 * True when `value` looks like a credential by SHAPE alone — allow-shapes,
 * identifier/slug, and hex-blob-or-entropy, with no sensitive-label
 * requirement. For a caller whose CONTEXT already is the label (a URL path
 * segment or query value; `displayUrl`, S-9; the URL-component scan below,
 * F-LOG-F1): matched against the whole (decoded) value, not a TOKEN regex
 * head, since the caller has already isolated the candidate.
 */
export function looksSecretShaped(value: string): boolean {
  return shapeQualifiesAsSecret(value).qualifies;
}

function buildMatch(start: number, end: number, value: string, entropy: number): DetectorMatch {
  // Map entropy 3.6..5.0 into confidence 0.4..0.7. A hex blob that only
  // qualified on shape keeps the band's floor rather than a negative score.
  const confidence = Math.max(0.4, Math.min(0.7, 0.4 + (entropy - 3.6) * 0.21));
  return {
    category: "secret",
    policyId: "secrets.high-entropy",
    severity: "medium",
    confidence: Number(confidence.toFixed(2)),
    start,
    end,
    value,
    // Its own mask (flow 355, S-6/AC2), not "secret": `redactSensitiveText`
    // now runs this detector on every tool output, and `[REDACTED:entropy]`
    // tells the model (and a human reading a transcript) that the value was
    // never matched to a NAMED credential shape — it was only high-entropy
    // near a sensitive word, which is a weaker, sometimes-wrong signal.
    mask: "entropy",
    remediation: "Verify this high-entropy value is not a live credential.",
  };
}

// ---------------------------------------------------------------------------
// URL decomposition (F-LOG-F1). A URL is found, then split into PATH
// SEGMENTS, QUERY VALUES and FRAGMENT — never scanned as one joined run — and
// each is evaluated label-free (`shapeQualifiesAsSecret`), exactly the way
// `looksSecretShaped` already treats a path segment for `displayUrl` (S-9).
// ---------------------------------------------------------------------------

const URL_SPAN_RE = /\bhttps?:\/\/[^\s<>"'\\]+/g;
/** Trailing characters a permissive URL match over-grabs from surrounding prose. */
const URL_TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}]$/;
/** Below this, nothing can reach the 3.6-bit entropy floor (see header) — same
 * floor the generic TOKEN scan already applies via its own 20-char minimum. */
const URL_COMPONENT_MIN_LENGTH = 20;

function findUrlSpans(content: string): Array<{ start: number; end: number; raw: string }> {
  const spans: Array<{ start: number; end: number; raw: string }> = [];
  URL_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_SPAN_RE.exec(content)) !== null) {
    let raw = m[0];
    while (raw.length > 0 && URL_TRAILING_PUNCTUATION_RE.test(raw)) {
      raw = raw.slice(0, -1);
    }
    if (raw.length > 0) {
      spans.push({ start: m.index, end: m.index + raw.length, raw });
    }
    if (m.index === URL_SPAN_RE.lastIndex) {
      URL_SPAN_RE.lastIndex += 1;
    }
  }
  return spans;
}

/** Component spans (path segment / query value / fragment) RELATIVE to `raw`'s own start. */
function urlComponentSpans(raw: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(raw);
  if (schemeMatch === null) {
    return spans;
  }
  let i = schemeMatch[0].length;
  // Authority (host[:port]): skip to the first of `/ ? #`, never a candidate
  // itself — a hostname label is not evaluated as a secret by this scan.
  while (i < raw.length && raw[i] !== "/" && raw[i] !== "?" && raw[i] !== "#") {
    i += 1;
  }
  let pathEnd = i;
  while (pathEnd < raw.length && raw[pathEnd] !== "?" && raw[pathEnd] !== "#") {
    pathEnd += 1;
  }
  let segStart = i;
  for (let j = i; j <= pathEnd; j += 1) {
    if (j === pathEnd || raw[j] === "/") {
      if (j > segStart) {
        spans.push({ start: segStart, end: j });
      }
      segStart = j + 1;
    }
  }
  let cursor = pathEnd;
  if (cursor < raw.length && raw[cursor] === "?") {
    let queryEnd = cursor + 1;
    while (queryEnd < raw.length && raw[queryEnd] !== "#") {
      queryEnd += 1;
    }
    let pairStart = cursor + 1;
    for (let j = cursor + 1; j <= queryEnd; j += 1) {
      if (j === queryEnd || raw[j] === "&") {
        const pair = raw.slice(pairStart, j);
        const eq = pair.indexOf("=");
        if (eq !== -1 && eq + 1 < pair.length) {
          spans.push({ start: pairStart + eq + 1, end: j });
        } else if (eq === -1 && pair.length > 0) {
          // A valueless param — the whole pair is the only candidate there is.
          spans.push({ start: pairStart, end: j });
        }
        pairStart = j + 1;
      }
    }
    cursor = queryEnd;
  }
  if (cursor < raw.length && raw[cursor] === "#" && cursor + 1 < raw.length) {
    spans.push({ start: cursor + 1, end: raw.length });
  }
  return spans;
}

export interface SecretShapedCandidate {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly entropy: number;
}

/**
 * Every secret-shaped candidate inside `text` — ONE decomposed URL component
 * (a path segment, a query value, or the fragment; never a whole URL) — found
 * by re-tokenising it exactly the way ordinary prose already is: `TOKEN`,
 * `TOKEN_HEAD`, then the label-free, allow-shape-exempting
 * `shapeQualifiesAsSecret`.
 *
 * `+` is swapped for a literal space first (review round 2, F-LOG-F1
 * follow-up): it is `application/x-www-form-urlencoded`'s space convention —
 * `URLSearchParams` already decodes it for a query VALUE, but nothing decodes
 * it for a path segment or fragment, and `TOKEN`'s own character class
 * includes it while `isWordSlug` never learned to split on it. A `+`-joined
 * multi-word search query (`bun+test+timeout+flaky`, literally what
 * `web_search` sends) was one 20+-character non-slug run before this. The
 * swap is length-preserving — `+` and ` ` are both one character — so
 * `start`/`end` stay valid offsets into the UNMODIFIED `text`, which is what
 * `detectEntropy`'s redaction pass needs; `value` is read back from the
 * original `text`, never the space-swapped copy, so a reported match still
 * shows the real `+` characters rather than a synthetic space.
 *
 * The ONE place both `detectEntropy`'s URL-component pass and
 * `outbound-secret.ts`'s pre-flight check decide whether a component looks
 * like a secret — see this file's header for the bug two divergent answers
 * to the same question caused.
 */
export function secretShapedCandidatesIn(text: string): SecretShapedCandidate[] {
  const normalized = text.replace(/\+/g, " ");
  const out: SecretShapedCandidate[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(normalized)) !== null) {
    const value = m[0];
    if (value.length < URL_COMPONENT_MIN_LENGTH) {
      continue;
    }
    const head = TOKEN_HEAD.exec(value)?.[0] ?? value;
    const { qualifies, entropy } = shapeQualifiesAsSecret(head);
    if (!qualifies) {
      continue;
    }
    const start = m.index;
    const end = start + value.length;
    out.push({ start, end, value: text.slice(start, end), entropy });
  }
  return out;
}

/** True when ANY candidate in `text` (see `secretShapedCandidatesIn`) looks secret-shaped. */
export function looksSecretShapedIn(text: string): boolean {
  return secretShapedCandidatesIn(text).length > 0;
}

// ---------------------------------------------------------------------------
// The generic (non-URL, non-LABEL=VALUE) per-line scan's own shape decision
// (LOG-F1, SEC-F2 — see this file's header). Reached ONLY once a label has
// already been confirmed ADJACENT to the candidate, never on proximity alone.
// ---------------------------------------------------------------------------

/**
 * SEC-F2: once a label is adjacent, an allow-shape (UUID / full git SHA /
 * npm-yarn integrity string) qualifies regardless of its OWN entropy — the
 * 3.6-bit floor exists to spare UNLABELLED prose from a false positive, which
 * does not apply once a label has already called the value out as leaked.
 */
function labelledPieceQualifies(piece: string): { entropy: number } | null {
  const base = bareShapeQualifies(piece);
  if (base.qualifies) {
    return { entropy: base.entropy };
  }
  if (isAllowShapedValue(piece)) {
    return { entropy: base.entropy };
  }
  return null;
}

interface SlashPieceMatch {
  readonly offset: number;
  readonly length: number;
  readonly entropy: number;
}

/**
 * LOG-F1: a `/`-joined compound (a relative doc link, a filesystem path) is
 * decomposed into its `/`-delimited pieces and scored piece by piece — the
 * same decomposition principle a URL's own path segments already get (see
 * `urlComponentSpans`) — so a long ordinary path is never flagged purely
 * because its TOTAL length crosses the entropy floor; only a PIECE that is
 * itself secret-shaped narrows the eventual match down to itself.
 */
function firstQualifyingSlashPiece(head: string): SlashPieceMatch | null {
  let offset = 0;
  for (const piece of head.split("/")) {
    if (piece.length > 0) {
      const found = labelledPieceQualifies(piece);
      if (found !== null) {
        return { offset, length: piece.length, entropy: found.entropy };
      }
    }
    offset += piece.length + 1; // +1 for the '/' separator itself.
  }
  return null;
}

export function detectEntropy(content: string): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  const urlSpans = findUrlSpans(content);

  // Each URL component is re-scanned with `secretShapedCandidatesIn` — never
  // decoded beyond `+`→space (see that function's own comment for why:
  // offsets into `content` must stay valid), and never evaluated as one
  // whole segment. `outbound-secret.ts`'s pre-flight check calls the SAME
  // function (review round 2) so the two surfaces cannot answer differently
  // for the same bytes again.
  for (const url of urlSpans) {
    for (const comp of urlComponentSpans(url.raw)) {
      const compText = url.raw.slice(comp.start, comp.end);
      for (const cand of secretShapedCandidatesIn(compText)) {
        const absStart = url.start + comp.start + cand.start;
        const absEnd = url.start + comp.start + cand.end;
        matches.push(buildMatch(absStart, absEnd, cand.value, cand.entropy));
      }
    }
  }

  // LABEL=VALUE assignments (review round 3) — see `LABEL_ASSIGNMENT_RE`'s own
  // comment. Skipped inside a URL span: a query's `key=value` pair is already
  // handled, label-free, by the component pass above.
  LABEL_ASSIGNMENT_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = LABEL_ASSIGNMENT_RE.exec(content)) !== null) {
    const value = am[1] as string;
    // The capture group is the LAST thing the pattern matches, so its end
    // coincides exactly with the whole match's end — no separate index
    // tracking (e.g. a `d`-flag `exec`) needed to locate it.
    const end = am.index + am[0].length;
    const start = end - value.length;
    if (urlSpans.some((u) => start < u.end && end > u.start)) {
      continue;
    }
    const { qualifies, entropy } = bareShapeQualifies(value);
    if (qualifies) {
      matches.push(buildMatch(start, end, value, entropy));
    }
  }

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(content)) !== null) {
    const value = m[0];
    const start = m.index;
    const end = start + value.length;
    // Already handled above, component-by-component, inside a URL (F-LOG-F1)
    // — skip so the JOINED run is never scored here too.
    if (urlSpans.some((u) => start < u.end && end > u.start)) {
      continue;
    }
    // Already handled above by `LABEL_ASSIGNMENT_RE` when this run is a
    // `LABEL=VALUE` fusion (the whole run failed its OWN label lookback —
    // nothing precedes it — so it would otherwise silently drop through).
    if (matches.some((existing) => start < existing.end && end > existing.start)) {
      continue;
    }
    // LOG-F1: the label must be genuinely ADJACENT — the label word, its
    // continuation, then only quotes/`:`/`=`/whitespace before the value —
    // checked BEFORE shape now, for two reasons. First, proximity anywhere in
    // the 40-char window no longer labels ANYTHING (a same-line window was far
    // too permissive once real prose/comments are the input, not a config
    // line: a "Credential Masking" heading two sentences before an unrelated
    // relative doc link, a noreply email's local part near an unrelated
    // "key", a Python assignment near "the API.", a library-name comment near
    // "password"). Second, SEC-F2 needs to know a label is already present
    // before deciding whether an allow-shape should be overridden — the
    // label look-back is bounded to the CURRENT LINE, unchanged from before:
    // it used to run over raw offsets, so a "credential"/"key" word on the
    // PREVIOUS line labelled this line's token.
    const before = lastLineOf(content.slice(Math.max(0, start - LABEL_WINDOW), start));
    if (!ADJACENT_LABEL.test(before)) {
      continue;
    }
    // Every gate below judges the HEAD segment — the part that qualified as a
    // credential candidate on its own. A dotted tail rides along into the masked
    // span but never earns the match, so `identifier.someMethodName` cannot pass
    // a gate its head would fail.
    const head = TOKEN_HEAD.exec(value)?.[0] ?? value;
    if (head.includes("/")) {
      const piece = firstQualifyingSlashPiece(head);
      if (piece === null) {
        continue;
      }
      const pieceStart = start + piece.offset;
      const pieceEnd = pieceStart + piece.length;
      matches.push(buildMatch(pieceStart, pieceEnd, content.slice(pieceStart, pieceEnd), piece.entropy));
      continue;
    }
    const found = labelledPieceQualifies(head);
    if (found === null) {
      continue;
    }
    matches.push(buildMatch(start, end, value, found.entropy));
  }
  return matches.sort((a, b) => a.start - b.start);
}
