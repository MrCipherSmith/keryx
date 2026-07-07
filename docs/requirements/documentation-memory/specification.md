# Documentation Memory: technical specification

Version: 0.4.0
Status: Phase 1 + reflect/learn-loop (Phase 2, partial) implemented; see section 21. Retrieval is keyword+metadata (embedding-free); embeddings are Phase 3.

## 1. Purpose

Documentation Memory is a Metaproject module for long-term project knowledge.
It stores typed, versioned Markdown entries, builds a local deterministic index,
ranks retrieval by relevance/recency/confidence, reconciles new information
through dedup/conflict checks, and exposes accepted memory as a signal for
`skill-verify-skill` and `gd-metapro skills learn --from-memory`.

## 2. Design decisions (frozen for v1)

| # | Decision | Choice |
|---|---|---|
| D1 | Direction | Memory + skill feedback loop (search, conflict detection, learn). |
| D2 | Source of truth | Markdown in `.metaproject/memory/**`; generated data is derived. |
| D3 | Retrieval (MVP) | Keyword + metadata index with relevance/recency/confidence ranking. Embedding-free and deterministic. Embeddings are a Phase 3 overlay. |
| D4 | Ranking | Documented default weighted formula (relevance + recency + confidence + status + scope); overridable in config. |
| D5 | Ingest lifecycle | Propose-as-`draft` with provenance + dedup/conflict flags; a human accepts. Auto ADD/UPDATE reconcile is Phase 2. |
| D6 | Config location | Separate `.metaproject/memory.config.json`. |
| D7 | Dedup/conflict | Deterministic similarity: title + tag/scope overlap + token Jaccard on summary, with thresholds. Conflict = contradicts an accepted decision/constraint in the same scope. |
| D8 | Retention/decay | Recency decay affects ranking only; Markdown is never auto-deleted; deprecated/superseded are retained for history. |
| D9 | Reflection/consolidation | Deferred to Phase 2. |
| D10 | Search JSON contract | Versioned (`schemaVersion`), stable, validated by gdskills. |
| D11 | Entry types | Typed registry (11 types); MVP templates for `lesson`, `decision`, `constraint`, `known-mistake`. |
| D12 | Skill influence | Only `accepted` entries can affect skills; `draft`/`conflict` are advisory only (contamination prevention). |

## 3. Placement

When enabled, `gd-metapro init` creates:

```text
.metaproject/
  memory.config.json
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
      types.ts
      config.ts
      index.ts
      search.ts
      ingest.ts
      dedup.ts
      README.md
  data/
    memory/
      index/
      artifacts/
        latest.md
        latest.json
      queries/
      raw/
  skills/
    memory/
      SKILL.md
  modules/
    memory.md
```

## 4. Configuration

Config lives in `.metaproject/memory.config.json`; the manifest stores only
`enabled` and paths. Default written on enable:

```json
{
  "schemaVersion": 1,
  "ranking": {
    "weights": { "relevance": 1.0, "recency": 0.5, "confidence": 0.5, "status": 0.5, "scope": 0.5 },
    "recencyDecayPerDay": 0.995,
    "maxResults": 10
  },
  "confidence": { "default": "medium", "values": { "low": 0.34, "medium": 0.67, "high": 1.0 } },
  "statusBoost": { "accepted": 1.0, "draft": 0.4, "conflict": 0.2, "deprecated": 0.1, "superseded": 0.1 },
  "dedup": { "titleSimilarity": 0.8, "summaryJaccard": 0.6, "minSharedScopeOrTags": 1 },
  "ingest": { "defaultStatus": "draft", "allowAutoAccept": false }
}
```

## 5. Source of truth

Markdown files in `.metaproject/memory/**/*.md` are canonical. Generated indexes
and query artifacts live under `.metaproject/data/memory/`. Embeddings, if added
in Phase 3, are optional derived data and never replace Markdown.

## 6. Entry types

| Type | Folder | MVP Template | Purpose |
|---|---|---:|---|
| `lesson` | `lessons/` | yes | Lessons learned from tasks/reviews/incidents |
| `decision` | `decisions/` | yes | Accepted project decisions |
| `constraint` | `constraints/` | yes | Project or module constraints |
| `known-mistake` | `known-mistakes/` | yes | Repeated or costly mistakes to avoid |
| `historical-context` | `historical-context/` | no | Why the project evolved this way |
| `pattern` | `patterns/` | no | Reusable implementation/architecture pattern |
| `task-note` | `task-notes/` | no | Task-specific durable note |
| `review-note` | `review-notes/` | no | Review-derived durable note |
| `incident` | `incidents/` | no | Incident and remediation memory |
| `migration-note` | `migration-notes/` | no | Migration history and pitfalls |
| `integration-note` | `integration-notes/` | no | External integration constraints and history |

