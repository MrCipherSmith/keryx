// Flow 358 — the model-id VERSION helpers, moved out of
// `src/harness/routing/derive-default-table.ts` so the tier resolution in
// `./model-tier.ts` can order GENERATIONS within one family without an import
// cycle (`derive-default-table` and `model-profile` both import `model-tier`;
// `model-tier` importing back from either would close the loop). This file is
// PURE and imports nothing, so anything may depend on it.
//
// Flow 327 (Routing A2), AC10 wrote these rules — see the comments on each
// helper. They are unchanged by the move; `derive-default-table.ts` re-exports
// `familyKey`/`parseModelVersion` so its own tests and callers keep working.
//
// Conservative by construction (item 2, rewritten round 2: real Anthropic ids
// are HYPHENATED — `claude-opus-4-8`, `claude-haiku-4-5` — never dotted). A
// short RUN of adjacent hyphenated digit tokens is read as one dotted version
// group, while a date/snapshot stamp, a parameter-size marker (`7b`) and more
// than one numeric run in the same id are all refused rather than guessed.

/** A token that already carries its own dot(s) — a complete, self-contained decimal version by itself (`5.5`, `3.8`), never merged with a neighbouring token. */
const DOTTED_VERSION_TOKEN = /^\d+\.\d+(?:\.\d+)*$/;

/** A token that is purely digits, no dot — either a whole version by itself (`6` in `gpt-6`) or one segment of a hyphenated multi-segment version (`4`, `8` in `claude-opus-4-8`); which one depends on what is adjacent to it (see `findVersionGroups`). */
const BARE_DIGITS_TOKEN = /^\d+$/;

/** 1-2 digits — the shape every real hyphenated version SEGMENT takes (`4`, `8`, `5`, `1`). A run of adjacent tokens only merges into a dotted version when every token in it is this shape. */
const SHORT_DIGITS_TOKEN = /^\d{1,2}$/;

/** 6-8 bare digits — a date/snapshot stamp (`20250514`), not a version, even though it also matches `BARE_DIGITS_TOKEN`. Always refused, whether it stands alone or (already impossible, since it is never "short") inside a run. */
const DATE_LIKE_TOKEN = /^\d{6,8}$/;

/**
 * A short numeric token immediately followed by the letter `o` (`4o` in
 * `gpt-4o`) — a vendor "numbered variant" id shape distinct from a dotted
 * version (`gpt-4.1`). The digits parse as the version; the trailing letter
 * is a variant TAG, deliberately excluded from the comparison (operator
 * decision, round 2: `gpt-4o` and `gpt-4.1` land in the same family —
 * `familyKey` strips this token too — with `gpt-4o` comparing as version
 * `4`, so `gpt-4.1` correctly outranks it and, symmetrically, `gpt-4o` can
 * never look newer than a real `gpt-5`-family id than it should). Chosen
 * over refusing the comparison outright because a real, if approximate,
 * ordering is more useful than "these two can never be compared" for ids
 * that differ only in this suffix.
 *
 * Restricted to the letter `o` ONLY (round 3, HIGH regression fix): the
 * original `[a-z]` shape also matched a parameter-size marker — `7b` in
 * `qwen2.5-coder-7b`, `32b`, `70b`, `34b` — and misread the size as a
 * version, which both (a) let `familyKey` merge `qwen2.5-coder-7b` and
 * `qwen2.5-coder-32b` into ONE family and then (b) compared `7` against
 * `32` as if they were version numbers, ranking the 7B model "newer" than
 * the 32B one. `o` is the only letter any real vendor id uses this way
 * (OpenAI's `4o`); every other trailing letter after a short digit run is a
 * size suffix, never a version variant.
 */
const LETTER_VARIANT_TOKEN = /^(\d{1,2})(o)$/;

/**
 * A parameter-size marker (`7b`, `70b`, `1.5b`, `8x7b` — a total or MoE
 * "N experts x M billion" param count) — round 3: ALWAYS a SIZE marker,
 * NEVER a version, and always KEPT in `familyKey` (never stripped), so
 * `qwen2.5-coder-7b`/`qwen2.5-coder-32b` and `llama-3.3-70b`/`llama-3.3-8b`
 * key to different families and are never version-compared against each
 * other. Checked FIRST in `looksLikeVersionPiece`, ahead of any
 * version-piece pattern, so a future broadening of those patterns (e.g. a
 * wider `LETTER_VARIANT_TOKEN`) cannot silently re-swallow a size token.
 */
const SIZE_TOKEN = /^\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?[bmk]$/;

/** True for any token `familyKey` must strip to compare two ids' non-version parts — every shape `findVersionGroups` recognises as "numeric-ish", regardless of whether the id AS A WHOLE ends up with a parseable version (family grouping only needs "is this a number", not "which number is the version"). A `SIZE_TOKEN` is checked first and always returns `false` — it is never a version piece, whatever else it might coincidentally match. */
function looksLikeVersionPiece(token: string): boolean {
  if (SIZE_TOKEN.test(token)) return false;
  return DOTTED_VERSION_TOKEN.test(token) || BARE_DIGITS_TOKEN.test(token) || LETTER_VARIANT_TOKEN.test(token);
}

/** Split a model id into lower-cased tokens on any run of characters that are not `[a-z0-9.]` — a dotted version stays ONE token (`5.5`), a hyphen/slash/underscore/colon is a boundary (so `claude-opus-4-8` yields the two ADJACENT tokens `4`, `8`, not one). */
function tokenize(modelId: string): string[] {
  return modelId
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 0);
}

