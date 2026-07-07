import { WIKI_PAGE_TYPES, type WikiPageType } from "./types";

export const WIKI_INDEX_BEGIN = "<!-- gd-metapro:wiki-index:begin -->";
export const WIKI_INDEX_END = "<!-- gd-metapro:wiki-index:end -->";

export function renderWikiPage({
  title,
  type,
}: {
  title: string;
  type: WikiPageType;
}): string {
  return `# ${title}

Version: 0.1.0
Type: ${type}
Status: draft

## Summary

One paragraph summary.

## Details

Main content.

## Related Code

- \`src/...\`

## Related Wiki

- [Wiki Index](../index.md)

## Changelog

- 0.1.0 - Initial version.
`;
}

export function renderWikiPageTemplate(): string {
  return `# <Title>

Version: 0.1.0
Type: <page-type>
Status: draft

## Summary

One paragraph summary.

## Details

Main content.

## Related Code

- \`src/...\`

## Related Wiki

- [Other Page](../path/page.md)

## Changelog

- 0.1.0 - Initial version.
`;
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

## Page Types

${typeList}

## Create A Page

\`\`\`bash
gd-metapro wiki new <type> <slug> --title "<title>"
gd-metapro wiki collect
gd-metapro wiki index
\`\`\`

## Pages

${WIKI_INDEX_BEGIN}
<!-- generated: never | pages: 0 -->

_No pages yet. Run \`gd-metapro wiki index\` after creating pages._
${WIKI_INDEX_END}
`;
}

export function renderGdwikiManifest(): string {
  return `# gdwiki

Version: 0.1.0

## Purpose

Project knowledge base from business logic to implementation.

## Commands

- \`gd-metapro wiki status\`
- \`gd-metapro wiki new <type> <slug> --title "<title>"\`
- \`gd-metapro wiki collect [--force] [--limit <n>]\`
- \`gd-metapro wiki index\`
- \`gd-metapro wiki check-links\`
- \`gd-metapro wiki validate\`

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
gd-metapro wiki status
gd-metapro wiki new <type> <slug> --title "<title>"
gd-metapro wiki collect
gd-metapro wiki index
gd-metapro wiki check-links
gd-metapro wiki validate
\`\`\`

## Maintenance

- New pages start at \`Version: 0.1.0\`; bump \`Version\` on every edit.
- Run \`gd-metapro wiki index\` after adding or renaming pages.
- Run \`gd-metapro wiki collect\` to generate safe draft pages from gdgraph, health, and testing context.
- Run \`gd-metapro wiki check-links\` before relying on cross-page links.

## Enriching Collected Drafts

\`gd-metapro wiki collect\` writes rich but generated drafts (\`Status: draft\`):
each module page already lists Public API, Key files, Depends on / Depended on
by, and entry points derived from the graph and source. Turn a draft into real
knowledge:

1. Read the draft's Key files and Public API to understand what the module does.
2. Replace the \`Responsibility\` TODO with 2-4 sentences: what the module owns
   and how it fits the system (use Depends on / Depended on by for context).
3. Add domain and architecture prose the graph cannot infer - key concepts,
   invariants, important flows, and decisions. Link related pages and code.
4. Bump \`Version\` and set \`Status: accepted\` once the page is human-owned.
5. \`gd-metapro wiki collect --force\` regenerates remaining drafts but never
   overwrites accepted or edited pages, so it is safe to re-run later.

Enrich the largest / most-depended-on modules first - they anchor the Project
Map. Verify every claim against source before accepting.

## Skip When

- The request is a pure code lookup with no architectural/domain/business context.
- \`gd-metapro wiki\` is unavailable.

## Reporting

When wiki context is used, mention which pages were read.
`;
}
