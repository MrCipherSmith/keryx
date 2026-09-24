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

function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** CRLF -> LF, used only for detection/comparison — never written back as-is. */
function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/** The inverse of `normalizeNewlines`, applied once at write time. */
function applyLineEnding(content: string, ending: LineEnding): string {
  return ending === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

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

/** Char ranges (start inclusive, end exclusive) covered by fenced code blocks (``` or ~~~, >=3). */
function computeFencedRanges(normalized: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fenceStart: number | null = null;
  for (const line of normalized.split("\n")) {
    if (/^(`{3,}|~{3,})/.test(line.trimStart())) {
      if (fenceStart === null) {
        fenceStart = offset;
      } else {
        ranges.push([fenceStart, offset + line.length]);
        fenceStart = null;
      }
    }
    offset += line.length + 1;
  }
  // An unterminated fence: cheap-and-safe is to treat the rest of the file as
  // fenced rather than assume it closes, so a marker after it is not trusted.
  if (fenceStart !== null) ranges.push([fenceStart, normalized.length]);
  return ranges;
}

function isWithinRanges(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => offset >= s && offset < e);
}

/**
 * Every COMPLETE `start...end` block in `normalized`, in document order.
 * Throws `UnterminatedInstructionsBlockError` — never silently drops or
 * guesses — the moment it finds a marker it cannot pair up safely.
 */
function parseBlocks(normalized: string, relativePath: string): Block[] {
  const fail = (): never => {
    throw new UnterminatedInstructionsBlockError(
      `${relativePath}: unterminated ${INSTRUCTIONS_START_MARKER} block — fix it by hand`,
    );
  };

  const fenced = computeFencedRanges(normalized);
  const starts = allIndices(normalized, INSTRUCTIONS_START_MARKER);
  const ends = allIndices(normalized, INSTRUCTIONS_END_MARKER);

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
 * Eats exactly the one newline each block's own rendered text contributed,
 * so neither the kept nor a dropped block leaves a blank line behind.
 */
function collapseBlocks(normalized: string, blocks: Block[], replacement: string): string {
  let result = "";
  let cursor = 0;
  blocks.forEach((block, i) => {
    result += normalized.slice(cursor, block.start);
    if (i === 0) result += replacement;
    cursor = block.end;
    if (normalized[cursor] === "\n") cursor += 1;
  });
  result += normalized.slice(cursor);
  return result;
}

/** Remove every block entirely (F9: uninstall removes ALL duplicate blocks). */
function removeAllBlocks(normalized: string, blocks: Block[]): string {
  let result = "";
  let cursor = 0;
  for (const block of blocks) {
    result += normalized.slice(cursor, block.start);
    cursor = block.end;
    if (normalized[cursor] === "\n") cursor += 1;
  }
  result += normalized.slice(cursor);
  return result;
}

function appendBlock(content: string, block: string): string {
  if (content.length === 0) return block;
  const withTrailingNewline = content.endsWith("\n") ? content : `${content}\n`;
  const separator = withTrailingNewline.endsWith("\n\n") ? "" : "\n";
  return `${withTrailingNewline}${separator}${block}`;
}

/** True when `normalized` starts with a YAML front-matter block (any content, not just Keryx's own). */
function hasAnyFrontMatter(normalized: string): boolean {
  const lines = normalized.split("\n");
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
 * in the file untouched. CRLF files are read/compared as LF (F9) and written
 * back in their original line-ending style. A file with more than one
 * complete block collapses to one (replacing the first, dropping the rest).
 * Refuses — leaving the file completely untouched — when a block cannot be
 * parsed safely; see `UnterminatedInstructionsBlockError`.
 */
export async function installMarkdownBlock(root: string, relativePath: string, frontMatter?: string): Promise<string[]> {
  const file = fileFor(root, relativePath);
  const block = renderInstructionsBlock();
  if (!(await pathExists(file))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${frontMatter ?? ""}${block}`, "utf8");
    return [];
  }
  const raw = await readFile(file, "utf8");
  const lineEnding = detectLineEnding(raw);
  const normalized = normalizeNewlines(raw);
  const withFrontMatter = frontMatter && !hasAnyFrontMatter(normalized) ? `${frontMatter}${normalized}` : normalized;

  let blocks: Block[];
  try {
    blocks = parseBlocks(withFrontMatter, relativePath);
  } catch (error) {
    if (error instanceof UnterminatedInstructionsBlockError) return [error.message];
    throw error;
  }

  const next = blocks.length === 0 ? appendBlock(withFrontMatter, block) : collapseBlocks(withFrontMatter, blocks, block);
  const nextRaw = applyLineEnding(next, lineEnding);
  if (nextRaw !== raw) await writeFile(file, nextRaw, "utf8");
  return [];
}

/**
 * Remove every managed block from `relativePath`. Deletes the file when
 * nothing but whitespace (or only the front matter Keryx itself wrote) would
 * remain; otherwise preserves every other line untouched. Returns `false`
 * when there was nothing to remove.
 *
 * CRLF files are read/compared as LF and written back in their original
 * line-ending style (F9). An install→uninstall round trip on a file that had
 * content without the block, and ended with a single trailing newline, is
 * byte-identical — uninstall removes exactly the blank-line separator
 * install added, nothing more.
 *
 * Throws `UnterminatedInstructionsBlockError` — and leaves the file
 * completely untouched — rather than guess at, and potentially delete
 * content around, a block it cannot parse safely (F1). `customUninstall`'s
 * contract has no error channel (unlike `customInstall`'s `string[]`), so
 * throwing here — the same "refuse hard" idiom `readSettingsFile` already
 * uses for invalid JSON — is how this surface refuses.
 */
export async function uninstallMarkdownBlock(root: string, relativePath: string, frontMatter?: string): Promise<boolean> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) return false;
  const raw = await readFile(file, "utf8");
  const lineEnding = detectLineEnding(raw);
  const normalized = normalizeNewlines(raw);
  const blocks = parseBlocks(normalized, relativePath);
  if (blocks.length === 0) return false;

  const lastBlock = blocks[blocks.length - 1]!;
  const afterLast = normalized.slice(lastBlock.end);
  const wasTrailingBlock = afterLast === "" || afterLast === "\n";
  // The "file didn't exist yet" install path (`${frontMatter ?? ""}${block}`)
  // never runs `appendBlock`'s separator logic at all — it is a direct
  // concatenation. Collapsing a trailing blank line there would eat part of
  // the front matter's OWN formatting, not a separator this helper added.
  const beforeFirstBlock = normalized.slice(0, blocks[0]!.start);
  const skipSeparatorCollapse = frontMatter !== undefined && beforeFirstBlock === frontMatter;

  let removed = removeAllBlocks(normalized, blocks);
  if (wasTrailingBlock && !skipSeparatorCollapse) removed = removed.replace(/\n\n$/, "\n");

  const withoutFrontMatter = frontMatter && removed.startsWith(frontMatter) ? removed.slice(frontMatter.length) : removed;
  if (withoutFrontMatter.trim().length === 0) {
    await rm(file, { force: true });
  } else {
    const nextRaw = applyLineEnding(removed, lineEnding);
    if (nextRaw !== raw) await writeFile(file, nextRaw, "utf8");
  }
  return true;
}

/** Health check for a markdown-block surface: missing file / missing block / stale block content. */
export async function probeMarkdownBlock(root: string, relativePath: string): Promise<string[]> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) {
    return [`${relativePath}: file is missing`];
  }
  const raw = await readFile(file, "utf8");
  const normalized = normalizeNewlines(raw);
  let blocks: Block[];
  try {
    blocks = parseBlocks(normalized, relativePath);
  } catch (error) {
    if (error instanceof UnterminatedInstructionsBlockError) return [error.message];
    throw error;
  }
  if (blocks.length === 0) {
    return [`${relativePath}: missing the keryx:instructions block`];
  }
  const first = blocks[0]!;
  const block = normalized.slice(first.start, first.end);
  if (`${block}\n`.trim() !== renderInstructionsBlock().trim()) {
    return [`${relativePath}: keryx:instructions block is stale — re-run the install`];
  }
  return [];
}
