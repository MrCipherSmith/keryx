# PRD: Keryx Memory Reliability
Version: 1.1.0

## 1. Overview

Keryx has a capable Markdown-first project-memory module, but its read and write
boundaries are inconsistent. A search advertised as read-only writes tracked
`latest` artifacts, automatic agent recall can observe non-accepted entries, the
derived index is not used by search despite its name, generated data is not
consistently ignored, and durable status changes require manual file edits.

This initiative makes memory recall side-effect-free, durable writes explicit and
security-gated, automatic agent influence accepted-only, generated data disposable,
and the implementation/documentation contracts mutually consistent.

## 2. Context

| Field | Value |
|---|---|
| Product | Keryx CLI, project agent harness, and Metaproject modules |
| Module | `src/memory`, plus harness/MCP/flow/approval integrations |
| Primary users | project maintainers, interactive-agent users, MCP clients, flow and skill authors |
| Tech stack | Bun, TypeScript, Markdown files, JSON artifacts, optional local embeddings |
| Current source of truth | `.metaproject/memory/<type>/*.md` |
| Current recall | deterministic lexical scan with optional embedding rerank |
| Current status | implemented with corrective reliability work required |

### Users and needs

- **Interactive-agent user** — needs read-only tools to leave the repository
  unchanged and automatic advice to come only from approved knowledge.
- **Project maintainer** — needs explicit, reviewable lifecycle commands and a
  clean Git worktree after searches.
- **Skill/flow author** — needs bounded, current, scoped memory injection with a
  stable contract.
- **MCP client/runtime** — needs `mutating: false` to mean no persistent write.
- **Security/release maintainer** — needs all durable writes to pass the same
  guard, validation, and atomicity rules.

## 3. Problem Statement

The existing memory service combines two responsibilities in `search()`:
retrieving memory and persisting a global report. Consequently, a harness or MCP
tool declared as read-only changes files. The impact is amplified because approval
context performs an automatic memory search before shell approvals.

The surrounding lifecycle has additional inconsistencies:

1. generated search reports are tracked while comparable health/testing reports
   are ignored;
2. `memory index` produces a metadata snapshot that runtime search never reads;
3. default agent-facing recall is not consistently restricted to `accepted` and
   current entries;
4. no supported command promotes a draft to accepted or marks it deprecated or
   conflicting;
5. write paths do not all share the same security/atomic-write seam;
6. current and point-in-time temporal boundaries disagree on `Valid-To` day;
7. search-report JSON can expose full entries and absolute local paths;
8. one global `latest` report is race-prone across concurrent agents.

Together these issues make it difficult to trust tool risk classification,
repository cleanliness, automatic advice, and the durable history itself.

## 4. Goals

- **G-1:** Make every default memory recall path observably side-effect-free.
- **G-2:** Preserve Markdown as the only durable source of truth.
- **G-3:** Ensure automatic agent influence uses only accepted, current, scoped
  memory and remains bounded.
- **G-4:** Provide explicit, validated, auditable lifecycle transitions.
- **G-5:** Apply one security-gated and atomic write policy to every durable
  memory mutation.
- **G-6:** Define a coherent lifecycle for reports, catalogs, and embedding caches.
- **G-7:** Preserve deterministic offline lexical recall and optional embedding
  fallback behavior.
- **G-8:** Deliver migration, tests, documentation, and measurable gates that let
  implementation progress be tracked safely.

## 5. Non-Goals

- A database, daemon, cloud service, vector database, or remote synchronization.
- Automatic acceptance of ingested or reflected knowledge.
- Mandatory semantic search or a new production model/runtime dependency.
- Whole-store prompt injection or unbounded context expansion.
- A general redesign of ranking quality, stemming, multilingual retrieval, or
  ontology management.
- Redesigning other modules' artifact systems except where shared init/update
  templates must remain consistent.
- Treating a JSON catalog as a new source of truth.

## 6. Functional Requirements

### FR-1 — Pure search service

`MemoryService.search()` MUST return ranked results without creating, modifying,
or deleting any file. Its result contract MUST NOT require report paths.

### FR-2 — Explicit report persistence

Report rendering and persistence MUST be a separate operation. The CLI MAY expose
`memory search --save-report`, but default CLI, harness, MCP, flow, approval, and
skill recall MUST NOT persist a report.

Explicit reports MUST be immutable per-run artifacts under an ignored runtime
root; they MUST NOT overwrite a repository-global tracked `latest` file.

