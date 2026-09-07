// AFC-W02 (flow 235) AC8 — `validateTemplateStructure` wired into `wikiValidate`.
//
// MEASURED BEFORE THIS LANE, on a temp wiki holding exactly the `BARE_RULE`
// page below — every mandatory Rule heading filled with real prose, and no
// per-question coverage record anywhere:
//
//     $ keryx wiki validate
//     # gdwiki validate
//
//     All checks passed.
//     exit=0
//
// while calling the validator directly on the same bytes returned
// `[{ kind: "coverage-record-missing", … }]`. Its only consumer was a test.
// That is the criterion's own defect — «количество заполненных headings не
// заменяет проверку ответа» — passing the gate that exists to catch it.
//
// Everything below drives `wikiValidate` (the function `keryx wiki validate`
// and MCP `wiki.query mode=validate` both call), never `validateTemplateStructure`
// directly.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiValidate } from "./service";
import { validateTemplateStructure } from "./template-structure";

async function wikiWith(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-template-validate-"));
  for (const [relative, content] of Object.entries(pages)) {
    const absolute = path.join(root, ".metaproject", "wiki", relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

/** Only the findings this file is about; index/link noise is a different check. */
async function templateIssues(root: string): Promise<Array<{ page: string; kind: string }>> {
  const result = await wikiValidate(root);
  const templateKinds = new Set([
    "field-missing",
    "field-empty",
    "field-scaffold",
    "unknown-without-basis",
    "coverage-record-missing",
    "coverage-verdict-unknown",
    "coverage-basis-missing",
  ]);
  return result.issues
    .filter((issue) => templateKinds.has(issue.kind))
    .map((issue) => ({ page: issue.page, kind: issue.kind }));
}

const COVERAGE_TABLE = `## Questions this page must close

| # | Question | Coverage | Basis |
|---|----------|----------|-------|
| Q1 | Which rule applies when an invoice is unpaid? | covered | \`src/billing/invoice.ts\` refuses the payment and logs it. |
`;

function rulePage(body: string): string {
  return `# Invoice payment rule

Version: 1.0.0
Type: business-rule
Status: accepted

${body}
## Changelog

- 1.0.0 - Authored for this test.
`;
}

const RULE_SECTIONS = `## Scope

Applies to every invoice raised against a customer account in the billing ledger.

## The rule

An invoice is payable only after the goods it covers have been delivered.

## Applicability

It binds from the moment the invoice leaves draft until it is settled or voided.

## Exceptions

A prepaid contract may settle in advance when the contract records the prepayment.

## Authority and acceptance basis

Decided by the billing council on 2026-02-11 and recorded in decisions/billing.md.

## Enforcement references

\`src/billing/invoice.ts\` refuses a payment for an undelivered invoice.

`;

/** Every mandatory heading filled with real prose. No coverage record at all. */
const BARE_RULE = rulePage(RULE_SECTIONS);

/** The same page, with the per-question record the criterion is about. */
const COMPLETE_RULE = rulePage(`${COVERAGE_TABLE}\n${RULE_SECTIONS}`);

test("the wiring reproduces exactly what the unwired validator says about the same bytes", async () => {
  // Ties the CLI-visible finding to the validator's own verdict, so this file
  // cannot pass by reporting some other issue that happens to fire.
  const direct = validateTemplateStructure("business-rule", BARE_RULE).map((i) => i.kind);
  expect(direct).toEqual(["coverage-record-missing"]);

  const root = await wikiWith({ "business-rules/invoice.md": BARE_RULE });
  try {
    expect(await templateIssues(root)).toEqual([
      { page: "business-rules/invoice.md", kind: "coverage-record-missing" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a page whose headings are all filled but which records no verdict FAILS validate", async () => {
  const root = await wikiWith({ "business-rules/invoice.md": BARE_RULE });
  try {
    const result = await wikiValidate(root);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((entry) => entry.kind === "coverage-record-missing");
    expect(issue).toBeDefined();
    // The message says WHY a filled heading is not an answer, not just that a
    // table is absent.
    expect(issue?.message).toContain("a count of filled headings is not");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same page WITH a per-question verdict and basis passes", async () => {
  const root = await wikiWith({ "business-rules/invoice.md": COMPLETE_RULE });
  try {
    expect(await templateIssues(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verdict with no basis is refused — an assertion is not a check", async () => {
  const noBasis = rulePage(
    `## Questions this page must close

| # | Question | Coverage | Basis |
|---|----------|----------|-------|
| Q1 | Which rule applies when an invoice is unpaid? | covered |  |

${RULE_SECTIONS}`,
  );
  const root = await wikiWith({ "business-rules/invoice.md": noBasis });
  try {
    expect(await templateIssues(root)).toEqual([
      { page: "business-rules/invoice.md", kind: "coverage-basis-missing" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verdict outside the closed vocabulary is refused", async () => {
  const badVerdict = rulePage(
    `## Questions this page must close

| # | Question | Coverage | Basis |
|---|----------|----------|-------|
| Q1 | Which rule applies when an invoice is unpaid? | mostly | \`src/billing/invoice.ts\`. |

${RULE_SECTIONS}`,
  );
  const root = await wikiWith({ "business-rules/invoice.md": badVerdict });
  try {
    expect(await templateIssues(root)).toEqual([
      { page: "business-rules/invoice.md", kind: "coverage-verdict-unknown" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reason-bearing section that says bare `unknown` is refused; `unknown - <basis>` is accepted", async () => {
  const bare = rulePage(
    `${COVERAGE_TABLE}\n${RULE_SECTIONS.replace(
      "Decided by the billing council on 2026-02-11 and recorded in decisions/billing.md.",
      "unknown",
    )}`,
  );
  const withBasis = rulePage(
    `${COVERAGE_TABLE}\n${RULE_SECTIONS.replace(
      "Decided by the billing council on 2026-02-11 and recorded in decisions/billing.md.",
      "unknown - no decision record names an author; searching decisions/ returns nothing.",
    )}`,
  );
  const bareRoot = await wikiWith({ "business-rules/invoice.md": bare });
  const basisRoot = await wikiWith({ "business-rules/invoice.md": withBasis });
  try {
    expect((await templateIssues(bareRoot)).map((i) => i.kind)).toEqual(["unknown-without-basis"]);
    expect(await templateIssues(basisRoot)).toEqual([]);
  } finally {
    await rm(bareRoot, { recursive: true, force: true });
    await rm(basisRoot, { recursive: true, force: true });
  }
});

test("the scope is ONE heading wide: a half-written page is still checked for the rest", async () => {
  // The named scoping decision in `validateStructure` says a page is in scope
  // when it carries at least one of its template's headings. This proves that
  // is a low bar and not an all-or-nothing escape: a decision page with a
  // single `## Problem` still gets every other mandatory heading reported.
  const halfWritten = `# Retry limit decision

Version: 0.1.0
Type: decision
Status: draft

## Problem

Webhook deliveries retried forever, so a dead endpoint held a worker for hours.

## Changelog

- 0.1.0 - Half written on purpose.
`;
  const root = await wikiWith({ "decisions/retry.md": halfWritten });
  try {
    const kinds = (await templateIssues(root)).map((issue) => issue.kind);
    // Five remaining mandatory Decision sections, plus the coverage record.
    expect(kinds.filter((kind) => kind === "field-missing").length).toBe(5);
    expect(kinds).toContain("coverage-record-missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the named scoping decision: a page written to a DIFFERENT shape is not accused of failing this one", async () => {
  // The machine-written SAC provenance record — Summary / Details / Provenance,
  // produced by the SAC owner-writer, carrying none of the Decision template's
  // headings. Reporting six missing sections against it would be the validator
  // accusing a page of failing a shape it never claimed. This is a stated
  // decision, and the residual it leaves is stated too: such a page gets no
  // template finding at all.
  const sacRecord = `# SAC: harness integration demo

Version: 0.1.0
Type: decision
Status: draft
Describes: none

## Summary

SAC complements wiki and graph; it does not replace them.

## Details

Recorded via a Shared Agent Context proposal, accepted by a reviewer.

## Provenance

- Source: sac-proposal

## Changelog

- 0.1.0 - Written by the SAC wiki owner-writer.
`;
  const root = await wikiWith({ "decisions/sac-proposal-demo.md": sacRecord });
  try {
    expect(await templateIssues(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("page types with no explanation template are silent, as before", async () => {
  const component = `# Module billing

Version: 0.1.0
Type: component
Status: draft

## Summary

The billing module.

## Details

Nothing here answers a Rule or Decision question, and nothing should ask it to.

## Changelog

- 0.1.0 - Generated.
`;
  const root = await wikiWith({ "components/billing.md": component });
  try {
    expect(await templateIssues(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
