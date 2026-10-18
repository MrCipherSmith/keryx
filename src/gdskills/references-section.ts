// Markdown section extraction for declared references.
//
// A reference with an anchor obliges the worker to read one section, not the
// whole document: the text from the anchored heading to the next heading of the
// same or a higher level. The resolver budgets that section's bytes; the
// validator checks a summary against its words.
//
// Only ATX headings (`## Title`) count, and headings inside fenced code blocks
// are ignored. A missing anchor is a value, not a throw: the resolver falls back
// to the whole file with a warning, and `check` reports it as an error.

export type MarkdownHeading = { level: number; text: string; slug: string };

export type SectionFound = {
  found: true;
  /** The heading text as written, without hashes and closing hashes. */
  heading: string;
  level: number;
  /** The section, heading line included, byte for byte as in the file. */
  text: string;
  /** UTF-8 size of {@link text}: what the resolver counts against the budget. */
  bytes: number;
};

export type SectionMissing = {
  found: false;
  anchor: string;
  reason: string;
  /** Heading texts the file does have, in order, so a caller can suggest one. */
  available: string[];
};

export type SectionResult = SectionFound | SectionMissing;

type HeadingLine = MarkdownHeading & { start: number };

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** GitHub-style slug: lower case, punctuation dropped, spaces to hyphens. Letters of any script are kept. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

function stripClosingHashes(text: string): string {
  return text.replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim();
}

/** Every ATX heading outside fenced code, with the byte offset of its line. Offsets keep CRLF intact. */
function scanHeadings(markdown: string): HeadingLine[] {
  const headings: HeadingLine[] = [];
  let fence: { marker: string; length: number } | undefined;
  let offset = 0;
  for (const raw of markdown.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fenceMatch = FENCE.exec(line);
    if (fence !== undefined) {
      const run = fenceMatch?.[1];
      if (run !== undefined && run[0] === fence.marker && run.length >= fence.length && line.trim() === run) fence = undefined;
      continue;
    }
    if (fenceMatch?.[1] !== undefined) {
      fence = { marker: fenceMatch[1][0] ?? "`", length: fenceMatch[1].length };
      continue;
    }
    const match = HEADING.exec(line);
    if (match === null) continue;
    const text = stripClosingHashes(match[2] ?? "");
    if (text === "") continue;
    headings.push({ level: (match[1] ?? "").length, text, slug: slugifyHeading(text), start: lineStart });
  }
  return headings;
}

/** Headings outside fenced code, in document order. */
export function markdownHeadings(markdown: string): MarkdownHeading[] {
  return scanHeadings(markdown).map(({ level, text, slug }) => ({ level, text, slug }));
}

function matchesAnchor(heading: MarkdownHeading, wanted: string, wantedSlug: string): boolean {
  return heading.text.toLowerCase() === wanted.toLowerCase() || (wantedSlug !== "" && heading.slug === wantedSlug);
}

/**
 * The section anchored by `anchor`: a heading text (case-insensitive) or its slug,
 * with or without a leading `#`. The first matching heading wins.
 */
export function extractSection(markdown: string, anchor: string): SectionResult {
  const headings = scanHeadings(markdown);
  const wanted = anchor.trim().replace(/^#+\s*/, "").trim();
  const missing = (reason: string): SectionMissing => ({ found: false, anchor, reason, available: headings.map((h) => h.text) });
  if (wanted === "") return missing("anchor is empty");

  const wantedSlug = slugifyHeading(wanted);
  const index = headings.findIndex((heading) => matchesAnchor(heading, wanted, wantedSlug));
  const heading = headings[index];
  if (heading === undefined) return missing(`no heading matches anchor "${anchor}"`);

  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  const text = markdown.slice(heading.start, next?.start ?? markdown.length);
  return { found: true, heading: heading.text, level: heading.level, text, bytes: Buffer.byteLength(text, "utf8") };
}