### FR-3 — Generated-data policy

Init/update Git policy MUST distinguish:

- versioned: `.metaproject/memory/**/*.md` and `memory.config.json`;
- generated/disposable: search reports, catalog/index snapshots, embeddings,
  temporary files, and locks.

Existing tracked `data/memory/artifacts/latest.*` MUST be retired through a
documented migration without deleting user-authored memory entries.

### FR-4 — Agent-facing accepted-only recall

Harness, MCP, approval context, flow automatic recall, and skill verification
MUST default to `status=accepted` and current temporal validity. Draft, conflict,
deprecated, expired, and superseded entries MUST NOT automatically direct an
agent. Explicit human/diagnostic searches MAY request those states.

### FR-5 — Bounded safe recall DTO

Agent/MCP recall MUST return a bounded projection containing relative path,
title, type, status, score, and a clipped summary. It MUST omit absolute paths and
full details by default. Limits and excerpt sizes MUST be validated and capped.

### FR-6 — Lifecycle transition service

The memory service MUST support explicit validated transitions for `draft`,
`accepted`, `conflict`, and `deprecated`; `superseded` remains controlled by the
existing supersede operation. CLI commands MUST expose those transitions without
requiring manual metadata edits.

Every successful transition MUST update provenance time, append a changelog note,
be idempotent, and return a structured result.

### FR-7 — Unified guarded write seam

Create, ingest-create, ingest-reconcile, reflect, lifecycle transition, and
supersede MUST use a shared write seam that performs validation, security guarding,
temporary-file persistence, and atomic replacement. Multi-entry supersession MUST
not leave only one side updated after a recoverable failure.

### FR-8 — Temporal consistency

All current and `--as-of` selection paths MUST implement the same half-open
interval: `Valid-From <= queryDate < Valid-To`. A `Valid-To` equal to today MUST
not be current. Invalid dates MUST fail with an actionable validation error.

### FR-9 — Catalog/index semantics

Runtime recall MUST continue to scan canonical Markdown. `memory index` MAY remain
as a backward-compatible generated catalog, but documentation and types MUST not
describe it as an inverted/runtime search index. `memory check` MUST not fail only
because the optional catalog is absent; if present, staleness may be reported as a
warning.

### FR-10 — Configuration cleanup

Unused or misleading config/type fields MUST be resolved explicitly:

- automatic acceptance remains prohibited; legacy `allowAutoAccept` is removed or
  reported as deprecated and MUST never silently enable acceptance;
- memory-type creatability and the unused `template` flag are aligned in code and
  documentation;
- status, class, limit, and temporal inputs are strictly validated.

### FR-11 — Compatibility and migration

Existing valid Markdown entries MUST parse and search unchanged. Existing CLI
search output MUST remain compatible except for report-path lines being absent by
default. MCP and harness tool names MUST remain stable. Optional embeddings MUST
continue to degrade to lexical search without failure.

### FR-12 — Documentation alignment

CLI reference, module documentation, architecture documentation, setup workflows,
Metaproject templates, and the accepted memory wiki page MUST describe the final
implemented behavior and distinguish source data from disposable artifacts.

### FR-13 — Verification and observability

Tests MUST prove filesystem purity, accepted-only automatic influence, lifecycle
validation, security coverage, temporal boundaries, migration behavior, bounded
DTOs, concurrency-safe reports, and lexical fallback. The implementation MUST add
no production dependency.

## 7. Non-Functional Requirements

- **NFR-1 Determinism:** identical store, query, filters, config, and injected time
  produce identical ordered recall results.
- **NFR-2 Offline floor:** default search and the full test suite require no
  network or external model.
- **NFR-3 Performance:** default search remains one bounded local Markdown scan;
  report persistence adds zero work unless explicitly requested.
- **NFR-4 Repository hygiene:** repeated default searches leave `git status`
  unchanged, including harness, MCP, and approval-context paths.
- **NFR-5 Security:** no durable memory write bypasses output guarding; agent-facing
  projections omit absolute paths and unbounded details.
- **NFR-6 Concurrency:** explicitly saved reports use unique run identifiers and
  atomic files; parallel searches cannot overwrite one another.
- **NFR-7 Portability:** behavior is consistent on supported macOS/Linux runtimes;
  no symlink-only `latest` mechanism is required.
