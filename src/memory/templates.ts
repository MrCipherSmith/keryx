import { MEMORY_TYPES } from "./types";

export function renderMemoryEntry({
  title,
  type,
  date,
  confidence = "medium",
  source = "manual",
}: {
  title: string;
  type: string;
  date: string;
  confidence?: string;
  source?: string;
}): string {
  return `# ${title}

Version: 0.2.0
Type: ${type}
Status: draft
Confidence: ${confidence}

## Summary

Short summary.

## Details

Main memory content.

## Provenance

- Source: ${source}
- Link:
- Created: ${date}
- Updated: ${date}

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

## Changelog

- 0.1.0 - Initial version.
`;
}

export function renderMemoryEntryTemplate(): string {
  return `# <Title>

Version: 0.1.0
Type: <lesson|decision|constraint|known-mistake|...>
Status: draft
Confidence: medium

## Summary

Short summary.

## Details

Main memory content.

## Provenance

- Source: review|health|orchestrator|manual|skill-verifier
- Link: <path or URL>
- Created: YYYY-MM-DD
- Updated: YYYY-MM-DD

## Related Scopes

- Module: <module>
- Entity: <entity>
- Files:
  - \`src/...\`
- Skills:
  - \`.metaproject/skills/...\`

## Tags

- <tag>

## Changelog

- 0.1.0 - Initial version.
`;
}

export function renderMemoryIndexScaffold(): string {
  const typeList = MEMORY_TYPES.map(
    (entry) => `- \`${entry.type}\` (\`${entry.folder}/\`)`,
  ).join("\n");

  return `# Project Memory

Version: 0.2.0

## Purpose

Long-term project memory: lessons learned, decisions, constraints, known
mistakes, historical context, and reusable patterns. Markdown is the source of
truth; \`keryx memory index\` optionally builds a disposable generated catalog
for inspection. Search scans canonical Markdown directly and does not depend on
the catalog.

## Entry Types

${typeList}

## Usage

\`\`\`bash
keryx memory new lesson --title "<title>"
keryx memory index [--embeddings]
keryx memory search "<query>" --status accepted [--save-report]
keryx memory transition <path> --to accepted --reason "<reason>"
\`\`\`

Default search is pure and never writes a report. Only \`accepted\`, current,
scoped, bounded projections influence skills; \`draft\` entries are advisory.
`;
}

export function renderMemoryManifest(): string {
  return `# memory

Version: 0.2.0

## Purpose

Long-term, typed project memory with deterministic ranked search and a
gdskills learning signal.

## Commands

- \`keryx memory new <type> --title "<title>"\`
- \`keryx memory index [--embeddings]\` (optional disposable catalog/cache)
- \`keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <class>] [--semantic] [--save-report]\` (pure by default)
- \`keryx memory transition <path> --to <draft|accepted|conflict|deprecated> [--reason <text>]\`
- \`keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]\`
- \`keryx memory ingest --from-<source> <path>\`
- \`keryx memory check\`

## Config

- \`memory.config.json\`

## Data

- \`memory/index.md\`
- \`data/memory/index/index.json\` (disposable generated catalog)
- \`data/memory/embeddings/\` (disposable optional cache)
- \`runtime/memory/search/<run-id>/\` (explicit reports only)

Search reads canonical Markdown directly and never consumes the generated
catalog or writes a legacy global \`latest\` report. Downstream migration from
legacy \`data/memory/artifacts/latest.*\` is advisory and never deletes files or
changes the Git index automatically.

## Skills

- \`skills/memory/\`
`;
}

export function renderMemoryCoreReadme(): string {
  return `# memory Core

Local Documentation Memory service layer.

Responsibilities:

- read typed Markdown entries under \`.metaproject/memory\` (source of truth);
- optionally build a deterministic disposable catalog under
  \`.metaproject/data/memory/index\` (search does not consume it);
- rank search by relevance + recency + confidence + status + scope;
- ingest source artifacts as \`draft\` entries with provenance;
- run deterministic dedup/conflict checks.

Only \`accepted\` entries influence skills. Findings are a decoupled, versioned
contract consumed by gdskills via \`keryx skills learn --from-memory\`.
`;
}

export function renderMemorySkillReadme(): string {
  return `---
name: memory
description: Use for durable project knowledge - past decisions, constraints, known mistakes, lessons, and patterns. Search memory before planning or implementing to avoid repeating mistakes; propose durable entries after tasks.
---

# memory Skill

Use this skill for long-term project experience: accepted decisions,
constraints, known mistakes, lessons, and reusable patterns.

## Workflow

1. Before planning/implementing, run \`keryx memory search "<topic>" --status accepted\`.
2. Read only the returned snippets, not the whole memory.
3. Respect accepted decisions/constraints; treat \`draft\`/\`conflict\` as advisory.
4. After a task/review, propose durable entries with \`keryx memory new\` or \`ingest\`.
5. Run \`keryx memory check\` before relying on cross-entry links.

## Commands

\`\`\`bash
keryx memory search "<query>" --status accepted
keryx memory new lesson --title "<title>"
keryx memory ingest --from-review <path>
keryx memory check
\`\`\`

## Notes

- Only \`accepted\` entries influence skills; \`draft\` are advisory.
- Markdown is the source of truth; generated catalogs, embeddings, and reports
  are disposable and ignored. Default recall does not persist a report.
- Existing legacy \`data/memory/artifacts/latest.*\` files are never deleted or
  changed automatically; init/update report an advisory migration instead.
`;
}
