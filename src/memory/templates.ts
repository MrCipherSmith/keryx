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

Version: 0.1.0
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

Version: 0.1.0

## Purpose

Long-term project memory: lessons learned, decisions, constraints, known
mistakes, historical context, and reusable patterns. Markdown is the source of
truth; \`keryx memory index\` builds a searchable local index.

## Entry Types

${typeList}

## Usage

\`\`\`bash
keryx memory new lesson --title "<title>"
keryx memory index
keryx memory search "<query>" --status accepted
\`\`\`

Only \`accepted\` entries influence skills. \`draft\` entries are advisory.
`;
}

export function renderMemoryManifest(): string {
  return `# memory

Version: 0.1.0

## Purpose

Long-term, typed project memory with deterministic ranked search and a
gdskills learning signal.

## Commands

- \`keryx memory new <type> --title "<title>"\`
- \`keryx memory index\`
- \`keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>]\`
- \`keryx memory ingest --from-<source> <path>\`
- \`keryx memory check\`

## Config

- \`memory.config.json\`

## Data

- \`memory/index.md\`
- \`data/memory/artifacts/latest.md\`

## Skills

- \`skills/memory/\`
`;
}

export function renderMemoryCoreReadme(): string {
  return `# memory Core

Local Documentation Memory service layer.

Responsibilities:

- read typed Markdown entries under \`.metaproject/memory\` (source of truth);
- build a deterministic inverted index under \`.metaproject/data/memory/index\`;
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
- Markdown is the source of truth; never hand-edit generated indexes.
`;
}