- **NFR-8 Backward compatibility:** existing memory Markdown and stable tool names
  remain supported.
- **NFR-9 Bounded context:** automatic recall respects configured and hard maximum
  entry/excerpt limits.
- **NFR-10 Testability:** clocks, report IDs, filesystem seams, and security guards
  are injectable where deterministic tests require them.

## 8. Constraints

- Markdown remains the canonical database and must remain human-editable and
  Git-diffable.
- `risk: "read"` and MCP `mutating: false` are strict no-persistent-write
  contracts.
- Accepted-only automatic influence is stricter than general interactive search.
- Embeddings remain an optional capability ceiling; lexical search is the floor.
- The fix must preserve the existing `MetaprojectPort`, unified operation names,
  and approval gate behavior.
- Keryx update/init MUST not silently delete user files or run destructive Git
  commands in downstream repositories.
- No production dependency may be added for report storage, locking, validation,
  or lifecycle transitions.
- Documentation status must distinguish existing behavior from planned fixes.

## 9. Edge Cases

- Empty memory store and absent generated directories.
- An existing repository still tracks legacy `latest.md/json` artifacts.
- Concurrent harness and MCP searches for different queries.
- `--json` search output without `--save-report`.
- Invalid `--status`, `--class`, `--limit`, `--as-of`, or transition target.
- Transition repeated to the current state.
- Transition requested from or to terminal `superseded` state.
- Supersession where the second write fails after both outputs were validated.
- Ingest reconciliation of an accepted entry containing guarded content.
- Entry with `Valid-To` equal to the query date.
- Legacy entry without class or temporal headers.
- Missing/corrupt embedding cache or unavailable embedding runtime.
- Very large summary/details content and an agent-facing result limit above cap.
- Explicit report persistence interrupted before atomic rename.
- Generated catalog present but stale or corrupt.

## 10. Acceptance Criteria (Gherkin)

### AC-1 — Default search is filesystem-pure

```gherkin
Scenario: Search through every read-only surface leaves the repository unchanged
  Given a project with accepted and draft memory entries
  And a snapshot of all project file paths, contents, and Git status
  When the same query is executed through MemoryService, CLI, harness, MCP, and approval context
  Then each surface returns a bounded result
  And no project file is created, modified, or deleted
  And Git status equals the original snapshot
```

### AC-2 — Report persistence is explicit and isolated

```gherkin
Scenario: A user explicitly saves a search report
  Given memory report persistence is not requested by default
  When the user runs memory search with --save-report twice
  Then two unique immutable report runs are created under the ignored runtime root
  And neither run overwrites the other
  And neither report is tracked by Git
```

### AC-3 — Automatic recall is accepted-only

```gherkin
Scenario Outline: Non-authoritative memory cannot automatically influence an agent
  Given a matching memory entry has status <status>
  When recall runs through harness, MCP, approval context, flow injection, or skill verification
  Then that entry is not returned as automatic guidance

  Examples:
    | status     |
    | draft      |
    | conflict   |
    | deprecated |
    | superseded |
```

### AC-4 — Accepted current memory remains available

```gherkin
Scenario: Scoped accepted procedural memory is injected within limits
  Given more accepted current procedural entries match a flow scope than the configured limit
  When flow context is assembled
  Then only the highest-priority bounded set is injected
  And every injected entry is accepted and current
  And no full entry details or absolute paths are injected
```

### AC-5 — Lifecycle transitions are validated and auditable

```gherkin
Scenario: A reviewed draft is accepted through the supported lifecycle
  Given a valid draft memory entry
  When the maintainer transitions it to accepted
  Then its status becomes accepted
  And its updated timestamp and changelog record the transition
  And repeating the same transition is an idempotent no-op
  And the write passes validation and the security guard
```

### AC-6 — Invalid lifecycle changes fail closed

```gherkin
Scenario: A superseded entry cannot be manually reactivated
  Given a memory entry has status superseded
  When a transition to accepted is requested
  Then the command fails with an actionable state-transition error
  And the entry content remains byte-identical
```

### AC-7 — Supersession is pair-consistent

```gherkin
Scenario: A recoverable write failure cannot leave half a supersession
  Given an old and a new valid memory entry
  And persistence fails before both replacements can commit
  When supersession is attempted
  Then neither canonical entry reflects a partial supersession
  And the command reports failure without deleting either entry
```

### AC-8 — Temporal boundaries agree

