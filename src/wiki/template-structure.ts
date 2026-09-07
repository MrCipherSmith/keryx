// AFC-W02 (flow 235) AC8 — structural validation of the four explanation
// templates.
//
// What this checks is deliberately NOT "are the headings present". Heading
// presence is the thing `wiki-specification.md` §4 names as insufficient:
// «количество заполненных headings не заменяет проверку ответа». So the checks
// are, in order of what they are actually for:
//
//   - every mandatory section of the page's template exists,
//   - every mandatory section carries substantive content — decided by the
//     SECTION INDEX'S OWN classifier (`buildSectionIndex` → `contentClass`),
//     never by a second placeholder list written here,
//   - a reason-bearing section with no source says `unknown - <basis>`, and
//     `unknown` on its own is refused, because the point is the basis,
//   - the page records, per pre-registered question, one of
//     `covered | partial | unknown | not-applicable` WITH a basis.
//
// The last one is the executable form of the criterion's third clause. A count
// — of pages, or of filled headings — is never a completeness claim, so the
// validator will not accept structure as evidence that a question was answered.
//
// Pure over its inputs: no I/O. `buildSectionIndex` is likewise pure, so the
// caller supplies the bytes and this function decides.

import { buildSectionIndex, type SectionContentClass } from "./section-index";
import {
  WIKI_COVERAGE_VERDICTS,
  WIKI_QUESTIONS_HEADING,
  templateKindForPageType,
  wikiTemplateContract,
  type WikiTemplateKind,
} from "./templates";
import type { WikiPage, WikiPageType } from "./types";

export type TemplateStructureIssueKind =
  /** A mandatory section of the template is not on the page at all. */
  | "field-missing"
  /** The section exists and its body is empty. */
  | "field-empty"
  /** The section exists and still holds template placeholder text. */
  | "field-scaffold"
  /** A reason-bearing section says `unknown` without saying why there is no source. */
  | "unknown-without-basis"
  /** The page has no record of which questions it was written to close. */
  | "coverage-record-missing"
  /** A question row carries a verdict outside the closed §4 vocabulary. */
  | "coverage-verdict-unknown"
  /** A question row carries a verdict with no basis for it. */
  | "coverage-basis-missing";

export type TemplateStructureIssue = {
  kind: TemplateStructureIssueKind;
  /** The `## ` heading the issue is about, or the question id for a coverage row. */
  subject: string;
  message: string;
};

export type CoverageRow = {
  id: string;
  question: string;
  verdict: string;
  basis: string;
};

/**
 * Validate one page's bytes against the template its page type selects.
 *
 * A page type with no explanation template (architecture, component, service,
 * integration, domain-model — mostly machine-collected) yields no issues:
 * this validator states the contract of the four authored shapes, and silence
 * about the rest is the honest answer, not a pass.
 */
export function validateTemplateStructure(
  pageType: WikiPageType,
  content: string,
  options: { template?: WikiTemplateKind } = {},
): TemplateStructureIssue[] {
  const kind = options.template ?? templateKindForPageType(pageType);
  if (!kind) {
    return [];
  }
  const contract = wikiTemplateContract(kind);
  const issues: TemplateStructureIssue[] = [];

  const sections = indexSections(pageType, content);
  const byHeading = new Map(sections.map((section) => [section.title, section]));

  for (const field of contract.fields) {
    const section = byHeading.get(field.heading);
    if (!section) {
      issues.push({
        kind: "field-missing",
        subject: field.heading,
        message: `the ${contract.label} template requires a \`## ${field.heading}\` section: ${field.prompt}`,
      });
      continue;
    }

    const body = section.body.trim();
    if (section.contentClass !== "substantive") {
      // The class comes from the section index. All this branch adds is WHICH
      // of the two scaffold shapes it is, so the message is actionable.
      issues.push(
        body.length === 0
          ? {
              kind: "field-empty",
              subject: field.heading,
              message: `\`## ${field.heading}\` is empty. ${field.prompt}${
                field.reasonBearing
                  ? " If no source records it, write `unknown - <why there is no source>`."
                  : ""
              }`,
            }
          : {
              kind: "field-scaffold",
              subject: field.heading,
              message: `\`## ${field.heading}\` still holds template placeholder text, so the heading is present and the question is not answered.`,
            },
      );
      continue;
    }

    if (field.reasonBearing && isBareUnknown(body)) {
      issues.push({
        kind: "unknown-without-basis",
        subject: field.heading,
        message: `\`## ${field.heading}\` says \`unknown\` with no basis. Write \`unknown - <why there is no source>\`; do not reconstruct the reason from code.`,
      });
    }
  }

  issues.push(...validateCoverage(sections.find((s) => s.title === WIKI_QUESTIONS_HEADING)?.body));
  return issues;
}

/**
 * The per-question record, or a single `coverage-record-missing` issue.
 *
 * Its absence is a finding in its own right: without it the only thing left to
 * measure is how many headings are filled, which is precisely the substitute
 * the criterion forbids.
 */
function validateCoverage(body: string | undefined): TemplateStructureIssue[] {
  const rows = body === undefined ? [] : parseCoverageRows(body);
  if (rows.length === 0) {
    return [
      {
        kind: "coverage-record-missing",
        subject: WIKI_QUESTIONS_HEADING,
        message:
          `the page records no per-question coverage. A \`## ${WIKI_QUESTIONS_HEADING}\` table ` +
          `with one of ${WIKI_COVERAGE_VERDICTS.join(" | ")} and a basis per question is the ` +
          "answer check; a count of filled headings is not.",
      },
    ];
  }

  const issues: TemplateStructureIssue[] = [];
  for (const row of rows) {
    if (!(WIKI_COVERAGE_VERDICTS as readonly string[]).includes(row.verdict)) {
      issues.push({
        kind: "coverage-verdict-unknown",
        subject: row.id,
        message: `${row.id} has coverage \`${row.verdict}\`, which is not one of ${WIKI_COVERAGE_VERDICTS.join(" | ")}.`,
      });
    }
    if (row.basis.length === 0) {
      issues.push({
        kind: "coverage-basis-missing",
        subject: row.id,
        message: `${row.id} claims \`${row.verdict}\` with no basis. A verdict without a basis is an assertion, not a check.`,
      });
    }
  }
  return issues;
}

/** Rows of the `| # | Question | Coverage | Basis |` table, separator skipped. */
export function parseCoverageRows(body: string): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      continue;
    }
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 4) {
      continue;
    }
    const [id, question, verdict, basis] = cells as [string, string, string, string];
    // Header and separator rows carry no question id of the `Q<n>` shape.
    if (!/^Q\d+$/i.test(id)) {
      continue;
    }
    rows.push({ id, question, verdict: verdict.toLowerCase(), basis });
  }
  return rows;
}

function isBareUnknown(body: string): boolean {
  // `unknown`, `unknown.`, `Unknown` — anything that names the state without
  // saying why the state exists.
  return /^unknown[.\s]*$/i.test(body);
}

type IndexedSection = { title: string; body: string; contentClass: SectionContentClass };

function indexSections(pageType: WikiPageType, content: string): IndexedSection[] {
  const page: WikiPage = {
    absolutePath: "",
    relativePath: `${pageType}/validated.md`,
    pageType,
    title: "",
    version: null,
    type: pageType,
    status: null,
    summary: "",
  };
  return buildSectionIndex([{ page, content }]).sections.map((section) => ({
    title: section.title,
    body: section.body,
    contentClass: section.contentClass,
  }));
}