## 7. Entry template

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
- Updated: YYYY-MM-DD

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

`Confidence` semantics (default `medium`):

- `high` - accepted decision/constraint, or a lesson confirmed by multiple sources;
- `medium` - a single reliable source (review/health/manual);
- `low` - a single weak observation or a draft proposal.

Ingest sets `Confidence` from the source by default; a human may raise it on accept.

## 8. Status workflow

- `draft` - proposed, advisory only.
- `accepted` - authoritative; can influence `skill-verify-skill`.
- `deprecated` - no longer valid, kept for history.
- `conflict` - contradicts accepted memory; requires resolution; never auto-applies.
- `superseded` - replaced by another entry (linked in `Related`).

Only `accepted` entries can automatically influence skills (contamination
prevention). `draft` and `conflict` are advisory context only.

## 9. Indexing and chunking

`memory index` scans `.metaproject/memory/**/*.md`, parses metadata + headings,
and builds a deterministic inverted index under `data/memory/index/`:

- tokenize `Title + Summary + Details + Tags` (lowercase, split on non-word);
- store per-entry metadata: type, status, confidence, updated date, scopes, tags;
- chunk large `Details` by heading/paragraph for snippet extraction;
- record index freshness (source mtime/hash) for `check`.

## 10. Retrieval and ranking

`memory search "<query>"` ranks entries with a documented, config-weighted score:

```text
score = w.relevance   * relevance(query, entry)
      + w.recency     * recency(entry.updated)
      + w.confidence  * confidence.values[entry.confidence]
      + w.status      * statusBoost[entry.status]
      + w.scope       * scopeMatch(filters, entry.scopes)
```

- `relevance` - normalized keyword overlap (BM25-lite) over title/summary/tags/details, 0-1;
- `recency` - `recencyDecayPerDay ^ daysSince(entry.updated)`, 0-1;
- `confidence` / `status` - table lookups (section 4);
- `scopeMatch` - 1 when `--module/--entity/--status` filters match, else partial/0.

Results are capped at `ranking.maxResults`. Filters:

```bash
gd-metapro memory search "<query>" --module pipelines --entity http-step --status accepted
```

## 11. Ingest lifecycle

```bash
gd-metapro memory ingest --from-job <path>
gd-metapro memory ingest --from-review <path>
gd-metapro memory ingest --from-health <path>
gd-metapro memory ingest --from-skill-verifier <path>
```

Behavior (propose-as-draft, D5):

1. parse the source artifact into candidate entries;
2. attach provenance (source, link, created) and a source-derived `Confidence`;
3. run dedup and conflict checks (section 12);
4. write entries as `draft` (never `accepted` unless `ingest.allowAutoAccept`);
5. print created paths and dedup/conflict warnings.

A human reviews drafts and promotes them to `accepted`. Mem0-style automatic
ADD/UPDATE/DELETE reconciliation is Phase 2.

## 12. Dedup and conflict

Deterministic, offline (D7).

Dedup - two entries are near-duplicates when:

- `titleSimilarity(a, b) >= dedup.titleSimilarity` (normalized edit/trigram similarity), OR
- `jaccard(tokens(a.summary), tokens(b.summary)) >= dedup.summaryJaccard`
  AND they share at least `dedup.minSharedScopeOrTags` scope/tag.

Action: suggest merge or a `Related` link; do not auto-merge.

Conflict - a new `decision`/`constraint` whose scope overlaps an existing
`accepted` `decision`/`constraint` is flagged `conflict` for human resolution.
Semantic contradiction detection beyond scope overlap is advisory (flagged for
review), since deterministic checks cannot prove contradiction. Conflict entries
never influence skills.

## 13. Retention and decay

- Recency decay (section 10) affects ranking only.
- Markdown entries are never auto-deleted; `deprecated`/`superseded` are retained
  for history and rank low via `statusBoost`.
- Pruning is a manual, explicit human action.

## 14. Search output

```text
.metaproject/data/memory/
  artifacts/
    latest.md
    latest.json
  queries/
  raw/
```

Agent-facing `latest.md`: 3-10 ranked snippets with type, status, confidence,
provenance, related module/entity/files/skills, why-matched, and links to raw
entries. Tool-facing `latest.json` carries `schemaVersion`, full ranked results,
chunks, metadata, and scores (versioned contract, D10).

## 15. CLI

