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

## Enriching Collected Drafts (the wiki part)

\`gd-metapro wiki collect\` is deterministic and needs no model: it fills the
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

### Procedure

1. List the drafts to enrich:
   \`\`\`bash
   grep -rl "Status: draft" .metaproject/wiki/components .metaproject/wiki/architecture
   \`\`\`
   Order by importance - largest / most-depended-on modules first (they anchor
   the Project Map). Use the page's \`Reference\` -> \`Depended on by\`.
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
   page human-owned; \`gd-metapro wiki collect --force\` will never overwrite it.
6. Ground every claim in code you read - write "appears to" rather than
   inventing. Then run \`gd-metapro wiki index\`.

\`--force\` regenerates only unmodified drafts, so collect and enrich compose:
re-run collect after code changes, then enrich the newly created drafts.

## Skip When

- The request is a pure code lookup with no architectural/domain/business context.
- \`gd-metapro wiki\` is unavailable.

## Reporting

When wiki context is used, mention which pages were read.
`;
}
