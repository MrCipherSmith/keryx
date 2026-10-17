// coverage.md: the per-reviewer ingest status `review ingest` writes and readiness item 6 reads. Both halves of the
// format — the mark, the entry layout and its parser — live here, so the writer (managed.ts) and the reader
// (readiness.ts) cannot drift and the writer does not import the checklist.

import type { ReviewCoverageEntry } from "./types";

/**
 * The line `review ingest` writes into coverage.md since flow 460: the file was written from the dispatch record. On a
 * closed package its presence is what keeps readiness item 6's omitted-reviewer check.
 */
export const COVERAGE_MD_MARK = "<!-- keryx: coverage.md written from the dispatch record (flow 460) -->";

/** One `reviewer:` / `status:` entry of coverage.md, the layout {@link renderCoverageEntry} writes. */
const COVERAGE_ENTRY = /reviewer:\s*(\S+)\s*\n\s*status:\s*(\S+)/g;

export function renderCoverageEntry(entry: ReviewCoverageEntry): string {
  return `reviewer: ${entry.reviewer}\nstatus: ${entry.status}\nreason: ${entry.reason}`;
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
