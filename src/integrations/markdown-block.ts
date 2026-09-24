// Flow 307 (W5-b), T5: the ONE managed-markdown-block implementation every
// new `instructions` surface (gemini-cli's GEMINI.md, kiro's steering file,
// github-copilot-agent's copilot-instructions.md) is built from — mirroring
// how `settings-json.ts` is the one JSON walker every JSON surface shares.
//
// The block is a SHORT pointer, distinct from (and using a different marker
// than) `src/lib/agent-entrypoint-blocks.ts`'s `renderProjectMetaprojectReferenceBlock`
// (marker `<!-- keryx:index -->`), which writes the full Metaproject bootstrap
// into AGENTS.md/CLAUDE.md. That block is long by design — it is the primary
// entrypoint file's own routing table. This one is a one-paragraph nudge
// written into a SECONDARY instructions file a new, experimental harness may
// or may not actually read, so the two deliberately share phrasing (the hard
// gate on `.metaproject/index.md`, routing code search through
// `keryx ctx rg`) rather than a second invented wording, without duplicating
// the whole bootstrap block verbatim into a file this workstream cannot
// confirm any harness reads end-to-end.
//
// Review round 3 re-plan: rounds 1 and 2 kept this byte-exact by growing a
// second bookkeeping layer on top of the markers — a `CREATED_FILE_MARKER`
// sentinel to remember whether install itself created the file, plus
// front-matter-aware prefix detection — and round 3 still found edge cases
// (CRLF-converted created files, orphaned markers after a user edit, user
// front matter identical to Keryx's own). That growth is the bug, not any
// one edge case in it: this rewrite drops the second layer entirely for a
// SIMPLER, purely content-based contract —
//   - install into an ABSENT file creates it (front matter, kiro only, then
//     the block; LF).
//   - install into an EXISTING file never adds front matter (even one
//     Keryx itself previously created and the user then emptied back out) —
//     it only ever touches the block itself.
//   - uninstall removes every block plus (at most) the one blank separator
//     line immediately before each, then deletes the file iff what remains
//     is empty/whitespace-only OR equals Keryx's own front matter exactly
//     (compared CRLF-normalised, trailing-whitespace-trimmed) — never by
//     asking "did install create this file", only by looking at what is
//     left.
// Documented normalisation this trades for the simplicity: install -> then
// -> uninstall on an existing file is byte-identical when the file ended
// with a newline (the common case); a file that lacked a final newline may
// gain one, and a pre-existing EMPTY (or whitespace-only) file that install
// wrote the block into is removed on uninstall along with it — there is no
// way to tell "this was empty before" from "install created this" without
// the marker this rewrite deliberately removes. See `docs/docs/integrations.md`.
//
// Review round 2 (N4, kept): every splice below operates on the file's RAW
// bytes directly — never a normalised-then-reapplied copy — so a mixed-EOL
// file (some `\r\n` lines, some bare `\n`) is untouched everywhere outside
// the block itself; only NEW content this module writes (the block, and a
// freshly-prepended front matter on file CREATION) is rendered in the file's
// DOMINANT line ending. See `dominantEol`/`applyEol` and
// `computeFencedRanges` (which walks raw content directly rather than a
// normalised copy).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

export const INSTRUCTIONS_START_MARKER = "<!-- keryx:instructions -->";
export const INSTRUCTIONS_END_MARKER = "<!-- /keryx:instructions -->";

/**
 * Flow 313 (W4 portability), T9: parameterises this module's managed-block
 * contract over an arbitrary marker pair + renderer, so a SECOND, independent
 * managed block (the `keryx:rules` block a rules-export surface writes) can
 * share every byte-exactness guarantee below without touching the
 * `keryx:instructions` block that may already sit in the same file
 * (GEMINI.md, `.github/copilot-instructions.md`). Every parse/splice
 * operation below reads ONLY `spec.startMarker`/`spec.endMarker` — never the
 * `INSTRUCTIONS_*` constants directly — so a file holding both block kinds
 * keeps whichever one is NOT named by the caller's `spec` byte-for-byte
 * untouched, including when the two blocks are adjacent or nested-looking in
 * raw text (each block's own parse only ever pairs its own markers).
 */
export interface ManagedBlockSpec {
  readonly startMarker: string;
  readonly endMarker: string;
  render(): string;
}

