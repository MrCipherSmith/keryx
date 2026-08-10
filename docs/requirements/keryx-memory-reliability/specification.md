# Keryx Memory Reliability Specification
Version: 1.1.0

## Identity

| Field | Value |
|---|---|
| Name | `keryx-memory-reliability` |
| Kind | corrective standard for the existing memory capability |
| Status | verified handoff; release completion pending user-selected flow outcome |
| Owner | Keryx memory module maintainers |
| Canonical durable store | `.metaproject/memory/<type>/*.md` |
| Default retrieval floor | deterministic offline lexical scan |
| Optional ceiling | local embedding rerank through the capability seam |
| Agent influence default | accepted + current + scoped + bounded |
| Read contract | no persistent filesystem mutation |

## Design Principles

1. **Reads are pure.** A tool classified as `read` must not create, modify, or
   delete persistent project data.
2. **Markdown is canonical.** Generated JSON and embeddings are disposable views,
   never a competing source of truth.
3. **Persistence is explicit.** A user asks to create a report or mutate an entry;
   retrieval alone never persists a report.
4. **Automatic influence is authoritative.** Only accepted, current memory may
   direct an agent automatically; diagnostic searches may inspect other states.
5. **One durable write seam.** Validation, security, temporary persistence,
   atomic replacement, and audit metadata apply to every mutation.
6. **Bounded projections cross ports.** Harness/MCP/prompt consumers receive safe
   excerpts, not complete store objects.
7. **Compatibility before novelty.** Keep existing Markdown, operation names, and
   the lexical/no-network floor; avoid new dependencies.

## Current-to-Target Boundary

```text
CURRENT
CLI / harness / MCP / approval
             │
             ▼
  MemoryService.search()
       ├── scan + rank Markdown
       └── overwrite tracked latest.md/json   ← hidden write

TARGET
CLI / harness / MCP / approval
             │
             ▼
  MemoryService.search()                      ← pure
       └── scan + rank Markdown
             │
             ├── bounded result to caller
             └── optional explicit save
                        ▼
              MemoryReportStore.writeRun()    ← ignored runtime artifact
```

## Module Structure

The implementation MAY adjust names, but responsibilities must be separated as
follows:

| Responsibility | Target owner |
|---|---|
| Parse and collect canonical entries | `src/memory/store.ts` |
| Pure filtering/ranking | `src/memory/search.ts` |
| Pure facade orchestration | `src/memory/service.ts` |
| Agent-safe result projection | `src/memory/projection.ts` (new) or adapter-local shared helper |
| Explicit report rendering/persistence | `src/memory/report.ts` (new) |
| Status transition rules | `src/memory/lifecycle.ts` (new) |
| Guarded atomic canonical writes | `src/memory/write.ts` (new) |
| Generated catalog | existing index path, documented as disposable catalog |
| Optional vectors | `src/memory/embedding/**` |

The write seam must not import harness, MCP, flow, or commands. Adapters depend on
memory contracts; memory does not depend on adapters.

## Storage Structure

```text
.metaproject/
  memory.config.json                      # versioned config
  memory/
    index.md                              # versioned human entrypoint
    templates/entry.md                    # versioned template
    lessons/*.md                          # versioned canonical entries
    decisions/*.md
    constraints/*.md
    known-mistakes/*.md
    ...
  data/memory/
    index/index.json                      # generated catalog, optional/ignored
    embeddings/index.meta.json            # generated cache, optional/ignored
    embeddings/vectors.jsonl
  runtime/memory/
    search/<run-id>/report.md              # explicit report, ignored
    search/<run-id>/report.json
    tmp/                                   # same-filesystem atomic-write staging
```

`data/memory/artifacts/latest.md` and `latest.json` are legacy paths. New recall
must not write them. The Keryx repository removes them from version control; init
and update add ignore rules for generated memory data. Downstream migration is
advisory and non-destructive.

## Core Types and Service Contracts

The exact TypeScript shape may be refined during implementation, but it must keep
the following semantic split.

