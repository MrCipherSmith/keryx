import { WIKI_PAGE_TYPES, type WikiPageType } from "./types";

export const WIKI_INDEX_BEGIN = "<!-- keryx:wiki-index:begin -->";
export const WIKI_INDEX_END = "<!-- keryx:wiki-index:end -->";

// --- explanation templates (AFC-W02, wiki-specification.md §4) ---------------
//
// Four templates, each with the mandatory content the spec's §4 table names,
// plus the thing that table's prose insists on and no heading list can supply:
// the questions the page was written to close, and a per-question verdict.
// «Количество заполненных headings не заменяет проверку ответа» — so the
// coverage table is part of every template, not an optional extra.
//
// The placeholder body is `Main content.` on purpose: it is a member of the
// section index's own PLACEHOLDERS set (`section-index.ts`), so a freshly
// created page classifies as `contentClass: "scaffold"` through the classifier
// that already exists rather than through a second one written here.

export type WikiTemplateKind = "scenario" | "rule" | "decision" | "change-guide";

export type WikiTemplateField = {
  /** The `## ` heading, verbatim. */
  heading: string;
  /** What this section must answer, shown once in the page's guide comment. */
  prompt: string;
  /**
   * True when "nobody wrote the reason down" is a real possible state. Such a
   * field must then say `unknown - <why there is no source>`; reconstructing an
   * author's intent from code is explicitly forbidden by §4.
   */
  reasonBearing?: boolean;
};

export type WikiTemplateContract = {
  kind: WikiTemplateKind;
  label: string;
  /** §4's own verification question for this template. */
  checkQuestion: string;
  /** Page types that select this template; empty when no page type maps to it. */
  pageTypes: WikiPageType[];
  fields: WikiTemplateField[];
};

/** The closed verdict vocabulary from §4. A count is not one of them. */
export const WIKI_COVERAGE_VERDICTS = [
  "covered",
  "partial",
  "unknown",
  "not-applicable",
] as const;
export type WikiCoverageVerdict = (typeof WIKI_COVERAGE_VERDICTS)[number];

export const WIKI_QUESTIONS_HEADING = "Questions this page must close";

export const WIKI_TEMPLATE_CONTRACTS: WikiTemplateContract[] = [
  {
    kind: "scenario",
    label: "Scenario",
    checkQuestion: "How does the operation run, and what is left behind after a failure?",
    pageTypes: ["user-scenario"],
    fields: [
      { heading: "Trigger", prompt: "What starts this, and who or what starts it." },
      {
        heading: "Inputs and preconditions",
        prompt: "What must already be true, and what the operation is given.",
      },
      { heading: "Result", prompt: "The observable outcome when it succeeds." },
      { heading: "Sequence", prompt: "The ordered steps, each attributable to real code." },
      { heading: "Side effects", prompt: "What is written, sent or changed outside the caller." },
      {
        heading: "Exceptions and errors",
        prompt: "Every failure mode, and the state left behind by each.",
      },
      {
        heading: "Code and test references",
        prompt: "The files and tests that make the sequence checkable.",
      },
    ],
  },
  {
    kind: "rule",
    label: "Rule",
    checkQuestion: "Which rule applies in exactly this situation?",
    pageTypes: ["business-rule"],
    fields: [
      { heading: "Scope", prompt: "The situations the rule governs, and the ones it does not." },
      { heading: "The rule", prompt: "The rule itself, in one statement a reader can apply." },
      { heading: "Applicability", prompt: "The conditions under which it binds." },
      { heading: "Exceptions", prompt: "The sanctioned ways out, and what each one requires." },
      {
        heading: "Authority and acceptance basis",
        prompt: "Who decided this, where it is recorded, and on what basis it was accepted.",
        reasonBearing: true,
      },
      {
        heading: "Enforcement references",
        prompt: "The code, hook or gate that enforces it, and what a reader sees when it fires.",
      },
    ],
  },
  {
    kind: "decision",
    label: "Decision",
    checkQuestion: "Why was this approach chosen, and when does the decision stop applying?",
    pageTypes: ["decision"],
    fields: [
      { heading: "Problem", prompt: "The problem the decision was taken against." },
      { heading: "Chosen option", prompt: "What was chosen, stated plainly." },
      {
        heading: "Rejected alternatives and known reasons",
        prompt: "What else was considered and the recorded reason each lost.",
        reasonBearing: true,
      },
      { heading: "Consequences", prompt: "What this costs and what it buys." },
      { heading: "Constraints", prompt: "What the decision now forbids or requires." },
      {
        heading: "Supersession",
        prompt: "What would end this decision, and what supersedes it if anything does.",
      },
    ],
  },
  {
    kind: "change-guide",
    label: "Change guide",
    checkQuestion: "Where is it safe to change behaviour, and what has to be checked?",
    // No page type maps to a change guide today — the eight `WikiPageType`
    // values predate this template. It is reachable through the shipped
    // template file (`wiki/templates/page.md`) that `keryx init` / `keryx
    // update` write, which is why that file carries all four shapes.
    pageTypes: [],
    fields: [
      { heading: "Behaviour before and after", prompt: "What changes, observably." },
      { heading: "Owner and boundary", prompt: "Who owns this and where the boundary runs." },
      { heading: "Change points", prompt: "The specific places a change lands." },
      { heading: "Consumers and tests", prompt: "Who depends on it and what proves it still works." },
      { heading: "Invariants", prompt: "What must remain true through the change." },
      {
        heading: "Rollback and compatibility",
        prompt: "How to undo it, and what stays compatible while it is half-applied.",
      },
    ],
  },
];

