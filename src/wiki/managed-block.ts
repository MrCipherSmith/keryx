// LWG-5 managed block (flow 227, phase 2).
//
// Marks the `## Reference (from code graph)` section as machine territory so a
// deterministic writer can regenerate it WITHOUT touching anything else — on
// accepted pages included.
//
// This is not a new policy overriding "an accepted page belongs to the human".
// It is the boundary without which the contract already written down cannot be
// honoured at all: `.metaproject/skills/gdwiki/SKILL.md:110` tells an enricher
// to "Leave the `## Reference` section untouched (it is graph-owned and
// regenerated)", while `:113` says accepting the page means
// `collect --force` will never overwrite it. Both hold only if the page and
// that section are different units of ownership — and `writeCollectedPage`
// (`src/wiki/service.ts:791-804`) draws no such line, so the promised
// regeneration cannot happen. The markers draw it.
//
// The opening marker carries a hash of the block's content at the last machine
// write. A mismatch means a human edited inside the machine region, and that
// is refused rather than overwritten: someone who edited there probably meant
// to, and the cost of asking is one flag.

import { createHash } from "node:crypto";

export const MARKER_VERSION = 1;
const BEGIN = /^<!--\s*keryx:reference:begin\s+v=(\d+)(?:\s+hash=([0-9a-f]{64}))?\s*-->$/;
const END = /^<!--\s*keryx:reference:end\s*-->$/;

/** The heading the block wraps. Matched loosely: the suffix has varied. */
const REFERENCE_HEADING = /^##\s+Reference\b/i;

export interface ManagedBlock {
  /** Marker format version from the opening marker. */
  markerVersion: number;
  /** Hash recorded at the last machine write, or null if never written. */
  recordedHash: string | null;
  /** Hash of the block's current content. */
  currentHash: string;
  /** Content between the markers, markers excluded. */
  content: string;
  /** Line index of the opening marker, 0-based. */
  beginLine: number;
  /** Line index of the closing marker, 0-based. */
  endLine: number;
  /**
   * True when the recorded and current hashes disagree — someone edited inside
   * the machine region. `refresh` must refuse without `--force`.
   */
  handEdited: boolean;
}

export type BlockState =
  | { kind: "present"; block: ManagedBlock }
  | { kind: "absent" }
  | { kind: "no-reference-section" }
  | { kind: "malformed"; reason: string };

export function hashBlockContent(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex");
}

/**
 * Locate the managed block.
 *
 * `malformed` is returned rather than thrown for every damaged shape — an
 * unclosed marker, a stray close, an unknown version. A page is data written
 * by people and by earlier versions of this tool; refusing to read the corpus
 * because one page is damaged would take the whole command down with it.
 */
export function findManagedBlock(content: string): BlockState {
  const lines = content.split("\n");
  let beginLine = -1;
  let endLine = -1;
  let markerVersion = 0;
  let recordedHash: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    const begin = line.match(BEGIN);
    if (begin) {
      if (beginLine >= 0) {
        return { kind: "malformed", reason: "more than one opening marker" };
      }
      beginLine = index;
      markerVersion = Number(begin[1]);
      recordedHash = begin[2] ?? null;
      continue;
    }
    if (END.test(line)) {
      if (beginLine < 0) {
        return { kind: "malformed", reason: "closing marker with no opening marker" };
      }
      if (endLine >= 0) {
        return { kind: "malformed", reason: "more than one closing marker" };
      }
      endLine = index;
    }
  }

  if (beginLine < 0 && endLine < 0) {
    const headings = lines.filter((line) => REFERENCE_HEADING.test(line.trim())).length;
    if (headings === 0) {
      return { kind: "no-reference-section" };
    }
    if (headings > 1) {
      return { kind: "malformed", reason: "more than one Reference heading" };
    }
    return { kind: "absent" };
  }
  if (endLine < 0) {
    return { kind: "malformed", reason: "opening marker with no closing marker" };
  }
  if (markerVersion !== MARKER_VERSION) {
    // Refused, not guessed at. A future format this build cannot read must not
    // be rewritten by it.
    return { kind: "malformed", reason: `unknown marker version ${markerVersion}` };
  }

  const blockContent = lines.slice(beginLine + 1, endLine).join("\n");
  const currentHash = hashBlockContent(blockContent);
  return {
    kind: "present",
    block: {
      markerVersion,
      recordedHash,
      currentHash,
      content: blockContent,
      beginLine,
      endLine,
      // No recorded hash means the block predates hashing, not that it was
      // edited. Treating it as tampered would make every migrated page need
      // `--force` once.
      handEdited: recordedHash !== null && recordedHash !== currentHash,
    },
  };
}

function markerLines(hash: string): { begin: string; end: string } {
  return {
    begin: `<!-- keryx:reference:begin v=${MARKER_VERSION} hash=${hash} -->`,
    end: "<!-- keryx:reference:end -->",
  };
}

/**
 * Wrap an existing `## Reference` section in markers, changing nothing else.
 *
 * The section runs from its heading to the next same-or-higher heading, or to
 * the end of the page. Returns `null` when there is nothing to wrap — the
 * caller decides whether that is an error, because for migration it is not:
 * one of this repository's 42 component pages simply has no Reference section,
 * and inventing one would be authoring content, not migrating.
 */
export function wrapReferenceSection(content: string): string | null {
  const state = findManagedBlock(content);
  if (state.kind !== "absent") {
    return null;
  }

  const lines = content.split("\n");
  const start = lines.findIndex((line) => REFERENCE_HEADING.test(line.trim()));
  if (start < 0) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,2}\s/.test(line)) {
      end = index;
      break;
    }
  }

  // Trailing blank lines belong to the page's spacing, not to the block.
  let contentEnd = end;
  while (contentEnd > start + 1 && (lines[contentEnd - 1] ?? "").trim().length === 0) {
    contentEnd -= 1;
  }

  const section = lines.slice(start, contentEnd).join("\n");
  const { begin, end: endMarker } = markerLines(hashBlockContent(section));
  return [
    ...lines.slice(0, start),
    begin,
    ...lines.slice(start, contentEnd),
    endMarker,
    ...lines.slice(contentEnd),
  ].join("\n");
}

/**
 * Replace the managed block's content, leaving every byte outside the markers
 * exactly as it was.
 */
export function replaceManagedBlock(content: string, replacement: string): string | null {
  const state = findManagedBlock(content);
  if (state.kind !== "present") {
    return null;
  }
  const lines = content.split("\n");
  const body = replacement.replace(/\s+$/, "");
  const { begin, end } = markerLines(hashBlockContent(body));
  return [
    ...lines.slice(0, state.block.beginLine),
    begin,
    ...body.split("\n"),
    end,
    ...lines.slice(state.block.endLine + 1),
  ].join("\n");
}
