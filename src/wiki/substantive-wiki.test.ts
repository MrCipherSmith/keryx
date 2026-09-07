// AFC-W02 / flow 235 AC8 — "substantive wiki".
//
// The frozen criterion has three clauses and this file asserts all three:
//
//   1. a synthetic page answers a PREDETERMINED why-or-rule question,
//   2. a reason with no source is explicitly `unknown`,
//   3. a page count is never used as completeness.
//
// Clause 1 is asserted through the real retrieval surface (`wikiAsk`, the one
// implementation behind `keryx wiki ask`, MCP `wiki.ask` and the agent
// `wiki_ask` op) over THIS repository's own wiki — never against the section
// index in isolation. The recorded phase-1 failure mode is a capability that
// works in its own module and that no live path calls; a test that asks the
// index directly would reproduce it.
//
// Clause 3 is the hard one to state as a test, because "completeness" is a
// claim about what is MISSING and nothing in this repository can currently
// know that. What is testable is the spec's own operational form of it —
// «количество заполненных headings не заменяет проверку ответа»: a page whose
// mandatory headings are all filled is still not evidence that it answered
// anything, so the structure validator refuses to accept heading presence as
// the check.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { wikiAsk } from "./ask";
import { buildSectionIndex } from "./section-index";
import {
  WIKI_TEMPLATE_CONTRACTS,
  renderGdwikiSkillReadme,
  renderWikiPage,
  renderWikiPageTemplate,
  templateKindForPageType,
} from "./templates";
import { validateTemplateStructure } from "./template-structure";
import type { WikiPage } from "./types";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/**
 * Fixed BEFORE the page was written, per `wiki-specification.md` §4 ("До
 * написания страницы фиксируются вопросы, которые она должна закрыть").
 *
 * Q1 is the question the acceptance criterion names. Q5 is deliberately one
 * this repository has NO source for, so the page has to say `unknown` rather
 * than reconstruct an author's intent from the code — the criterion's second
 * clause needs a real instance, not a hypothetical.
 */
const AUTHORED_RULE_PAGE = "business-rules/code-search-routing.md";
const PREDETERMINED_QUESTION =
  "Which rule applies when an agent runs ripgrep or grep over this project code?";

describe("AC8 clause 1 — a synthetic page answers a predetermined why/rule question", () => {
  test("the authored rule page is the answer `wiki ask` returns for the fixed question", async () => {
    const result = await wikiAsk({ cwd: REPO_ROOT, question: PREDETERMINED_QUESTION });

    // Not "some citation exists": the criterion is that the page ANSWERS the
    // question, so the page that carries the rule has to be the one returned.
    expect(result.status).toBe("ok");
    expect(result.citations[0]?.path).toBe(`wiki/${AUTHORED_RULE_PAGE}`);
  });

  test("the returned evidence carries the rule itself, not just a matching title", async () => {
    const result = await wikiAsk({ cwd: REPO_ROOT, question: PREDETERMINED_QUESTION });
    const top = result.citations[0];

    // A title match is what the corpus already produced before this page
    // existed (`wiki/components/src-rules.md`, the page for the `src/rules`
    // MODULE, scored top for this question). The distinguishing property of an
    // answer is that the cited section states the rule and its routed form.
    expect(top?.contentClass).toBe("substantive");
    expect(`${top?.excerpt} ${result.answerMarkdown}`).toContain("keryx ctx rg");
  });

  test("the page names the enforcing code, so the answer is checkable", async () => {
    const content = await readFile(
      path.join(REPO_ROOT, ".metaproject", "wiki", AUTHORED_RULE_PAGE),
      "utf8",
    );
    expect(content).toContain("src/ctx/hook-classify.ts");
    expect(content).toContain("src/ctx/hook.ts");
  });
});

describe("AC8 clause 2 — a reason with no source is explicitly `unknown`", () => {
  test("the authored page marks its unsourced reason `unknown` rather than reconstructing it", async () => {
    const content = await readFile(
      path.join(REPO_ROOT, ".metaproject", "wiki", AUTHORED_RULE_PAGE),
      "utf8",
    );
    const issues = validateTemplateStructure("business-rule", content);
    expect(issues.map((issue) => issue.kind)).toEqual([]);
    // The instance, not the affordance: this repository records no decision for
    // why the guard denies rather than warns, and the page says so.
    expect(content).toMatch(/unknown\b/i);
  });

  test("an unsourced reason left blank is an issue; `unknown` with a basis is not", () => {
    const filled = renderFilled("business-rule");
    const blanked = filled.replace(
      /## Authority and acceptance basis\n\n[^\n]+\n/,
      "## Authority and acceptance basis\n\n\n",
    );
    expect(kinds(validateTemplateStructure("business-rule", blanked))).toContain("field-empty");

    const declared = filled.replace(
      /## Authority and acceptance basis\n\n[^\n]+\n/,
      "## Authority and acceptance basis\n\nunknown - no decision record in this repository states it.\n",
    );
    expect(kinds(validateTemplateStructure("business-rule", declared))).not.toContain("field-empty");
  });

  test("`unknown` with no basis is refused — the point is the reason, not the word", () => {
    const filled = renderFilled("business-rule");
    const bare = filled.replace(
      /## Authority and acceptance basis\n\n[^\n]+\n/,
      "## Authority and acceptance basis\n\nunknown\n",
    );
    expect(kinds(validateTemplateStructure("business-rule", bare))).toContain("unknown-without-basis");
  });
});