/**
 * The template a page type selects, or null for the types that have no
 * explanation shape (architecture, component, service, integration,
 * domain-model — most of which are machine-collected, not authored).
 */
export function templateKindForPageType(type: WikiPageType): WikiTemplateKind | null {
  return (
    WIKI_TEMPLATE_CONTRACTS.find((contract) => contract.pageTypes.includes(type))?.kind ?? null
  );
}

export function wikiTemplateContract(kind: WikiTemplateKind): WikiTemplateContract {
  const contract = WIKI_TEMPLATE_CONTRACTS.find((entry) => entry.kind === kind);
  if (!contract) {
    throw new Error(`Unknown wiki template: ${kind}`);
  }
  return contract;
}

const TEMPLATE_PLACEHOLDER = "Main content.";

function renderQuestionsBlock(contract: WikiTemplateContract): string {
  const guide = [
    "<!--",
    `  ${contract.label} template (wiki-specification.md §4).`,
    `  Check question: ${contract.checkQuestion}`,
    "",
    "  Fix these questions BEFORE writing the body, then answer them.",
    "  A filled heading is not an answer, and a count of filled headings — or of",
    "  pages — is never the completeness check. Every question carries one of",
    `  ${WIKI_COVERAGE_VERDICTS.join(" | ")} AND the basis for that verdict.`,
    "",
    "  A reason nobody wrote down is `unknown - <why there is no source>`.",
    "  Never reconstruct an author's intent from the code.",
    "",
    "  What each section must answer:",
    ...contract.fields.map((field) => `  - ${field.heading}: ${field.prompt}`),
    "-->",
  ].join("\n");

  return [
    `## ${WIKI_QUESTIONS_HEADING}`,
    "",
    guide,
    "",
    "| # | Question | Coverage | Basis |",
    "|---|----------|----------|-------|",
    `| Q1 | ${TEMPLATE_PLACEHOLDER} | unknown | ${TEMPLATE_PLACEHOLDER} |`,
  ].join("\n");
}

function renderTemplateBody(contract: WikiTemplateContract): string {
  return [
    renderQuestionsBlock(contract),
    "",
    ...contract.fields.flatMap((field) => [`## ${field.heading}`, "", TEMPLATE_PLACEHOLDER, ""]),
  ]
    .join("\n")
    .trimEnd();
}

export function renderWikiPage({
  title,
  type,
  template,
}: {
  title: string;
  type: WikiPageType;
  /** Overrides the type's default template; `change-guide` has no type. */
  template?: WikiTemplateKind;
}): string {
  const kind = template ?? templateKindForPageType(type);
  const body = kind
    ? renderTemplateBody(wikiTemplateContract(kind))
    : ["## Details", "", TEMPLATE_PLACEHOLDER].join("\n");

  return `# ${title}

Version: 0.1.0
Type: ${type}
Status: draft

## Summary

One paragraph summary.

${body}

## Related Code

- \`src/...\`

## Related Wiki

- [Wiki Index](../index.md)

## Changelog

- 0.1.0 - Initial version.
`;
}

export function renderWikiPageTemplate(): string {
  const explanations = WIKI_TEMPLATE_CONTRACTS.map(
    (contract) => `## ${contract.label} — \`${contract.kind}\`

Check question: ${contract.checkQuestion}
Page types: ${contract.pageTypes.length > 0 ? contract.pageTypes.map((t) => `\`${t}\``).join(", ") : "none — author it by hand"}

