# Documentation Memory: technical specification

Version: 0.1.0

## 1. Purpose

Documentation Memory is a Metaproject module for long-term project knowledge. It stores structured Markdown entries, builds local indexes, supports compact search output and provides memory signals for `skill-verify-skill`.

## 2. Placement

When enabled, `gd-metapro init` should create:

```text
.metaproject/
  memory/
    index.md
    lessons/
    decisions/
    constraints/
    known-mistakes/
    historical-context/
    patterns/
    templates/
  core/
    memory/
      cli.ts
      index.ts
      search.ts
      ingest.ts
      dedup.ts
      types.ts
      README.md
  data/
    memory/
      index/
      artifacts/
      queries/
      raw/
  skills/
    memory/
      SKILL.md
  modules/
    memory.md
```

## 3. Source of truth

Markdown files in `.metaproject/memory/**/*.md` are the source of truth.

Generated data is stored under `.metaproject/data/memory/`.

Embeddings are optional future generated data and must not replace Markdown as the canonical source.

## 4. Entry types

Typed memory registry:

| Type | Folder | MVP Template | Purpose |
|---|---|---:|---|
| `lesson` | `lessons/` | yes | Lessons learned from tasks/reviews/incidents |
| `decision` | `decisions/` | yes | Accepted project decisions |
| `constraint` | `constraints/` | yes | Project or module constraints |
| `known-mistake` | `known-mistakes/` | yes | Repeated or costly mistakes to avoid |
| `historical-context` | `historical-context/` | no | Why the project evolved this way |
| `pattern` | `patterns/` | no | Reusable implementation or architecture pattern |
| `task-note` | `task-notes/` | no | Task-specific durable note |
| `review-note` | `review-notes/` | no | Review-derived durable note |
| `incident` | `incidents/` | no | Incident and remediation memory |
| `migration-note` | `migration-notes/` | no | Migration history and pitfalls |
| `integration-note` | `integration-notes/` | no | External integration constraints and history |

## 5. Entry template

MVP uses simple Markdown fields:

```markdown
# <Title>

Version: 0.1.0
Type: lesson
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

## Related Scopes

- Module: pipelines
- Entity: http-step
- Files:
  - `src/...`
- Skills:
  - `.metaproject/skills/...`

## Tags

- pipelines
- store

## Changelog

- 0.1.0 - Initial version.
```

## 6. Status workflow

Allowed statuses:

- `draft` - proposed, not authoritative.
- `accepted` - authoritative memory; can affect `skill-verify-skill`.
- `deprecated` - no longer valid but kept for history.
- `conflict` - contradicts accepted memory and requires resolution.
- `superseded` - replaced by another entry.

Only `accepted` entries can automatically update skills according to autonomy policy. `draft` entries are advisory context only.

## 7. CLI

Namespace:

```bash
gd-metapro memory <command>
```

### 7.1 new

```bash
gd-metapro memory new lesson
gd-metapro memory new decision
gd-metapro memory new constraint
gd-metapro memory new known-mistake
```

Behavior:

1. Validate type against registry.
2. Create Markdown entry from template.
3. Set `Version: 0.1.0`.
4. Set `Status: draft` by default.
5. Run dedup/conflict check.
6. Print created path and any warnings.

### 7.2 index

```bash
gd-metapro memory index
```

Behavior:

- scan `.metaproject/memory/**/*.md`;
- parse metadata and headings;
- chunk entries;
- write index to `.metaproject/data/memory/index/`;
- optionally build embeddings if enabled.

### 7.3 search

```bash
gd-metapro memory search "<query>"
gd-metapro memory search "<query>" --module pipelines
gd-metapro memory search "<query>" --entity http-step
gd-metapro memory search "<query>" --status accepted
```

Behavior:

- query local index;
- rank by metadata, text match, related scopes and optional embeddings;
- return compact Markdown summary;
- save full JSON results.

### 7.4 ingest

```bash
gd-metapro memory ingest --from-job <path>
gd-metapro memory ingest --from-review <path>
gd-metapro memory ingest --from-health <path>
gd-metapro memory ingest --from-skill-verifier <path>
```

Behavior:

- parse source artifact;
- propose memory entries;
- attach provenance;
- run dedup/conflict checks;
- write entries as `draft` unless config allows direct accepted entries.

### 7.5 check

```bash
gd-metapro memory check
```

Runs:

- metadata validation;
- version field check;
- link check;
- dedup check;
- conflict check;
- index freshness check.

## 8. Search output

Layered output:

```text
.metaproject/data/memory/
  artifacts/
    latest.md
    latest.json
  queries/
  raw/
```

Agent-facing Markdown includes:

- 3-10 snippets;
- type;
- status;
- confidence;
- provenance;
- related module/entity/files/skills;
- why this entry matched;
- links to raw Markdown entries.

Tool-facing JSON contains full ranked results, chunks, metadata and scores.

## 9. Dedup and conflicts

Dedup suggestions:

- detect similar titles;
- detect overlapping tags/scopes;
- detect near-duplicate summaries;
- suggest merge or `Related` links.

Conflict workflow:

- new entry contradicting accepted `decision` or `constraint` receives `conflict` status or requires resolution;
- conflict entries must not automatically affect `skill-verify-skill`;
- accepted decisions/constraints outrank draft entries.

## 10. Integration with gdskills

Documentation Memory is an official verification signal for `skill-verify-skill`.

Supported command:

```bash
gd-metapro skills learn --from-memory .metaproject/data/memory/artifacts/latest.json
```

Verifier usage:

- search memory by skill target, module, entity, files and related skills;
- detect conflicts between skill instructions and accepted decisions/constraints/known mistakes;
- use accepted lessons/patterns to update skill sections/checklists/templates;
- include draft entries as advisory context only.

Memory-derived skill changes must update `skill-changelog.md` with memory entry ids, status and provenance.

## 11. Integration with orchestrators

Orchestrators should use Documentation Memory:

- before planning, to retrieve accepted decisions/constraints/known mistakes;
- after implementation/review, to propose durable lessons and decisions;
- before final report, to mention created or suggested memory entries.

## 12. Init flow

`gd-metapro init` must ask:

```text
Enable Documentation Memory?

Y. Yes - store lessons, decisions, constraints and known mistakes as searchable Markdown
N. No
```

If enabled, init creates memory folders, templates, module manifest and `skills/memory/SKILL.md`.

## 13. Git policy

Versioned:

- `.metaproject/memory/**/*.md`;
- `.metaproject/modules/memory.md`;
- `.metaproject/skills/memory/SKILL.md`.

Ignored:

- `.metaproject/data/memory/index/**`;
- `.metaproject/data/memory/artifacts/latest.*`;
- `.metaproject/data/memory/raw/**`;
- embedding/vector cache files.

## 14. Acceptance criteria

- `gd-metapro init` can enable Documentation Memory.
- `gd-metapro memory new <type>` creates versioned Markdown entries.
- `gd-metapro memory index` builds local index.
- `gd-metapro memory search` returns compact layered output.
- Dedup/conflict checks exist for new and ingested entries.
- `gd-metapro skills learn --from-memory <path>` can consume accepted memory entries.
