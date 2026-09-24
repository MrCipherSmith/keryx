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
// Review round 2 (N4): every splice below operates on the file's RAW bytes
// directly — never a normalised-then-reapplied copy — so a mixed-EOL file
// (some `\r\n` lines, some bare `\n`) is untouched everywhere outside the
// block itself; only NEW content this module writes (the block, and a
// freshly-prepended front matter) is rendered in the file's DOMINANT line
// ending. See `dominantEol`/`applyEol` and `computeFencedRanges` (which walks
// raw content directly rather than a normalised copy).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

export const INSTRUCTIONS_START_MARKER = "<!-- keryx:instructions -->";
export const INSTRUCTIONS_END_MARKER = "<!-- /keryx:instructions -->";

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

/** True when `text` ends with two consecutive line endings (a blank line), either style. */
function endsWithBlankLine(text: string): boolean {
  return /(\r\n|\n)(\r\n|\n)$/.test(text);
}

/** Collapses a trailing blank line (either EOL style) to a single line ending, preserving which style was there. */
function collapseTrailingBlankLine(text: string): string {
  const match = text.match(/(\r\n|\n)(\r\n|\n)$/);
  if (!match) return text;
  return text.slice(0, text.length - match[0].length) + match[2];
}

/** Advances `cursor` past one line ending (`\r\n` or `\n`) at that position, if any. */
function eatEol(text: string, cursor: number): number {
  if (text.startsWith("\r\n", cursor)) return cursor + 2;
  if (text[cursor] === "\n") return cursor + 1;
  return cursor;
}

/**
 * Review round 2 (N4): a distinguishing marker written ONLY on the "file did
 * not exist yet" install path — the one case where `writeFile` creates the
 * file outright rather than editing existing bytes. Its presence (immediately
 * before the block, after `frontMatter` if any) is how `uninstallMarkdownBlock`
 * tells "install created this file" apart from "the file already existed
 * (even if empty/whitespace-only) and install only added the block" — two
 * cases that, before this marker existed, could write byte-identical content
 * and were therefore impossible to tell apart afterwards. Only the FORMER may
 * ever have its file deleted on uninstall; the latter always survives, even
 * when nothing but whitespace is left once the block is removed.
 */
const CREATED_FILE_MARKER = "<!-- keryx:created-file -->\n";

/** The managed block body, byte-identical across every markdown-block surface. */
export function renderInstructionsBlock(): string {
  return `${INSTRUCTIONS_START_MARKER}
## Keryx

Before the first shell command, search, file read, code navigation, planning step, implementation, review, analysis, or subagent dispatch in this repository, read \`.metaproject/index.md\` when it exists — it routes to the project's rules, skills, wiki, and tools; do not treat it as an on-demand reference. Any text/symbol/pattern search over project code goes through \`keryx ctx rg\`, never a bare \`rg\`/\`grep\`.
${INSTRUCTIONS_END_MARKER}
`;
}

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
function computeFencedRanges(content: string): Array<[number, number]> {
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
  return ranges;
}

function isWithinRanges(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => offset >= s && offset < e);
}

/**
 * Every COMPLETE `start...end` block in `content` (raw, possibly mixed-EOL
 * bytes), in document order. Throws `UnterminatedInstructionsBlockError` —
 * never silently drops or guesses — the moment it finds a marker it cannot
 * pair up safely.
 */
function parseBlocks(content: string, relativePath: string): Block[] {
  const fail = (): never => {
    throw new UnterminatedInstructionsBlockError(
      `${relativePath}: unterminated ${INSTRUCTIONS_START_MARKER} block — fix it by hand`,
    );
  };

  const fenced = computeFencedRanges(content);
  const starts = allIndices(content, INSTRUCTIONS_START_MARKER);
  const ends = allIndices(content, INSTRUCTIONS_END_MARKER);

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
    blocks.push({ start, end: end + INSTRUCTIONS_END_MARKER.length });
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

/** Remove every block entirely (F9: uninstall removes ALL duplicate blocks). Everything outside a block's own span is copied byte-for-byte. */
function removeAllBlocks(content: string, blocks: Block[]): string {
  let result = "";
  let cursor = 0;
  for (const block of blocks) {
    result += content.slice(cursor, block.start);
    cursor = eatEol(content, block.end);
  }
  result += content.slice(cursor);
  return result;
}

function appendBlock(content: string, block: string, eol: LineEnding): string {
  if (content.length === 0) return block;
  const withTrailingNewline = endsWithEol(content) ? content : `${content}${eol}`;
  const separator = endsWithBlankLine(withTrailingNewline) ? "" : eol;
  return `${withTrailingNewline}${separator}${block}`;
}

/** True when `content` starts with a YAML front-matter block (any content, not just Keryx's own). Splits on either EOL style. */
function hasAnyFrontMatter(content: string): boolean {
  const lines = content.split(/\r\n|\n/);
  if (lines[0] !== "---") return false;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") return true;
  }
  return false;
}

