import type { StructuredReviewFinding } from "./types";

const URL = /\bhttps?:\/\/\S+/gi;
const CITED = /(?<![\w./-])((?:\.\.?\/)*(?:[\w.-]+\/)*[\w.-]+\.(?:mdc|mdx|md|txt|json|ya?ml|toml))(?![\w-])/g;

// A bare file name is a citation only for a root document (README.md, AGENTS.md); research.json, v1.2.json or i.e.md are not.
const ROOT_DOCUMENT = /^[A-Z][A-Z0-9_-]*\.(?:md|mdx|txt)$/;

/** Rule and document paths named in `text`; URLs are not tree paths and are left out. */
export function citedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.replace(URL, " ").matchAll(CITED)) {
    const cited = match[1]!;
    if (cited.includes("/") || ROOT_DOCUMENT.test(cited)) found.add(cited);
  }
  return [...found];
}

const marker = (cited: string) => `citation not found: ${cited}`;

/**
 * Where a rebuttal cites a rule or document that is not in the tree, say so on the finding.
 *
 * The line is appended to the disposition's evidence — the place the dismissal's
 * reasoning is written down — and nothing else is touched: the finding stays, so
 * a reader sees the author's claim and the fact that its source does not exist.
 * Returns how many lines it added; a line already present is not added twice.
 */
export async function flagMissingCitations(
  findings: readonly StructuredReviewFinding[],
  exists: (relative: string) => Promise<boolean>,
): Promise<number> {
  let added = 0;
  for (const finding of findings) {
    const disposition = finding.disposition;
    if (disposition === undefined || typeof disposition.evidence !== "string") continue;
    const missing: string[] = [];
    for (const cited of citedPaths(disposition.evidence)) {
      if (disposition.evidence.includes(marker(cited))) continue;
      if (!(await exists(cited))) missing.push(cited);
    }
    if (missing.length === 0) continue;
    disposition.evidence = `${disposition.evidence}\n${missing.map(marker).join("\n")}`;
    added += missing.length;
  }
  return added;
}