```gherkin
Scenario: Valid-To is an exclusive boundary everywhere
  Given an entry has Valid-To equal to 2026-08-10
  When current recall runs on 2026-08-10
  And an as-of recall runs for 2026-08-10
  Then neither recall includes the entry
```

### AC-9 — Generated data is disposable

```gherkin
Scenario: Initialization applies the memory generated-data policy
  Given a newly initialized Keryx project
  When catalog, embedding, and explicit report artifacts are generated
  Then those artifacts match the managed Git ignore rules
  And user-authored memory Markdown remains eligible for version control
```

### AC-10 — Legacy Markdown remains compatible

```gherkin
Scenario: A pre-typing memory entry remains searchable
  Given a valid legacy entry without Class, Valid-From, Valid-To, or Recorded-At
  When default lexical search runs after the upgrade
  Then the entry parses using the type-to-class fallback
  And its result is equivalent to the pre-upgrade lexical contract
```

### AC-11 — Optional embeddings still fail soft

```gherkin
Scenario: Semantic recall degrades to lexical when capability resolution fails
  Given semantic recall is requested
  And the embedding runtime or verified model asset is unavailable
  When search runs
  Then the lexical results are returned successfully
  And no durable memory entry is modified
```

### AC-12 — Documentation and contracts agree

```gherkin
Scenario: Release verification finds one coherent memory contract
  Given the corrective implementation is complete
  When CLI help, module docs, architecture docs, wiki, templates, and tool descriptors are inspected
  Then search is described as pure by default
  And report persistence is described as explicit
  And catalog data is not described as the runtime source of truth
  And all read-only tool descriptors match observed filesystem behavior
```

## 11. Verification

Verification is defined in detail in
[Metrics and Validation](metrics-and-validation.md) and tracked per phase in
[Implementation Plan](implementation-plan.md). At minimum it includes:

- unit tests around pure search, temporal validity, lifecycle transitions,
  report writing, guard invocation, and atomic replacement;
- integration tests for CLI, harness, MCP, flow, and approval context;
- filesystem snapshot and Git-status assertions for every read-only surface;
- generated `.gitignore` tests for reports, catalog, and embeddings;
- migration tests covering existing tracked artifacts and legacy entries;
- `tsc --noEmit`, targeted memory/integration suites, then full `bun test`;
- documentation link/version/consistency review.

## 12. Success Criteria

- Zero writes from default memory search across all five consuming surfaces.
- Zero non-accepted entries returned as automatic agent guidance in the defined
  integration test matrix.
- All durable memory write paths covered by the shared security/atomic write seam.
- Parallel explicit reports produce distinct valid artifacts with no overwrite.
- Existing lexical and no-network suites remain green; no production dependency
  is added.
- Managed Git ignore tests cover every generated memory-data class.
- Required documentation and roadmap pass docpack review with zero blockers.

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Downstream code expects `markdownPath/jsonPath` on every search | compile/runtime break | introduce explicit report result, migrate internal callers in one phase, keep a temporary deprecated optional shape if required |
| Accepted-only defaults reduce visible recall | agents see fewer notes | restrict only automatic surfaces; preserve explicit diagnostic status filters |
| Atomic multi-file updates are platform-sensitive | partial supersession | same-directory temp files, pre-validation, ordered rename with rollback tests on supported OSes |
| Removing tracked artifacts surprises users | noisy migration | update ignore policy, document `git rm --cached`, never delete downstream files automatically |
| Catalog terminology change breaks scripts | compatibility regression | keep `memory index` as alias during this scope and clarify generated-catalog semantics |
| Security guard blocks previously allowed reconciliation | ingest behavior changes | return structured blocked/skipped results and test advisory/enforced/CI modes |
| Documentation drifts during phased delivery | inaccurate status | update docs in the final implementation phase and gate completion on docpack review |

## 14. Recommendation

Implement the correction in six independently verifiable phases:

1. freeze purity and integration tests;
2. split pure recall from explicit report persistence;
3. migrate generated-data/Git policy;
4. enforce accepted-only bounded automatic recall;
5. add lifecycle transitions and a unified guarded atomic write seam;
6. align temporal/config/catalog semantics, documentation, and release gates.

Do not introduce a database or make the derived catalog authoritative. Direct
Markdown scanning is simpler, avoids stale-index correctness problems, and is
appropriate for the expected project-memory size. The most important invariant is
that a read tool is truly a read; all later work builds on that boundary.