function fileFor(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * Install the managed block into `relativePath`, creating the file (and any
 * parent directories) and prepending `frontMatter` (kiro's steering front
 * matter) when the file does not exist yet, or exists but does not already
 * start with SOME front-matter block (F8 — a file the user already gave
 * front matter to is never double-prepended, even if that front matter isn't
 * byte-identical to Keryx's own).
 *
 * Idempotent: re-running replaces only the block, preserving everything else
 * in the file untouched. The block (and a freshly-prepended front matter) are
 * rendered in the file's DOMINANT line ending (N4); everything outside the
 * spliced region is copied from the file's raw bytes untouched, so a
 * mixed-EOL file is never homogenised by an install. A file with more than
 * one complete block collapses to one (replacing the first, dropping the
 * rest). Refuses — leaving the file completely untouched — when a block
 * cannot be parsed safely; see `UnterminatedInstructionsBlockError`.
 */
export async function installMarkdownBlock(root: string, relativePath: string, frontMatter?: string): Promise<string[]> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${frontMatter ?? ""}${CREATED_FILE_MARKER}${renderInstructionsBlock()}`, "utf8");
    return [];
  }
  const raw = await readFile(file, "utf8");
  const eol = dominantEol(raw);
  const frontMatterForEol = frontMatter !== undefined ? applyEol(frontMatter, eol) : undefined;
  const withFrontMatter = frontMatterForEol && !hasAnyFrontMatter(raw) ? `${frontMatterForEol}${raw}` : raw;

  let blocks: Block[];
  try {
    blocks = parseBlocks(withFrontMatter, relativePath);
  } catch (error) {
    if (error instanceof UnterminatedInstructionsBlockError) return [error.message];
    throw error;
  }

  const block = applyEol(renderInstructionsBlock(), eol);
  const next = blocks.length === 0 ? appendBlock(withFrontMatter, block, eol) : collapseBlocks(withFrontMatter, blocks, block);
  if (next !== raw) await writeFile(file, next, "utf8");
  return [];
}

/**
 * Remove every managed block from `relativePath`. Deletes the file ONLY when
 * install itself CREATED it (review round 2, N4) — detected via
 * `CREATED_FILE_MARKER`, not by whether what remains is empty/whitespace: a
 * file that already existed (even empty, or whitespace-only) before install
 * ran always survives uninstall untouched, byte-identical to what it was
 * before install, even when nothing visible is left once the block (and any
 * front matter install added) is stripped back out. Returns `false` when
 * there was nothing to remove.
 *
 * Everything outside a block's own span (and, when install added it, the
 * exact `frontMatter` text it prepended) is preserved byte-for-byte,
 * including original mixed line endings (N4).
 *
 * Throws `UnterminatedInstructionsBlockError` — and leaves the file
 * completely untouched — rather than guess at, and potentially delete
 * content around, a block it cannot parse safely (F1). `customUninstall`'s
 * contract has no error channel (unlike `customInstall`'s `string[]`), so
 * throwing here — the same "refuse hard" idiom `readSettingsFile` already
 * uses for invalid JSON — is how this surface refuses; `installer.ts` (N1)
 * catches it into a `failed` `SurfaceResult` rather than letting it escape.
 */
export async function uninstallMarkdownBlock(root: string, relativePath: string, frontMatter?: string): Promise<boolean> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) return false;
  const raw = await readFile(file, "utf8");
  const blocks = parseBlocks(raw, relativePath);
  if (blocks.length === 0) return false;

  const lastBlock = blocks[blocks.length - 1]!;
  const afterLast = raw.slice(lastBlock.end);
  const wasTrailingBlock = afterLast === "" || afterLast === "\n" || afterLast === "\r\n";

  const beforeFirstBlock = raw.slice(0, blocks[0]!.start);
  const createdPrefix = `${frontMatter ?? ""}${CREATED_FILE_MARKER}`;
  const createdByInstall = beforeFirstBlock === createdPrefix;
  // The "file didn't exist yet" install path (direct concatenation) and the
  // "existing file whose own content was empty, so front matter alone ends up
  // right before the block" path both never ran `appendBlock`'s separator
  // logic — collapsing a trailing blank line there would eat part of the
  // front matter's OWN formatting, not a separator this module added.
  const directConcatenation = createdByInstall || (frontMatter !== undefined && beforeFirstBlock === frontMatter);

  let removed = removeAllBlocks(raw, blocks);
  if (wasTrailingBlock && !directConcatenation) removed = collapseTrailingBlankLine(removed);

  if (createdByInstall && removed === createdPrefix) {
    await rm(file, { force: true });
    return true;
  }

  const withoutFrontMatter = frontMatter && removed.startsWith(frontMatter) ? removed.slice(frontMatter.length) : removed;
  if (withoutFrontMatter !== raw) await writeFile(file, withoutFrontMatter, "utf8");
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
export async function inspectMarkdownBlock(root: string, relativePath: string): Promise<MarkdownBlockInspection> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) return { state: "absent-file" };
  const raw = await readFile(file, "utf8");
  let blocks: Block[];
  try {
    blocks = parseBlocks(raw, relativePath);
  } catch (error) {
    if (error instanceof UnterminatedInstructionsBlockError) return { state: "malformed", message: error.message };
    throw error;
  }
  if (blocks.length === 0) return { state: "no-block", message: `${relativePath}: missing the keryx:instructions block` };
  const first = blocks[0]!;
  // Normalised to LF for comparison only — never written back — so a CRLF
  // file's block still compares equal to the LF-rendered canonical text.
  const block = raw.slice(first.start, first.end).replace(/\r\n/g, "\n");
  if (`${block}\n`.trim() !== renderInstructionsBlock().trim()) {
    return { state: "stale", message: `${relativePath}: keryx:instructions block is stale — re-run the install` };
  }
  return { state: "present" };
}

/** Health check for a markdown-block surface: missing file / missing block / stale block content / unterminated block. */
export async function probeMarkdownBlock(root: string, relativePath: string): Promise<string[]> {
  const inspection = await inspectMarkdownBlock(root, relativePath);
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