Mandatory sections:

${contract.fields.map((field) => `- \`## ${field.heading}\` — ${field.prompt}`).join("\n")}
`,
  ).join("\n");

  return `# <Title>

Version: 0.1.0
Type: <page-type>
Status: draft

## Summary

One paragraph summary.

## ${WIKI_QUESTIONS_HEADING}

<!-- Fix the questions BEFORE writing the body. A filled heading is not an
     answer, and a count of filled headings — or of pages — is never the
     completeness check. Every question carries one of
     ${WIKI_COVERAGE_VERDICTS.join(" | ")} AND the basis for that verdict.
     A reason nobody wrote down is \`unknown - <why there is no source>\`;
     never reconstruct an author's intent from the code. -->

| # | Question | Coverage | Basis |
|---|----------|----------|-------|
| Q1 | Main content. | unknown | Main content. |

## Details

Main content.

## Related Code

- \`src/...\`

## Related Wiki

- [Other Page](../path/page.md)

## Changelog

- 0.1.0 - Initial version.

---

# Explanation templates (AFC-W02)

Four shapes, from \`docs/requirements/keryx-agent-first-core/wiki-specification.md\` §4.
Replace the \`## Details\` section above with the mandatory sections of the shape
that fits, and keep the question table either way.

${explanations}`;
}

export function renderWikiIndexScaffold(): string {
  const typeList = WIKI_PAGE_TYPES.map(
    (entry) => `- \`${entry.type}\` - ${entry.purpose}`,
  ).join("\n");

  return `# Project Wiki

Version: 0.1.0

## Purpose

This is the local project knowledge base. It stores knowledge that should
outlive a single task: architecture, domain models, business rules, user
scenarios, components, services, integrations, and known decisions.

Read this index first. Do not read every page unless necessary.

## How complete is this wiki

The page count below is a count of files. It is not a completeness measure —
nothing here knows which questions the wiki cannot answer. Read the per-type
counts from \`keryx wiki status\` instead: a type at \`0\` means no page of that
kind exists, and each authored page carries its own
\`## Questions this page must close\` table saying which questions it actually
closed.

## Page Types

${typeList}

## Create A Page

\`\`\`bash
keryx wiki new <type> <slug> --title "<title>"
keryx wiki collect
keryx wiki index
\`\`\`

## Pages

${WIKI_INDEX_BEGIN}
<!-- generated: never | pages: 0 -->

_No pages yet. Run \`keryx wiki index\` after creating pages._
${WIKI_INDEX_END}
`;
}

export function renderGdwikiManifest(): string {
  return `# gdwiki

Version: 0.1.0

## Purpose

Project knowledge base from business logic to implementation.

## Commands

- \`keryx wiki status\`
- \`keryx wiki new <type> <slug> --title "<title>"\`
- \`keryx wiki collect [--force] [--limit <n>]\`
- \`keryx wiki index\`
- \`keryx wiki check-links\`
- \`keryx wiki validate\`

## Page Types

${WIKI_PAGE_TYPES.map((entry) => `- \`${entry.type}\` (\`wiki/${entry.folder}/\`) - ${entry.purpose}`).join("\n")}

## Data

- \`wiki/index.md\`
- \`data/gdwiki/link-check/latest.md\`

## Entry

- \`wiki/index.md\`

## Skills

- \`skills/gdwiki/\`
`;
}