describe("AC8 clause 3 — a page count is never used as completeness", () => {
  test("filled headings alone do not satisfy the validator: the answer check is separate", () => {
    // Every mandatory heading present and non-placeholder, and NO record of
    // whether the questions the page exists to close were actually closed.
    // Counting headings would call this page complete. It is not.
    const withoutCoverage = renderFilled("business-rule").replace(
      /## Questions this page must close\n[\s\S]*?(?=\n## )/,
      "",
    );
    expect(kinds(validateTemplateStructure("business-rule", withoutCoverage))).toContain(
      "coverage-record-missing",
    );
  });

  test("a coverage verdict without a basis is refused", () => {
    const filled = renderFilled("business-rule");
    const noBasis = filled.replace(
      /\| Q1 \|([^|]*)\|([^|]*)\|([^|]*)\|/,
      "| Q1 |$1| covered | |",
    );
    expect(kinds(validateTemplateStructure("business-rule", noBasis))).toContain(
      "coverage-basis-missing",
    );
  });

  test("the four coverage verdicts are the closed spec vocabulary, and nothing else passes", () => {
    for (const verdict of ["covered", "partial", "unknown", "not-applicable"]) {
      const ok = renderFilled("business-rule").replace(
        /\| Q1 \|([^|]*)\|([^|]*)\|/,
        `| Q1 |$1| ${verdict} |`,
      );
      expect(kinds(validateTemplateStructure("business-rule", ok))).not.toContain(
        "coverage-verdict-unknown",
      );
    }
    const bogus = renderFilled("business-rule").replace(
      /\| Q1 \|([^|]*)\|([^|]*)\|/,
      "| Q1 |$1| complete |",
    );
    expect(kinds(validateTemplateStructure("business-rule", bogus))).toContain(
      "coverage-verdict-unknown",
    );
  });

  test("the gdwiki skill tells the agent that a page count is not coverage", () => {
    // `keryx wiki status` prints `total pages: 50` and `keryx wiki context`
    // injects `pages: 50` into every agent turn. Neither line is owned by this
    // lane; the skill text that tells the reader how to read them is.
    const skill = renderGdwikiSkillReadme();
    expect(skill).toContain("not a completeness");
    expect(skill).toMatch(/per-type/i);
  });
});

describe("the four explanation templates carry their mandatory fields (W02 §4)", () => {
  for (const contract of WIKI_TEMPLATE_CONTRACTS) {
    test(`${contract.kind} renders every mandatory field`, () => {
      const rendered = renderWikiPage({
        title: "Example",
        type: contract.pageTypes[0] ?? "business-rule",
        template: contract.kind,
      });
      for (const field of contract.fields) {
        expect(rendered).toContain(`## ${field.heading}`);
      }
      expect(rendered).toContain("## Questions this page must close");
    });
  }

  test("the page type picks its template, and the change guide is reachable", () => {
    expect(templateKindForPageType("user-scenario")).toBe("scenario");
    expect(templateKindForPageType("business-rule")).toBe("rule");
    expect(templateKindForPageType("decision")).toBe("decision");
    // `change-guide` is not one of the eight page types, so it would be a
    // template nothing could render if the shipped template file did not carry
    // it. `keryx init` / `keryx update` write that file.
    expect(renderWikiPageTemplate()).toContain("Change guide");
  });

  test("a freshly created page is scaffold, and the validator says so", () => {
    const fresh = renderWikiPage({ title: "Example", type: "business-rule" });
    // Consumed from the sibling lane's classifier (`buildSectionIndex` →
    // `contentClass`), never re-detected here: one classifier, one verdict.
    const index = buildSectionIndex([{ page: fakePage("business-rules/x.md"), content: fresh }]);
    const mandatory = new Set(
      (WIKI_TEMPLATE_CONTRACTS.find((c) => c.kind === "rule")?.fields ?? []).map((f) => f.heading),
    );
    const bodies = index.sections.filter((section) => mandatory.has(section.title));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((section) => section.contentClass === "scaffold")).toBe(true);
    expect(kinds(validateTemplateStructure("business-rule", fresh))).toContain("field-scaffold");
  });
});

// --- helpers -----------------------------------------------------------------

function kinds(issues: ReadonlyArray<{ kind: string }>): string[] {
  return issues.map((issue) => issue.kind);
}

function fakePage(relativePath: string): WikiPage {
  return {
    absolutePath: path.join(REPO_ROOT, ".metaproject", "wiki", relativePath),
    relativePath,
    pageType: "business-rule",
    title: "Example",
    version: "0.1.0",
    type: "business-rule",
    status: "draft",
    summary: "",
  };
}

/** A rendered template with every placeholder replaced by real prose. */
function renderFilled(type: "business-rule"): string {
  const contract = WIKI_TEMPLATE_CONTRACTS.find((entry) => entry.kind === "rule");
  let out = renderWikiPage({ title: "Example", type });
  for (const field of contract?.fields ?? []) {
    out = out.replace(
      new RegExp(`(## ${field.heading}\\n\\n)[^\\n]*\\n`),
      `$1Real prose about ${field.heading.toLowerCase()}, with a source.\n`,
    );
  }
  out = out
    .replace("One paragraph summary.", "A real summary sentence about the rule.")
    .replace(
      /\| Q1 \|[^\n]*\|/,
      "| Q1 | Which rule applies here? | covered | src/ctx/hook-classify.ts |",
    );
  return out;
}