```typescript
export type MemorySearchInput = {
  cwd: string;
  query: string;
  filters?: SearchFilters;
  now?: Date;
};

export type MemorySearchResult = {
  schemaVersion: number;
  query: string;
  results: ScoredEntry[];
};

export type MemoryReportInput = {
  cwd: string;
  search: MemorySearchResult;
  runId?: string;
};

export type MemoryReportResult = {
  runId: string;
  markdownPath: string;
  jsonPath: string;
};

export type MemoryTransitionInput = {
  cwd: string;
  path: string;
  to: "draft" | "accepted" | "conflict" | "deprecated";
  reason?: string;
};

export type MemoryTransitionResult = {
  path: string;
  from: MemoryStatus;
  to: MemoryStatus;
  changed: boolean;
  securitySkipped?: string;
};

export interface MemoryService {
  create(input: MemoryCreateInput): Promise<MemoryCreateResult>;
  search(input: MemorySearchInput): Promise<MemorySearchResult>;       // pure
  writeReport(input: MemoryReportInput): Promise<MemoryReportResult>; // explicit
  transition(input: MemoryTransitionInput): Promise<MemoryTransitionResult>;
  index(input: MemoryIndexInput): Promise<MemoryIndexResult>;         // generated catalog
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>;
  supersede(input: MemorySupersedeInput): Promise<MemorySupersedeResult>;
  check(input: MemoryCheckInput): Promise<MemoryCheckResult>;
}
```

Injectable `now`/`runId` MAY be implemented through service dependencies rather
than public inputs. Tests must not rely on real time or random IDs.

## Agent-Safe Recall Contract

`MetaprojectPort.memorySearch` and all automatic callers use a bounded projection:

```typescript
export type MemoryRecallHit = {
  path: string;            // memory-root-relative only
  title: string;
  type: string;
  status: "accepted";     // automatic surface invariant
  score: number;
  excerpt: string;         // clipped, default max 400 bytes
};
```

Hard bounds:

| Input/output | Default | Hard maximum |
|---|---:|---:|
| General CLI results | config value (currently 10) | 100 |
| Harness/MCP recall hits | 10 | 20 |
| Approval-context hits | 1 | 1 |
| Procedural prompt injection | config value (currently 10) | 20 |
| Agent excerpt | 400 bytes | 2,000 bytes |
| Query | unrestricted legacy behavior | 4,096 UTF-8 bytes after migration |

Absolute paths and full `details` never cross an agent/MCP recall boundary. The
internal `ScoredEntry` may retain the parsed entry for local composition.

## Search Semantics

### General search

- Canonical Markdown is collected on each call.
- Status remains explicitly filterable for human diagnostics.
- If status is omitted by the general CLI/service, current entries of all statuses
  may be inspected for compatibility; adapters must not rely on this default.
- Invalid status/class/date/limit fails validation rather than returning a silent
  empty result.
- Semantic rerank remains opt-in and falls back to lexical results.

### Automatic agent search

Every automatic adapter constructs explicit filters:

```typescript
{
  status: "accepted",
  temporal: "current",
  limit: boundedLimit
}
```

Flow procedural injection additionally restricts configured classes (default
`procedural`) and scope. Skill verification may restrict authoritative types
(`decision`, `constraint`, `known-mistake`).

### Temporal interval

All selectors share one helper implementing:

```text
included(date) = (Valid-From is absent OR Valid-From <= date)
              AND (Valid-To is absent OR date < Valid-To)
              AND (Superseded-By is absent for current queries)
```

Date input is strict `YYYY-MM-DD`; invalid calendar dates fail validation.

## Lifecycle State Machine

```text
                  ┌──────────────┐
                  │   conflict   │
                  └───▲─────┬────┘
                      │     │ review
                      │     ▼
draft ──review────▶ accepted ──retire────▶ deprecated
  ▲          │          │
  └──────────┴──────────┘
       reopen/revise

accepted/draft/conflict/deprecated ──supersede──▶ superseded (terminal)
```

Allowed transitions:

| From | Allowed targets |
|---|---|
| `draft` | `accepted`, `conflict`, `deprecated` |
| `accepted` | `draft`, `conflict`, `deprecated` |
| `conflict` | `draft`, `accepted`, `deprecated` |
| `deprecated` | `draft` |
| `superseded` | none through transition; only idempotent supersede observation |

Transitioning to the current state returns `changed: false`. Each changed entry:

- sets `Status`;
- sets or inserts `Recorded-At` when absent;
- updates provenance `Updated`;
- appends a changelog record with from/to/date/reason;
- passes metadata validation and `guardOutput`;
- is atomically replaced.

Automatic acceptance is forbidden. Ingest and reflect produce drafts regardless
of legacy `allowAutoAccept` configuration.

## Guarded Atomic Write Contract