export function renderGdwikiSkillReadme(): string {
  return `---
name: gdwiki
description: Use FIRST for conceptual questions - how something works, why, architecture, domain models, business rules, user scenarios, auth and other flows, integrations, and known decisions. Read wiki/index.md, then use gdgraph to reach code.
---

# gdwiki Skill

## Before you trust a page: check whether it is current

A wiki page is a claim about code that may have moved since anyone checked.
Reading a stale page and generating against it is the failure this whole
mechanism exists to prevent, so consult freshness BEFORE treating a page as
context, not after being wrong.

- MCP: \`wiki_freshness\` (read-only; pass \`page\` to ask about one).
- CLI: \`keryx wiki freshness\` — or read
  \`.metaproject/data/wiki/freshness/latest.json\` directly, which is one file
  and costs nothing.

How to read the answer:

- A page listed \`stale-reference\` has a Reference block that no longer matches
  the graph. Its **prose may still be sound**; its API list is not. Say so
  rather than quoting the list as current.
- A page listed \`stale-prose\` may describe behaviour that changed. Quote it
  with the caveat, and prefer reading the code it names.
- A page listed \`unknown\` has never been verified. That is NOT the same as
  stale, and NOT the same as fresh — nobody has checked.
- **An empty finding list with a non-empty \`limitations\` does not mean the
  wiki is fresh.** It means the check could not run: the graph was not built,
  the symbol layer was unavailable, or there is no git history. Read
  \`limitations\` first, every time.

Repairing is a separate act from reading, and it belongs to a person:
\`keryx wiki refresh\` regenerates Reference blocks deterministically without a
model, and \`keryx wiki verify --page <p>\` records that someone reviewed a
page. Do not stamp provenance on a human's behalf — the field means a person
looked.

## A page count is not coverage

\`keryx wiki status\` prints \`total pages: N\`, \`keryx wiki index\` reports
\`(N pages)\`, and the orientation block injected each turn opens with
\`pages: N\`. Every one of those is a **count of files**, not a completeness
claim: none of them knows which questions the wiki cannot answer, so **it is
not a completeness measure** and must never be quoted as one.

What to read instead:

- The **per-type** breakdown under \`## Pages by type\`. A type at \`0\` means no
  page of that kind exists at all — on this repository, \`business-rule\`,
  \`user-scenario\`, \`domain-model\`, \`service\` and \`integration\` have all
  been \`0\` while the total read \`50\`.
- The page's own \`## Questions this page must close\` table, where each
  question is \`covered\`, \`partial\`, \`unknown\` or \`not-applicable\` with a
  basis. A filled heading is not an answer.
- \`keryx wiki ask\`'s status. \`no-match\` and \`insufficient-evidence\` are
  answers about the corpus; treat them as "the wiki does not cover this", not
  as a gap in your own reading.

Use this skill for project knowledge that is not a literal code detail:
architecture, domain models, business rules, user scenarios, service/component
responsibilities, integrations, and known decisions. The user does not need to
explicitly ask for wiki usage.

## Routing (which skill first)

Pick the entry point by question type:

- Conceptual question - "how does X work", "why", architecture, domain, business rules, user scenarios, auth and other flows, integrations, known decisions - **use gdwiki first**: read \`wiki/index.md\`, open the relevant page, then use gdgraph to jump from that page to code.
- Structural question - "where is X", "what files are related", "what breaks if I change Y", usages, cycles, orphans - **use gdgraph first**; wiki is optional.
- gdctx runs **in parallel** in either case to keep command/search/file-read output compact. It is not a step in the sequence.

## Trigger Examples

- "Как работает авторизация?"
- "Где описан флоу логина / регистрации?"
- "Какие бизнес-правила у платежей?"
- "Объясни архитектуру этого модуля."
- "Какая доменная модель у заказа?"
- "Какие пользовательские сценарии при оплате?"
- "Почему приняли такое решение по интеграции?"
- "За что отвечает этот сервис и какие у него контракты?"

## Workflow

1. Read \`.metaproject/wiki/index.md\` first. It is short and lists every page by type with a summary.
2. Open only the specific pages relevant to the task. Do not read the whole wiki.
3. To move from a wiki concept to code, use \`skills/gdgraph/SKILL.md\` (each page has a \`Related Code\` section).
4. For compact command/search/read output while working, use \`skills/gdctx/SKILL.md\`.
5. Treat wiki pages as curated context. Verify important claims against source code before editing or reporting.

## Commands

\`\`\`bash
keryx wiki status
keryx wiki new <type> <slug> --title "<title>"
keryx wiki collect
keryx wiki index
keryx wiki check-links
keryx wiki validate
\`\`\`

## Maintenance

- New pages start at \`Version: 0.1.0\`; bump \`Version\` on every edit.
- Run \`keryx wiki index\` after adding or renaming pages.
- Run \`keryx wiki collect\` to generate safe draft pages from gdgraph, health, and testing context.
- Run \`keryx wiki check-links\` before relying on cross-page links.

## Enriching Collected Drafts (the wiki part)

\`keryx wiki collect\` is deterministic and needs no model: it fills the
\`## Reference\` section of each page (Public API, Key files, real dependencies)
from the graph and source. The \`## Overview\`, \`## How it works\`,
\`## Key concepts\`, and \`## Main flows\` sections are left as \`Draft -\`
placeholders. Those are the actual wiki - the understanding the graph cannot
express - and they are filled by **this skill**, not by the CLI.

### Model policy - use a cheap model

This is **bounded, mechanical synthesis**: read a module's key files and write
structured prose into fixed sections. It is NOT deep reasoning. Run it on a
**non-flagship / cheap model** (e.g. Haiku, or Sonnet at most) - do not spend a
flagship model on it. If you orchestrate, dispatch **one subagent per page on
the cheap model**; the flagship's job is only to review a sample at the end.

### Work-front

The scaffold is graph-driven and covers the WHOLE project — a page per module at
every nesting depth (\`src/pipelines\`, \`src/pipelines/store\`,
\`src/pipelines/features/pipeline-variables\`, …), so there can be many draft
pages. Do NOT try to enrich all at once — work in priority batches, incrementally.

### Procedure

0. Prepare (deterministic, do this yourself — no subagents):
   \`\`\`bash
   keryx gdgraph build     # fresh symbols + cross-file links (feeds Public API)
   keryx wiki collect      # full scaffold; read its final line:
                           #   "enrichment needed: N component page(s) still Status: draft"
   keryx wiki index
   \`\`\`
   That \`enrichment needed\` count is your work-front. On later commits,
   \`keryx wiki collect --changed --since HEAD~1\` re-scaffolds only the modules
   whose graph shape moved — enrich exactly those.
1. List + order the drafts to enrich:
   \`\`\`bash
   grep -rl "Status: draft" .metaproject/wiki/components .metaproject/wiki/architecture
   \`\`\`
   Order by importance - most-depended-on modules first (they anchor the Project
   Map). Use the page's \`Reference\` -> \`Depended on by\`. Take a batch (e.g. 20);
   leave the rest for the next pass.
2. For each draft page, read the files listed under \`Reference\` -> \`Key files\`
   (they are the highest-connectivity files, i.e. the module's core). Read a few
   more if needed. Do NOT read the whole module.
3. Fill the prose sections from what you read:
   - \`## Overview\` - 2-4 sentences: what the module owns and its purpose.
   - \`## How it works\` - the internal architecture: layers, key abstractions,
     how they relate. Explain the design, do not re-list files.
   - \`## Key concepts\` - the domain vocabulary and core objects.
   - \`## Main flows\` - trace 1-3 concrete flows through the key files.
4. Leave the \`## Reference\` section untouched (it is graph-owned and
   regenerated). Update \`## Summary\` if the overview sharpened it.
5. Set \`Status: accepted\` and bump \`Version\` (e.g. to \`1.0.0\`). This marks the
   page human-owned; \`keryx wiki collect --force\` will never overwrite it.
6. Ground every claim in code you read - write "appears to" rather than
   inventing. When you link related pages, link ONLY to pages that ACTUALLY
   exist - never guess a slug. Verify the target first
   (\`ls .metaproject/wiki/components\` or the wiki index); a module's page slug
   is its path slugified (\`src/lineage\` -> \`src-lineage.md\`, NOT
   \`lineage-graph.md\`). Do not invent \`Related Wiki\` entries or link to
   non-wiki files (e.g. \`CLAUDE.md\`). The graph-derived \`## Reference\` /
   \`Related Code\` links are already correct - reuse those. Broken links from
   guessed slugs are the #1 enrichment defect; run \`keryx wiki check-links\` and
   fix any you introduced.
7. As orchestrator you do NOT read code or write prose yourself — only subagents
   do (one per page, cheap model). When the batch is done, review a sample
   (prose accurate, real symbol names, \`## Reference\` untouched), then run
   \`keryx wiki index\` and \`keryx wiki check-links\`. Report: pages enriched,
   pages still draft, next batch.

\`--force\` regenerates only unmodified drafts, so collect and enrich compose:
re-run collect after code changes, then enrich the newly created drafts.

## Always-on orientation (optional)

To make wiki knowledge always available (not just when the agent remembers to
read the index), install the orientation injector — it adds the wiki index +
code-graph map to the agent's context each turn:

\`\`\`bash
keryx orient install-hook [--runtime <id|all>]   # claude, codex, cursor
keryx wiki context                               # the wiki half of that orientation
\`\`\`

## Skip When

- The request is a pure code lookup with no architectural/domain/business context. Skipping the wiki is fine here — but it does not license raw \`rg\`: the code lookup itself still goes through gdgraph and \`keryx ctx rg\` (see the gdgraph and gdctx skills).
- \`keryx wiki\` is unavailable.

## Reporting

When wiki context is used, mention which pages were read. For non-trivial tasks, record \`wiki_used: pages / not-relevant / unavailable\` as part of the routing audit (see the gdgraph skill's Reporting section).
`;
}