```bash
gd-metapro memory new <lesson|decision|constraint|known-mistake> [--title "<t>"]
gd-metapro memory index
gd-metapro memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>]
gd-metapro memory ingest --from-<source> <path>
gd-metapro memory check
gd-metapro memory reflect
```

`check` runs: metadata validation, `Version` field check, link check, dedup
check, conflict check, and index-freshness check; non-zero exit on failures.
`memory reflect` (consolidation) is Phase 2.

## 16. Service contract

```ts
export interface MemoryService {
  create(input: MemoryCreateInput): Promise<MemoryCreateResult>;
  index(input: MemoryIndexInput): Promise<MemoryIndexResult>;
  search(input: MemorySearchInput): Promise<MemorySearchResult>;
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>;
  check(input: MemoryCheckInput): Promise<MemoryCheckResult>;
}
```

`MemorySearchResult` includes `schemaVersion`, ranked entries with scores, and
artifact paths.

## 17. gdskills integration (decoupled)

- Documentation Memory produces `data/memory/artifacts/latest.json`; it does not
  call gdskills at runtime.
- gdskills consumes accepted memory:

```bash
gd-metapro skills learn --from-memory .metaproject/data/memory/artifacts/latest.json
```

- `schemaVersion` is the contract; gdskills validates it.
- Verifier usage: search memory by skill target/module/entity/files; detect
  conflicts between skill instructions and accepted decisions/constraints/known
  mistakes; use accepted lessons/patterns to update skill sections/checklists.
- Only `accepted` entries influence skills; `draft`/`conflict` are advisory.
- Memory-derived skill changes update `skill-changelog.md` with entry ids,
  status, and provenance.

## 18. Orchestrator integration

Orchestrators use Documentation Memory before planning (retrieve accepted
decisions/constraints/known mistakes), after implementation/review (propose
durable lessons/decisions via ingest), and in the final report (mention created
or suggested entries).

## 19. Init flow

`gd-metapro init` asks:

```text
Enable Documentation Memory?
Y. Yes - store lessons, decisions, constraints and known mistakes as searchable Markdown
N. No
```

If enabled: write `.metaproject/memory.config.json`, create memory folders and
templates, module manifest, and `skills/memory/SKILL.md`. Flag: `--no-memory`.

## 20. Git policy

Versioned: `.metaproject/memory/**/*.md`, `.metaproject/memory.config.json`,
`.metaproject/modules/memory.md`, `.metaproject/skills/memory/SKILL.md`.

Ignored: `.metaproject/data/memory/index/**`, `.metaproject/data/memory/artifacts/latest.*`,
`.metaproject/data/memory/raw/**`, `.metaproject/core/memory/**/*.ts`, embedding/vector caches.

## 21. Implementation phases

### Phase 1 - v1 production (implemented)

- [x] `memory.config.json` + init integration (`--no-memory`);
- [x] typed registry + templates + entry validation;
- [x] `memory new`, `memory index`;
- [x] `memory search` with the documented ranking formula and filters;
- [x] `memory ingest` (propose-as-draft + provenance);
- [x] deterministic dedup/conflict + `memory check`;
- [x] versioned layered search output; manifest, module doc, skill.

### Phase 2 - reconcile and consolidation (in progress)

- [x] `memory reflect` - deterministic tag-cluster consolidation into `pattern` drafts;
- [x] `skills learn --from-memory` loop wired (gdskills consumes the versioned search JSON);
- [ ] Mem0-style ingest reconciliation (ADD/UPDATE/supersede);
- [ ] `skill-verify-skill` end-to-end memory usage.

### Phase 3 - semantic

- optional embeddings overlay (hybrid keyword + vector);
- temporal/graph relationships between entries.

## 22. Acceptance criteria (production v1)

- `gd-metapro init` enables Documentation Memory and writes `memory.config.json`.
- `gd-metapro memory new <type>` creates versioned Markdown entries with required metadata.
- `gd-metapro memory index` builds a deterministic local index.
- `gd-metapro memory search` returns layered output ranked by the documented formula, honoring filters and config overrides.
- `gd-metapro memory ingest` writes provenance-tagged `draft` entries with dedup/conflict warnings.
- `gd-metapro memory check` fails on missing metadata, broken links, or a stale index.
- `latest.json` carries `schemaVersion` and is consumable by `gd-metapro skills learn --from-memory`.

## 23. Decision record

Frozen via best-practices research and a two-round interview (see
[brainstorm.md](brainstorm.md) section 5). Decisions D1-D12 are listed in
section 2. Research inputs: Generative Agents retrieval scoring, Mem0
extract/update, Zep temporal lifecycle, MemGuard contamination prevention.