/** A trailing "alias" word some vendors append to mean "whatever the current pointer resolves to" (`claude-3-7-sonnet-latest`) or "not yet stable" (`gpt-4o-audio-preview`) — never a version or a size, and stripped from `familyKey` ONLY (never from the id itself, so the id stays exact for lookups/display) so `claude-3-7-sonnet-latest` joins the same family as `claude-sonnet-5` (round 3, optional/cheap per the review). Stripped only when it is the LAST token and at least one token remains after — never leaves `familyKey` empty. */
const TRAILING_ALIAS_WORDS: ReadonlySet<string> = new Set(["latest", "preview"]);

/**
 * The id with its version token(s) removed, joined back — "same family and
 * vendor" for the version tie-break. `claude-opus-5.5` and `claude-opus-4.7`
 * both key to `claude-opus`; `gemini-3.8-flash` and `gemini-3.1-flash` both
 * key to `gemini-flash`; `claude-opus-4-8` (hyphenated) ALSO keys to
 * `claude-opus` now, and `gpt-4o`/`gpt-4.1` both key to `gpt`. A parameter
 * SIZE token (`7b`, `70b`, `1.5b`, `8x7b`) is never a version piece and is
 * always KEPT, so `qwen2.5-coder-7b` and `qwen2.5-coder-32b` key to
 * DIFFERENT families (`SIZE_TOKEN`, round 3).
 */
export function familyKey(modelId: string): string {
  const tokens = tokenize(modelId).filter((t) => !looksLikeVersionPiece(t));
  const last = tokens.at(-1);
  const trimmed = tokens.length > 1 && last !== undefined && TRAILING_ALIAS_WORDS.has(last) ? tokens.slice(0, -1) : tokens;
  return trimmed.join("-");
}

/** One maximal run of adjacent tokens this parser treats as belonging to a single version, plus the token(s) it comprises. */
interface VersionGroup {
  readonly startIndex: number;
  readonly tokens: readonly string[];
}

/**
 * Every maximal run of adjacent "numeric-ish" tokens in `tokens`, in order —
 * NOT yet validated/parsed, just grouped. A dotted token (`5.5`) or a
 * letter-variant token (`4o`) is always its own one-token group (it never
 * merges with a numeric neighbour — that combination does not occur in any
 * real id this parser targets). Adjacent BARE digit tokens (`4`, `8`) merge
 * into one group, which is what makes a hyphenated version parseable at all.
 */
function findVersionGroups(tokens: readonly string[]): VersionGroup[] {
  const groups: VersionGroup[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (DOTTED_VERSION_TOKEN.test(token) || LETTER_VARIANT_TOKEN.test(token)) {
      groups.push({ startIndex: i, tokens: [token] });
      i += 1;
      continue;
    }
    if (BARE_DIGITS_TOKEN.test(token)) {
      let end = i + 1;
      while (end < tokens.length && BARE_DIGITS_TOKEN.test(tokens[end]!) && !DOTTED_VERSION_TOKEN.test(tokens[end]!)) {
        end += 1;
      }
      groups.push({ startIndex: i, tokens: tokens.slice(i, end) });
      i = end;
      continue;
    }
    i += 1;
  }
  return groups;
}

/**
 * The version number a single (already-isolated) group parses to, or
 * `undefined` when its shape is not one this parser trusts — conservative by
 * construction (item 2: "if an id has no parseable version, do not guess").
 *
 *  - One token, dotted (`5.5`) or bare (`6`) — `Number(token)`, refused if
 *    somehow not finite (e.g. a `5.5.2`-shaped single token — `Number`
 *    rejects the extra dot).
 *  - One token, bare AND date-like (`20250514`, 6-8 digits) — refused
 *    outright; a date is not a version even though it is also all digits.
 *  - One token, letter-variant (`4o`) — the digits alone (`4`); the letter
 *    is a variant tag, never part of the number (see `LETTER_VARIANT_TOKEN`).
 *  - Two or three tokens, EVERY one of them short (1-2 digits, no dot) — a
 *    hyphenated version (`4-8` -> `4.8`, `4-8-2` -> `4.8`, the third segment
 *    contributing no further precision this comparator needs). Joined with
 *    `.` and read with `parseFloat` rather than `Number` for exactly this
 *    reason: `Number("4.8.2")` is `NaN`, `parseFloat("4.8.2")` is `4.8`.
 *  - Anything else (more than 3 tokens in the run, or a run mixing a
 *    long/date-like token with short ones) — refused; not a recognised
 *    version shape.
 */
function parseVersionGroup(group: VersionGroup): number | undefined {
  const { tokens } = group;
  if (tokens.length === 1) {
    const [token] = tokens;
    if (DATE_LIKE_TOKEN.test(token!)) return undefined;
    const letterVariant = LETTER_VARIANT_TOKEN.exec(token!);
    const numeric = letterVariant !== null ? letterVariant[1]! : token!;
    const value = Number(numeric);
    return Number.isFinite(value) ? value : undefined;
  }
  if (tokens.length === 2 || tokens.length === 3) {
    if (!tokens.every((t) => SHORT_DIGITS_TOKEN.test(t))) return undefined;
    const value = Number.parseFloat(tokens.join("."));
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

/**
 * The id's version number, or `undefined` when none is parseable — zero
 * version groups (no version present) or MORE than one (ambiguous — two
 * separate numeric runs elsewhere in the id) both yield `undefined` rather
 * than a guess, same as a single group whose own shape `parseVersionGroup`
 * does not trust (a date-like token, or a run longer than 3).
 */
export function parseModelVersion(modelId: string): number | undefined {
  const groups = findVersionGroups(tokenize(modelId));
  if (groups.length !== 1) return undefined;
  return parseVersionGroup(groups[0]!);
}
