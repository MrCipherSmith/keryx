// coverage.md: the per-reviewer ingest status `review ingest` writes and readiness item 6 reads. Both halves of the
// format — the mark, the entry layout and its parser — live here, so the writer (managed.ts) and the reader
// (readiness.ts) cannot drift and the writer does not import the checklist.

import type { ReviewCoverageEntry } from "./types";

/**
 * The line `review ingest` writes into coverage.md since flow 460: the file was written from the dispatch record. On a
 * closed package its presence is what keeps readiness item 6's omitted-reviewer check.
 */
export const COVERAGE_MD_MARK = "<!-- keryx: coverage.md written from the dispatch record (flow 460) -->";

/** One `reviewer:` / `status:` entry of coverage.md, the layout {@link renderCoverageEntry} writes: each key starts its line. */
const COVERAGE_ENTRY = /^[ \t]*reviewer:[ \t]*(\S+)[ \t]*\r?\n[ \t]*status:[ \t]*(\S+)/gm;

/** One field as one line: line breaks and control characters become spaces, so a value can never start an entry of its own. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

/** A reviewer name or status as one word: whitespace becomes `_`, so the parser reads exactly what was written. */
const oneWord = (value: string): string => oneLine(value).replace(/\s+/g, "_");

/**
 * One entry; every field is written on its own single line, the name and status as one word (review SEC-005: a line
 * break or a key inside a value cannot forge a `reviewer:` / `status:` pair).
 */
export function renderCoverageEntry(entry: ReviewCoverageEntry): string {
  return `reviewer: ${oneWord(entry.reviewer)}\nstatus: ${oneWord(entry.status)}\nreason: ${oneLine(entry.reason)}`;
}

/** The whole coverage.md: heading, mark, one entry per reviewer. */
export function renderCoverageMd(coverage: readonly ReviewCoverageEntry[]): string {
  return `# Reviewer Coverage

${COVERAGE_MD_MARK}

${coverage.map(renderCoverageEntry).join("\n\n")}
`;
}

/** The reviewer and status of each entry of a coverage.md, in order. */
export function parseCoverageEntries(text: string): Array<{ reviewer: string; status: string }> {
  return [...text.matchAll(COVERAGE_ENTRY)].map((match) => ({ reviewer: match[1]!, status: match[2]! }));
}