/**
 * Thrown (review round 1, F1) when a file's markers cannot be parsed safely:
 * a start marker with no matching end marker, an end marker with no
 * preceding start, a start marker superseded by another start before its own
 * end closes it, or either marker occurring inside a fenced code block (a
 * documentation example quoting the marker text, which must never be mistaken
 * for a real block). In every one of these cases install/uninstall/probe
 * must refuse rather than guess — guessing is exactly what used to delete
 * user content between a stray start marker and EOF.
 */
export class UnterminatedInstructionsBlockError extends Error {}

interface Block {
  readonly start: number;
  readonly end: number;
}

type LineEnding = "\r\n" | "\n";

/**
 * The file's majority line ending, counted directly over raw (possibly
 * mixed-EOL) content — NEW content this module writes (the block, a
 * freshly-prepended front matter) follows this, never a hardcoded style, so
 * install does not turn a CRLF file's own inserted content into a stray LF
 * island (or vice versa). A tie, or a file with no newlines at all, defaults
 * to `"\n"`.
 */
function dominantEol(content: string): LineEnding {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const totalLf = (content.match(/\n/g) ?? []).length;
  const bareLf = totalLf - crlf;
  return crlf > bareLf ? "\r\n" : "\n";
}

/** Rewrites a LITERAL's own `\n`s to `eol` — used only on text this module itself renders (the block, front matter), never on bytes read back from disk. */
function applyEol(text: string, eol: LineEnding): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function endsWithEol(text: string): boolean {
  return text.endsWith("\n"); // covers both "\n" and "\r\n" (which also ends in "\n")
}

/** Advances `cursor` past one line ending (`\r\n` or `\n`) at that position, if any. */
function eatEol(text: string, cursor: number): number {
  if (text.startsWith("\r\n", cursor)) return cursor + 2;
  if (text[cursor] === "\n") return cursor + 1;
  return cursor;
}

/**
 * `text` with ONE trailing line ending stripped off its very end, if the text
 * ends with two consecutive line endings back to back (a blank line) —
 * either style, and the two need not match each other. Used by uninstall to
 * remove exactly the one blank separator line install may have added
 * immediately before a block, never more.
 */
function stripOneTrailingSeparatorEol(text: string): string {
  const match = text.match(/(\r\n|\n)(\r\n|\n)$/);
  return match ? text.slice(0, text.length - match[2]!.length) : text;
}