All durable entry mutations use a shared seam with this order:

1. resolve and confine the target under `.metaproject/memory/`;
2. construct the complete next Markdown value in memory;
3. parse and validate the next value;
4. invoke `guardOutput` with target `memory`;
5. write a same-directory temporary file;
6. flush/close and atomically rename it over the target;
7. clean up temporary data on failure;
8. return a structured written/skipped/error outcome.

For supersession, both next values and both security decisions are prepared before
canonical replacement. The implementation must use a rollback-capable two-file
strategy so recoverable failure does not leave only one side changed. Neither
canonical file is deleted.

## Report Contract

Explicit report runs use a collision-resistant deterministic/injectable run ID,
for example `2026-08-10T12-00-00-000Z-0001`. A run directory is immutable after
successful publication.

`report.json` validates against
[`memory-search-report.schema.json`](schemas/memory-search-report.schema.json) and
contains only:

```jsonc
{
  "schemaVersion": 1,
  "runId": "...",
  "query": "...",
  "generatedAt": "...",
  "filters": { "status": "accepted" },
  "results": [
    {
      "path": "decisions/example.md",
      "title": "Example",
      "type": "decision",
      "status": "accepted",
      "score": 1.25,
      "reason": "...",
      "summary": "bounded excerpt"
    }
  ]
}
```

No absolute path or full details are persisted. The Markdown report follows the
same bounds. Publication uses temporary files and directory-level completion only
after both formats are valid.

## Catalog and Embedding Contracts

### Catalog (`memory index`)

- remains a generated metadata snapshot for compatibility and dashboards;
- is not read by default lexical recall;
- is ignored by Git;
- can be deleted and regenerated;
- absence is not a `memory check` failure;
- corrupt/stale presence may produce a warning with a regeneration command.

The CLI name `memory index` remains during this corrective scope. Documentation
calls its output a **catalog snapshot**, not a runtime or inverted index. A future
deprecation/alias is a separate decision.

### Embeddings

- remain disabled by default;
- remain derived from canonical entries and content hashes;
- remain ignored by Git and disposable;
- never cause canonical writes;
- degrade to lexical recall on missing/corrupt/unavailable capability.

## Configuration Contract

The effective config retains ranking, confidence, status boost, dedup, reflect,
embedding, temporal, and typing sections. Corrective rules:

- `ranking.maxResults` must be an integer within `1..100`;
- `typing.injectLimit` must be an integer within `0..20`;
- `typing.injectClasses` must contain known classes;
- `temporal.defaultQuery` must be `current` or `as-of`;
- `ingest.defaultStatus` must resolve to `draft` for automatic ingest;
- legacy `ingest.allowAutoAccept: true` emits a deprecation warning and is ignored;
- the unused `MemoryTypeConfig.template` field is removed, or code enforces it and
  docs list only permitted types. The recommended implementation removes the flag
  and treats all known types as manually creatable.

Deep merge with defaults remains supported for older config files.

## CLI Surface

Existing commands remain, with changed/default behavior clearly marked:

```text
keryx memory new <type> [slug] --title <title> [--force]
keryx memory index [--embeddings]                         # generated catalog
keryx memory search <query> [filters] [--json]            # pure by default
keryx memory search <query> [filters] --save-report       # explicit runtime report
keryx memory transition <path> --to <status> [--reason]
keryx memory accept <path> [--reason]                     # optional alias
keryx memory deprecate <path> [--reason]                  # optional alias
keryx memory conflict <path> [--reason]                   # optional alias
keryx memory supersede <old> --by <new> [--date]
keryx memory ingest --from-<source> <path>
keryx memory check
keryx memory reflect [--narrate] [--provider]
```

`transition` is required. Convenience aliases are recommended but may be deferred
if help and examples make the canonical command clear. Planned commands must not
be documented as implemented until code and tests exist.

Default search output no longer prints `report:` or `json:`. With
`--save-report`, both paths are printed. `--json` writes only stdout unless
combined with `--save-report`.

## Integration Contracts

| Consumer | Target behavior |
|---|---|
| `MetaprojectPort.memorySearch` | pure service call; explicit accepted/current filters; bounded projection |
| unified `memory_search` operation | remains `risk: "read"`; purity test enforces no write |
| MCP `memory.search` | remains `mutating: false`; accepted/current default; bounded structured response |
| shell approval context | accepted/current limit 1; no artifact write; status remains observable in internal result |
| flow related memory | accepted/current only for automatic guidance; optional drafts must be separately labeled advisory |
| flow procedural injection | accepted/current/procedural/scoped and bounded |
| gdskills verification | accepted/current authoritative types; no dependency on a `latest` artifact |
| dashboard/status | reads catalog/runtime reports only when present; treats them as optional/stale-able |

