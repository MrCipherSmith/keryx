/** Manifest stamp: a package carrying it was ingested after the report began to require an evidence level. */
export const REPORT_FIELD_EVIDENCE_LEVEL = "evidence-level";

export type EvidenceLevelParse =
  | { ok: true; level: "static-only" | "ran"; items: string[] }
  | { ok: false; reason: string };

const LINE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?evidence level\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i;
const SEPARATORS = /^[\s:\u2014\u2013-]+/;

function itemsOf(text: string): string[] {
  return text.split(/[,;]/).map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Reads the `Evidence level:` line of a review report.
 *
 * `static only` must be followed by what did not run, `ran` by what ran: a bare
 * "static only" says nothing a reader can check, which is the defect the field
 * exists to close.
 */
export function parseEvidenceLevel(report: string): EvidenceLevelParse {
  const line = report.split(/\r?\n/).map((l) => LINE.exec(l)).find((m) => m !== null);
  if (!line) return { ok: false, reason: "the report has no `Evidence level:` line" };
  const value = line[1]!.replace(/(?:\*\*|__)\s*$/, "").trim();
  const staticOnly = /^static[ -]only\b/i.exec(value);
  if (staticOnly) {
    const items = itemsOf(value.slice(staticOnly[0].length).replace(SEPARATORS, "").replace(/^(?:did not run|not run|did not)\s*:?\s*/i, ""));
    return items.length > 0 ? { ok: true, level: "static-only", items } : { ok: false, reason: "`static only` must list what did not run" };
  }
  const ran = /^ran\b/i.exec(value);
  if (ran) {
    const items = itemsOf(value.slice(ran[0].length).replace(SEPARATORS, ""));
    return items.length > 0 ? { ok: true, level: "ran", items } : { ok: false, reason: "`ran` must list what ran" };
  }
  return { ok: false, reason: "the evidence level must start with `static only` or `ran`" };
}