/** `text` with CRLF normalised to LF and trailing whitespace trimmed — comparison only, never written back. */
function normalizeForCompare(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

/** The managed block body, byte-identical across every markdown-block surface. */
export function renderInstructionsBlock(): string {
  return `${INSTRUCTIONS_START_MARKER}
## Keryx

Before the first shell command, search, file read, code navigation, planning step, implementation, review, analysis, or subagent dispatch in this repository, read \`.metaproject/index.md\` when it exists — it routes to the project's rules, skills, wiki, and tools; do not treat it as an on-demand reference. Any text/symbol/pattern search over project code goes through \`keryx ctx rg\`, never a bare \`rg\`/\`grep\`.
${INSTRUCTIONS_END_MARKER}
`;
}

/** The default spec every pre-existing call site implicitly used before `ManagedBlockSpec` existed — the `keryx:instructions` pointer block. */
export const INSTRUCTIONS_BLOCK_SPEC: ManagedBlockSpec = {
  startMarker: INSTRUCTIONS_START_MARKER,
  endMarker: INSTRUCTIONS_END_MARKER,
  render: renderInstructionsBlock,
};

function allIndices(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

/**
 * Char ranges (start inclusive, end exclusive) covered by fenced code blocks
 * (``` or ~~~, >=3). Walks `content` DIRECTLY — raw, possibly mixed-EOL bytes
 * — splitting on either `\r\n` or `\n` while tracking exact offsets, rather
 * than a normalised copy, so a marker's position here lines up exactly with
 * `allIndices`' positions in the same raw string.
 */
function computeFencedRanges(content: string): { ranges: Array<[number, number]>; endsInOpenFence: boolean } {
  const ranges: Array<[number, number]> = [];
  const eolRe = /\r\n|\n/g;
  let lineStart = 0;
  let fenceStart: number | null = null;
  let match: RegExpExecArray | null;
  const consumeLine = (text: string, end: number): void => {
    if (/^(`{3,}|~{3,})/.test(text.trimStart())) {
      if (fenceStart === null) fenceStart = lineStart;
      else {
        ranges.push([fenceStart, end]);
        fenceStart = null;
      }
    }
  };
  while ((match = eolRe.exec(content)) !== null) {
    const lineEnd = match.index + match[0].length;
    consumeLine(content.slice(lineStart, match.index), lineEnd);
    lineStart = lineEnd;
  }
  consumeLine(content.slice(lineStart), content.length);
  // An unterminated fence: cheap-and-safe is to treat the rest of the file as
  // fenced rather than assume it closes, so a marker after it is not trusted.
  if (fenceStart !== null) ranges.push([fenceStart, content.length]);
  return { ranges, endsInOpenFence: fenceStart !== null };
}

function isWithinRanges(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => offset >= s && offset < e);
}

/**
 * True when `content` ends with a still-open fenced code block (its closing
 * ``` / ~~~ line was never reached) — the exact condition
 * `computeFencedRanges` treats as "fenced through EOF" (round 4, R4-1).
 * Appending the block after such a fence would land it inside that
 * (mis-detected) fenced range, so a later parse would refuse it as
 * unterminated; install/inspect check this UP FRONT instead and refuse with a
 * precise, actionable error, leaving the file untouched.
 */
function endsInsideOpenFence(content: string): boolean {
  return computeFencedRanges(content).endsInOpenFence;
}

/** The exact error `installMarkdownBlock`/`inspectMarkdownBlock` share for a file ending inside an unclosed code fence (R4-1). */
function unclosedFenceMessage(relativePath: string): string {
  return `${relativePath}: ends inside an unclosed code fence — close it (or add the Keryx block by hand) before installing`;
}

/**
 * Every COMPLETE `start...end` block in `content` (raw, possibly mixed-EOL
 * bytes), in document order. Throws `UnterminatedInstructionsBlockError` —
 * never silently drops or guesses — the moment it finds a marker it cannot
 * pair up safely.
 */
function parseBlocks(content: string, relativePath: string, spec: ManagedBlockSpec): Block[] {
  const fail = (): never => {
    throw new UnterminatedInstructionsBlockError(
      `${relativePath}: unterminated ${spec.startMarker} block — fix it by hand`,
    );
  };

  const { ranges: fenced } = computeFencedRanges(content);
  const starts = allIndices(content, spec.startMarker);
  const ends = allIndices(content, spec.endMarker);

  // A marker literally quoted inside a fenced code block (e.g. a doc example)
  // is not trustworthy either way — refuse rather than treat it as real or
  // silently ignore it.
  if (starts.some((i) => isWithinRanges(i, fenced)) || ends.some((i) => isWithinRanges(i, fenced))) fail();

  const blocks: Block[] = [];
  let si = 0;
  let ei = 0;
  while (si < starts.length || ei < ends.length) {
    // An end marker with nothing before it to close, or a start ahead of it.
    if (ei < ends.length && (si >= starts.length || ends[ei]! < starts[si]!)) fail();
    // A start marker with no end marker left to pair with.
    if (ei >= ends.length) fail();
    const start = starts[si]!;
    const end = ends[ei]!;
    // Another start begins before this end closes the current one.
    if (si + 1 < starts.length && starts[si + 1]! < end) fail();
    blocks.push({ start, end: end + spec.endMarker.length });
    si += 1;
    ei += 1;
  }
  return blocks;
}

/**
 * Replace the FIRST block with `replacement`; drop every later block
 * entirely (F9: duplicate complete blocks collapse into one on install).
 * Eats exactly the one line ending each block's own rendered text
 * contributed, so neither the kept nor a dropped block leaves a blank line
 * behind. Everything outside a block's own span is copied byte-for-byte from
 * `content`.
 */
function collapseBlocks(content: string, blocks: Block[], replacement: string): string {
  let result = "";
  let cursor = 0;
  blocks.forEach((block, i) => {
    result += content.slice(cursor, block.start);
    if (i === 0) result += replacement;
    cursor = eatEol(content, block.end);
  });
  result += content.slice(cursor);
  return result;
}

/**
 * Remove every block entirely (F9: uninstall removes ALL duplicate blocks),
 * ALSO removing exactly one blank separator line immediately before each
 * block, if one is there (the re-plan's simplified uninstall contract — see
 * the module header). Everything else — including a genuine blank line that
 * was part of the surrounding content rather than a separator install added
 * — is copied byte-for-byte; there is no way to tell the two apart without
 * the marker this rewrite removes, so this is a deliberate, documented
 * normalisation, not a bug.
 */
function removeBlocksAndSeparators(content: string, blocks: readonly Block[]): string {
  let result = "";
  let cursor = 0;
  for (const block of blocks) {
    result += stripOneTrailingSeparatorEol(content.slice(cursor, block.start));
    cursor = eatEol(content, block.end);
  }
  result += content.slice(cursor);
  return result;
}

/**
 * Append `block` to `content` per the re-plan's simplified contract: an
 * EMPTY file gets just the block (no separator — nothing to separate it
 * from); a file already ending in a line ending gets ONE blank separator
 * line before the block; a file that does NOT end in a line ending gets its
 * last line terminated first, THEN the same one blank separator line. Every
 * new line ending here is the file's DOMINANT style (N4), never a hardcoded
 * one.
 */
function appendBlock(content: string, block: string, eol: LineEnding): string {
  if (content.length === 0) return block;
  return endsWithEol(content) ? `${content}${eol}${block}` : `${content}${eol}${eol}${block}`;
}

function fileFor(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * Install the managed block into `relativePath`.
 *
 * - The file does NOT exist: it is created (parent directories too) with
 *   `frontMatter` (kiro's steering front matter) prepended when given, then
 *   the block — LF throughout, since there is no existing file whose EOL
 *   style to follow.
 * - The file DOES exist: `frontMatter` is NEVER added, regardless of
 *   whether the file already carries its own front matter, Keryx's own, or
 *   none at all (re-plan simplification — see the module header) — only the
 *   block itself is ever touched. Idempotent: re-running replaces only the
 *   block, preserving everything else in the file untouched. The block is
 *   rendered in the file's DOMINANT line ending (N4); everything outside the
 *   spliced region is copied from the file's raw bytes untouched, so a
 *   mixed-EOL file is never homogenised by an install. A file with more than
 *   one complete block collapses to one (replacing the first, dropping the
 *   rest).
 *
 * Refuses — leaving the file completely untouched — when a block cannot be
 * parsed safely; see `UnterminatedInstructionsBlockError`.
 */
export async function installMarkdownBlock(
  root: string,
  relativePath: string,
  frontMatter?: string,
  spec: ManagedBlockSpec = INSTRUCTIONS_BLOCK_SPEC,
): Promise<string[]> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${frontMatter ?? ""}${spec.render()}`, "utf8");
    return [];
  }
  const raw = await readFile(file, "utf8");
  const eol = dominantEol(raw);

  let blocks: Block[];
  try {
    blocks = parseBlocks(raw, relativePath, spec);
  } catch (error) {
    if (error instanceof UnterminatedInstructionsBlockError) return [error.message];
    throw error;
  }

  // R4-1: a file ending inside an unclosed fence must be refused BEFORE
  // either the append or the in-place-replacement path touches it — appending
  // after an unclosed fence would place the new block inside that
  // (mis-detected) fenced range, so a later parse would wrongly refuse it as
  // unterminated. Caught here, up front, with a precise error instead.
  if (endsInsideOpenFence(raw)) return [unclosedFenceMessage(relativePath)];

  const block = applyEol(spec.render(), eol);
  const next = blocks.length === 0 ? appendBlock(raw, block, eol) : collapseBlocks(raw, blocks, block);
  if (next !== raw) await writeFile(file, next, "utf8");
  return [];
}

/**
 * Remove every managed block from `relativePath`, plus (at most) the one
 * blank separator line immediately before each (`removeBlocksAndSeparators`
 * — the re-plan's simplified contract, see the module header). The file
 * itself is then deleted iff what remains is empty/whitespace-only, OR
 * equals Keryx's own `frontMatter` exactly once compared CRLF-normalised
 * and with trailing whitespace trimmed — NOT by asking whether install
 * itself created the file (round 1/2's marker-based approach): a
 * pre-existing file install wrote the block into is deleted here too when
 * nothing else is left, including one that was empty before install ran —
 * there is no byte-level way to tell that apart from a file install
 * created outright, and this is documented as an accepted trade-off (see
 * `docs/docs/integrations.md`) rather than tracked with a second marker. A
 * pre-existing file with OTHER content is never deleted and never loses
 * front matter it already had (it was never given Keryx's).
 *
 * Returns `false` when there was nothing to remove. Throws
 * `UnterminatedInstructionsBlockError` — and leaves the file completely
 * untouched — rather than guess at, and potentially delete content around, a
 * block it cannot parse safely (F1). `customUninstall`'s contract has no
 * error channel (unlike `customInstall`'s `string[]`), so throwing here —
 * the same "refuse hard" idiom `readSettingsFile` already uses for invalid
 * JSON — is how this surface refuses; `installer.ts` (N1) catches it into a
 * `failed` `SurfaceResult` rather than letting it escape.
 */
export async function uninstallMarkdownBlock(
  root: string,
  relativePath: string,
  frontMatter?: string,
  spec: ManagedBlockSpec = INSTRUCTIONS_BLOCK_SPEC,
): Promise<boolean> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) return false;
  const raw = await readFile(file, "utf8");
  const blocks = parseBlocks(raw, relativePath, spec);
  if (blocks.length === 0) return false;

  const remainder = removeBlocksAndSeparators(raw, blocks);
  const normalizedRemainder = normalizeForCompare(remainder);
  const deletable =
    normalizedRemainder === "" || (frontMatter !== undefined && normalizedRemainder === normalizeForCompare(frontMatter));

  if (deletable) {
    await rm(file, { force: true });
    return true;
  }
  if (remainder !== raw) await writeFile(file, remainder, "utf8");
  return true;
}

export interface MarkdownBlockInspection {
  readonly state: "absent-file" | "no-block" | "present" | "stale" | "malformed";
  readonly message?: string;
}

/**
 * Structured probe (review round 2, F4/N1): the single source of truth
 * `probeMarkdownBlock` (health-check messages) AND `installer.ts`'s dry-run
 * presence checks both build on, so dry-run and the real install/uninstall
 * can never disagree about what state a markdown-block surface's file is in.
 */
export async function inspectMarkdownBlock(
  root: string,
  relativePath: string,
  spec: ManagedBlockSpec = INSTRUCTIONS_BLOCK_SPEC,
): Promise<MarkdownBlockInspection> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) return { state: "absent-file" };
  const raw = await readFile(file, "utf8");
  let blocks: Block[];
  try {
    blocks = parseBlocks(raw, relativePath, spec);
  } catch (error) {
    if (error instanceof UnterminatedInstructionsBlockError) return { state: "malformed", message: error.message };
    throw error;
  }
  if (blocks.length === 0) {
    // R4-1: a file with no block that ALSO ends inside an unclosed fence
    // would otherwise be reported as merely "no-block" here while
    // `installMarkdownBlock` refuses it outright — reported as "malformed"
    // (the same state a parse failure uses) so `installer.ts`'s existing
    // "malformed" -> `failed` dry-run handling, and the `MarkdownBlockInspection`
    // type both already in place, cover this case with no further changes:
    // a dry-run install (built on this same inspection) predicts the real
    // install's refusal instead of promising success it cannot deliver.
    if (endsInsideOpenFence(raw)) return { state: "malformed", message: unclosedFenceMessage(relativePath) };
    return { state: "no-block", message: `${relativePath}: missing the ${markerLabel(spec)} block` };
  }
  const first = blocks[0]!;
  // Normalised to LF for comparison only — never written back — so a CRLF
  // file's block still compares equal to the LF-rendered canonical text.
  const block = raw.slice(first.start, first.end).replace(/\r\n/g, "\n");
  if (`${block}\n`.trim() !== spec.render().trim()) {
    return { state: "stale", message: `${relativePath}: ${markerLabel(spec)} block is stale — re-run the install` };
  }
  return { state: "present" };
}

/** `<!-- keryx:rules -->` -> `keryx:rules` — a short human label for a spec's marker, for probe/inspect messages. */
function markerLabel(spec: ManagedBlockSpec): string {
  return spec.startMarker.replace(/^<!--\s*/, "").replace(/\s*-->$/, "");
}

/** Health check for a markdown-block surface: missing file / missing block / stale block content / unterminated block. */
export async function probeMarkdownBlock(
  root: string,
  relativePath: string,
  spec: ManagedBlockSpec = INSTRUCTIONS_BLOCK_SPEC,
): Promise<string[]> {
  const inspection = await inspectMarkdownBlock(root, relativePath, spec);
  switch (inspection.state) {
    case "absent-file":
      return [`${relativePath}: file is missing`];
    case "no-block":
    case "stale":
    case "malformed":
      return [inspection.message!];
    case "present":
      return [];
  }
}