No integration may use the existence of legacy `latest.*` as proof that memory was
consulted. Verification must call the pure selector or record an explicit
structured consultation signal.

## Git and Migration Contract

Managed ignore templates add:

```gitignore
.metaproject/data/memory/index/
.metaproject/data/memory/embeddings/
.metaproject/data/memory/artifacts/
.metaproject/runtime/memory/
```

The broader `.metaproject/runtime/` rule may already cover the final entry.

For the Keryx repository implementation commit, legacy tracked search artifacts
are removed from version control. For downstream repositories:

- `keryx init/update` updates ignore rules;
- Keryx does not invoke `git rm`, delete files, or rewrite user-authored memory;
- migration output explains how a maintainer may untrack legacy artifacts;
- old artifacts may remain on disk but are never read as canonical memory.

## Error Contracts

| Condition | Required outcome |
|---|---|
| invalid search status/class/limit/date | non-zero CLI result or structured validation error; no write |
| missing memory root | empty recall for read paths; create initializes required type folder |
| report collision | generate another run ID or fail without overwrite |
| security advisory finding | write proceeds with bounded warning |
| security enforced/CI block | canonical files unchanged; structured skipped result |
| parse-invalid next entry | fail before guard/write |
| embedding failure | lexical result returned |
| catalog missing/corrupt | recall unaffected; check warning only if appropriate |
| transition from terminal state | actionable error; byte-identical entry |
| partial temp/report file | ignored and cleanable; never treated as published run |

## Compatibility Requirements

- Existing entry headers and folders continue to parse.
- Missing class resolves through the existing type map.
- Missing temporal fields remain open/current unless superseded.
- Tool names `memory_search` and `memory.search` remain stable.
- Existing explicit status filters retain their meanings.
- Optional embedding output order remains covered by existing tests.
- Existing report consumers must migrate to `writeReport` or to structured search
  results; legacy latest paths receive no new writes.

## Acceptance Traceability

| PRD criterion | Specification sections | Primary verification |
|---|---|---|
| AC-1 | Core Types, Integration Contracts | filesystem snapshot tests across five surfaces |
| AC-2 | Report Contract, Storage | unique-run and Git-ignore tests |
| AC-3/4 | Agent-Safe Recall, Search Semantics | adapter/MCP/flow/approval fixtures |
| AC-5/6 | Lifecycle State Machine | transition table and idempotency tests |
| AC-7 | Guarded Atomic Write | injected failure/rollback test |
| AC-8 | Temporal interval | shared boundary fixture |
| AC-9 | Git and Migration | init/update `.gitignore` tests |
| AC-10 | Compatibility | legacy fixture and lexical golden tests |
| AC-11 | Embeddings | existing no-network/capability fallback tests |
| AC-12 | CLI/Integration/Compatibility | docs, help, registry, and docpack review |

## Machine-Readable Contracts

- [Memory Search Report Schema](schemas/memory-search-report.schema.json) — the
  bounded, portable contract for an explicitly persisted report. It forbids
  unlisted properties and caps query, result count, paths, reasons, and summaries.

## Planned File Impact

Expected implementation paths include:

- `src/memory/service.ts`, `types.ts`, `search.ts`, `config.ts`, `check.ts`;
- new `src/memory/report.ts`, `lifecycle.ts`, `write.ts`, and targeted tests;
- `src/memory/ingest.ts`, `reflect.ts`, `supersede.ts`, `relevant.ts`, `inject.ts`;
- `src/commands/memory.ts`, `agent-approval-context.ts`;
- `src/harness/tool/metaproject-adapter.ts`, `metaproject-operations.ts`, built-in
  metaproject tools, and their tests;
- `src/mcp/tools.ts`, `src/mcp/metaproject-tools.ts`, MCP tests;
- `src/flow/context.ts`, gdskills verification and tests;
- `src/commands/init.ts`, `src/lib/templates.ts`, init/update tests, `.gitignore`;
- CLI/module/architecture/setup docs and `.metaproject/wiki/components/src-memory.md`.

The graph must be refreshed after code implementation, not for this specification-only
package.
