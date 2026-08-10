# Keryx Memory Reliability Implementation Plan
Version: 1.1.0

## Purpose

Provide the canonical, update-in-place checklist for implementing the corrective
memory work. Check a task only when its listed verification is complete. Bump this
document's version whenever progress or scope changes.

## Status Legend

- `[ ]` not started
- `[~]` in progress (replace with `[x]` or `[ ]` before a release handoff)
- `[x]` complete and verified
- `[!]` blocked; add a dated note under Blockers

## Progress Dashboard

| Phase | Scope | Status | Exit evidence |
|---|---|---|---|
| D0 | Requirements package | complete | docpack files, roadmap, review |
| P0 | Baseline and contract tests | complete | targeted baseline, purity characterization, authority/temporal fixtures, and focused verification recorded in flow 105 |
| P1 | Pure recall and explicit reports | complete | service/CLI/harness/MCP purity passes; flow 106 verified handoff |
| P2 | Generated-data and migration policy | complete | Git-ignore/init-update tests pass; legacy tracked latest files backed up, removed, and advisory documented |
| P3 | Accepted-only bounded automatic recall | complete | flow 108 verified handoff: authority/bounds matrix, focused tests, changed tests, and typecheck |
| P4 | Lifecycle and unified write seam | complete | flow 109 verified handoff: lifecycle table/CLI, guarded canonical seam, pair rollback, focused 26/0, changed 91/0, typecheck |
| P5 | Temporal/config/catalog consistency | complete | flow 110 verified handoff: temporal/config/catalog compatibility, changed tests, and typecheck pass |
| P6 | Documentation, full verification, rollout | complete (verified handoff; flow 111 in progress) | flow 111 evidence: docs, wiki, migration, targeted/full checks, graph, and docpack review |

## Delivery Rules

1. Implement phases in order; P2 and P3 may proceed in parallel only after P1's
   search contract is merged.
2. Keep each proposed commit atomic and green for its changed scope.
3. Do not mark a read surface pure from code inspection alone; assert filesystem
   and Git-status equivalence in tests.
4. Do not remove compatibility fields until all internal callers compile and
   tests prove migration.
5. Do not update docs to “implemented” until P6 verification passes.
6. Preserve unrelated worktree changes and never auto-delete downstream memory
   entries or mutate downstream Git indexes.

## D0 — Requirements Package

- [x] D0-1 Document the current read/write, status, catalog, security, temporal,
  and artifact findings.
- [x] D0-2 Define PRD goals, non-goals, requirements, constraints, risks, and
  Gherkin acceptance criteria.
- [x] D0-3 Define target service, storage, lifecycle, adapter, CLI, and migration
  contracts.
- [x] D0-4 Define trackable phases and measurable validation gates.
- [x] D0-5 Update the requirements roadmap.
- [x] D0-6 Complete structural and adversarial docpack review.

Exit: documentation is `specification ready (corrective work planned)` and makes
no unsupported implementation claim.

## P0 — Baseline and Contract Tests

### Objective

Freeze the undesirable current behavior as explicit failing target tests before
changing service contracts.

### Tasks

- [x] P0-1 Record the current targeted-test baseline for memory, harness adapter,
  MCP, approval context, flow context, init/update, and embeddings.
- [x] P0-2 Add a reusable filesystem snapshot helper that records relative paths,
  file hashes/content, and relevant Git status without scanning ignored runtime
  noise.
- [x] P0-3 Add a service-level test asserting default `search()` performs no write.
- [x] P0-4 Add CLI purity tests for text and `--json` output without report flags.
- [x] P0-5 Add harness/native adapter and unified-operation purity tests.
- [x] P0-6 Add MCP `memory.search` purity test while retaining `mutating: false`.
- [x] P0-7 Add approval-context purity test proving advisory lookup does not dirty
  the project before an approval decision.
- [x] P0-8 Add authority fixtures containing matching accepted, draft, conflict,
  deprecated, expired, and superseded entries.
- [x] P0-9 Add a current/as-of boundary fixture where `Valid-To` equals query day.
- [x] P0-10 Add tests documenting the legacy report-path contract that internal
  callers must migrate away from.

### Expected files

- new `src/memory/search-purity.test.ts` or equivalent;
- updates/new tests under `src/commands`, `src/harness/tool`, `src/mcp`, and
  `src/flow`;
- shared test fixture/helper under the existing test conventions.

### Verification

- New target tests fail only for the documented baseline defects.
- Existing targeted suites retain their pre-change result.

### Proposed commit

```text
test(memory): freeze recall purity and authority contracts
```

## P1 — Pure Recall and Explicit Reports

### Objective

Make recall a true read and move report persistence behind an explicit API/CLI
action.

### Tasks

- [x] P1-1 Remove artifact persistence from `MemoryService.search()`.
- [x] P1-2 Remove required `markdownPath/jsonPath` from `MemorySearchResult` and
  migrate all callers/fakes/fixtures.
- [x] P1-3 Add bounded report DTO/rendering that never serializes a raw
  `MemoryEntry` or absolute path and validates against the package JSON Schema.
- [x] P1-4 Add `MemoryReportStore`/`writeReport()` with injected clock/run ID and
  atomic per-run publication.
- [x] P1-5 Add CLI `--save-report`; ensure default text and `--json` modes only
  write stdout.
- [x] P1-6 Keep `memory_search` as `risk: "read"` and prove its implementation now
  satisfies that contract.
- [x] P1-7 Keep MCP `memory.search` as `mutating: false` and return structured
  search data without report artifacts.
- [x] P1-8 Ensure built-in subprocess fallback, if still supported, invokes pure
  default CLI behavior.
- [x] P1-9 Add two-run concurrency/collision tests and interrupted-publication
  cleanup tests.
- [x] P1-10 Verify semantic rerank/no-network tests after the result-contract
  change.

### Exit criteria

- PRD AC-1 and AC-2 pass at service, CLI, harness, MCP, and approval surfaces.
- A repository with no initial changes remains clean after repeated default
  searches.
- Explicit reports are unique, bounded, valid, and ignored-runtime-ready.

### Proposed commits

```text
refactor(memory): make search side-effect free
feat(memory): add explicit immutable search reports
```

## P2 — Generated Data and Migration Policy

### Objective

Remove ephemeral memory state from version control and make downstream migration
safe and explicit.

### Tasks

- [x] P2-1 Update `renderMetaprojectGitignoreBlock()` for memory catalog,
  embeddings, legacy artifacts, and runtime reports.
- [x] P2-2 Add init/update tests using Git ignore matching for concrete generated
  paths and a canonical entry path.
- [x] P2-3 Remove tracked Keryx `data/memory/artifacts/latest.md/json` from the
  repository implementation commit. Exact contents were backed up to
  `/private/tmp/keryx-memory-latest-backup-2026-08-10/` and hash-verified before
  deletion; only these two generated legacy files were removed, with no staging
  or Git-index mutation.
- [x] P2-4 Stop scaffolding or referencing legacy latest report paths in index,
  manifest, skill, dashboard, verifier, and documentation templates.
- [x] P2-5 Replace verifier “artifact exists” consultation signals with explicit
  structured recall/consultation evidence where needed.
- [x] P2-6 Add non-destructive downstream migration diagnostics; never run
  `git rm` or delete user files automatically.
- [x] P2-7 Verify `memory index` and embedding outputs are ignored after init and
  remain reproducible.
- [x] P2-8 Add migration notes to CLI/setup documentation.

### Exit criteria

- PRD AC-9 passes.
- A fresh project tracks canonical memory and ignores every generated class.
- An existing project receives a safe advisory with no automatic deletion or Git
  index mutation.

### Proposed commit

```text
fix(memory): isolate generated memory data from git
```

## P3 — Accepted-Only Bounded Automatic Recall

### Objective

Ensure only authoritative memory directs agents automatically while preserving
explicit diagnostic search.

### Tasks

- [x] P3-1 Add a shared accepted/current recall helper or explicit filter builder
  for agent-facing integrations.
- [x] P3-2 Update `MetaprojectPort.memorySearch` adapter defaults to accepted and
  current.
- [x] P3-3 Update unified harness and MCP projections to bounded relative-path
  DTOs.
- [x] P3-4 Update approval context to accepted/current limit 1 and preserve
  best-effort behavior.
- [x] P3-5 Update flow related-memory selection to accepted/current; if drafts are
  retained for planning, render them in a separate advisory section that cannot
  be mistaken for instruction.
- [x] P3-6 Keep procedural injection accepted/current/class/scoped and enforce a
  hard maximum.
- [x] P3-7 Ensure gdskills verification consults canonical accepted/current
  authoritative entries directly, not latest artifacts.
- [x] P3-8 Validate query, status, class, result limit, and excerpt bounds at port
  boundaries.
- [x] P3-9 Add cross-surface matrix tests for every non-authoritative status and
  temporal state.
- [x] P3-10 Add large-summary/detail tests proving absolute paths and unbounded
  text do not cross agent/MCP boundaries.

### Exit criteria

- PRD AC-3 and AC-4 pass.
- Explicit CLI search can still inspect requested non-accepted states.
- Automatic outputs are bounded and contain no absolute paths/full details.

### Proposed commit

```text
fix(memory): restrict automatic recall to accepted current entries
```

## P4 — Lifecycle and Unified Guarded Write Seam

### Objective

Make durable memory mutation explicit, validated, security-gated, auditable, and
atomic.

### Tasks

- [x] P4-1 Implement the allowed lifecycle transition table in a pure helper.
- [x] P4-2 Add service `transition()` with idempotency and structured errors.
- [x] P4-3 Add canonical CLI `memory transition`; optionally add accept/deprecate/
  conflict aliases.
- [x] P4-4 Implement shared entry path confinement and next-value validation.
- [x] P4-5 Implement guarded same-directory temporary write + atomic replacement.
- [x] P4-6 Route manual create/overwrite through the shared seam.
- [x] P4-7 Route ingest new-entry and reconciliation paths through the shared seam;
  preserve structured advisory/enforced/CI outcomes.
- [x] P4-8 Route reflection-created pattern drafts through the shared seam.
- [x] P4-9 Refactor supersession to pre-validate/pre-guard both entries and add
  rollback-capable pair persistence.
- [x] P4-10 Append deterministic transition/supersession changelog and provenance
  metadata.
- [x] P4-11 Add state-table, idempotency, terminal-state, guard-block, atomicity,
  and rollback tests.
- [x] P4-12 Confirm no automatic path can accept a draft.

### Exit criteria

- PRD AC-5, AC-6, and AC-7 pass.
- Every Keryx-authored canonical memory write is accounted for by shared-seam
  tests.
- Enforced/CI security failures leave canonical entries byte-identical.

### Proposed commits

```text
feat(memory): add explicit entry lifecycle transitions
refactor(memory): unify guarded atomic entry writes
```

## P5 — Temporal, Config, Catalog, and Validation Consistency

### Objective

Remove remaining semantic contradictions without changing the canonical data
model or lexical floor.

### Tasks

- [x] P5-1 Extract one temporal-validity helper used by general search, relevant
  memory, and procedural injection.
- [x] P5-2 Make `Valid-To` exclusive for current and as-of queries; validate real
  calendar dates.
- [x] P5-3 Validate CLI/config status, class, query, limit, and injection bounds.
- [x] P5-4 Deprecate/ignore `allowAutoAccept`; warn when configured true and keep
  automatic ingest draft-only.
- [x] P5-5 Remove unused `MemoryTypeConfig.template` or enforce/document it; follow
  the specification recommendation to allow all known types and remove the flag.
- [x] P5-6 Reframe `memory index` output as an optional generated catalog without
  changing the CLI name in this scope.
- [x] P5-7 Remove catalog absence as an integrity failure; add optional
  stale/corrupt warning semantics if retained.
- [x] P5-8 Prove deleting catalog/embeddings does not alter lexical results.
- [x] P5-9 Run legacy entry, temporal fixture, typing, dedup, embedding, and
  no-network compatibility suites.

### Exit criteria

- PRD AC-8, AC-10, and AC-11 pass.
- Effective config remains backward-compatible for missing additive sections.
- Documentation and code no longer claim search consumes an inverted index.

### Proposed commit

```text
fix(memory): align temporal config and catalog semantics
```

## P6 — Documentation, Full Verification, and Rollout

### Objective

Make the implemented behavior discoverable and prove the whole repository remains
healthy.

### Tasks

- [x] P6-1 Update CLI help/reference and command registry metadata.
- [x] P6-2 Update module, architecture, complete-setup, and workflow docs.
- [x] P6-3 Update memory manifest, templates, skill instructions, and index data
  references.
- [x] P6-4 Update and reindex the accepted `src-memory` wiki page after code lands.
- [x] P6-5 Update this package's status and progress dashboard; bump versions.
- [x] P6-6 Run targeted memory, harness, MCP, flow, command, init/update, security,
  and embedding suites.
- [x] P6-7 Run TypeScript check and full Bun test suite.
- [x] P6-8 Run memory check against a non-empty fixture/store and verify warnings.
- [x] P6-9 Run docpack structural verification and adversarial review.
- [x] P6-10 Refresh gdgraph after implementation and verify changed-file blast
  radius/documentation links.
- [x] P6-11 Record migration guidance and release/changelog entry.

### Exit criteria

- All PRD acceptance criteria pass.
- [Metrics and Validation](metrics-and-validation.md) contains recorded evidence.
- Requirements roadmap and package status are honest.
- Full check/test gates pass or any accepted exception is documented with owner and
  follow-up.

### Proposed commit

```text
docs(memory): document reliable recall and lifecycle contracts
```

## Verification Matrix

| Requirement area | Unit | Integration | Repository/system |
|---|---|---|---|
| pure search | `search/service` | CLI/harness/MCP/approval | Git status unchanged |
| explicit reports | renderer/store | CLI flag | concurrent runs, ignore policy |
| accepted-only recall | filter/projection | port/MCP/flow/approval/skills | bounded prompt/tool output |
| lifecycle | transition helper | service/CLI | changelog + security modes |
| atomic writes | write seam | ingest/reflect/supersede | injected failure/rollback |
| temporal | shared helper | CLI/flow/relevant | legacy fixture parity |
| catalog/config | config/check | init/update/index | delete/rebuild/no-search-impact |
| compatibility | parser/ranking | stable tool names | full test/check suite |

## Expected Test Impact

Likely new or expanded coverage:

- `src/memory/search-purity.test.ts`
- `src/memory/report.test.ts`
- `src/memory/lifecycle.test.ts`
- `src/memory/write.test.ts`
- `src/memory/temporal.fixture.test.ts`
- `src/memory/security-seam.test.ts`
- `src/memory/embedding/embedding.test.ts`
- `src/commands/memory.test.ts` or command-module coverage
- `src/commands/agent-approval-context.test.ts`
- `src/harness/tool/metaproject-adapter.test.ts`
- unified tool projection tests
- `src/mcp/mcp.test.ts`
- `src/flow/context-inject.test.ts`
- `src/commands/init.test.ts` and `update.test.ts`

## Blockers and Decisions Log

Record implementation blockers and material deviations here.

| Date | Phase | Status | Decision/blocker | Owner/follow-up |
|---|---|---|---|---|
| — | — | — | None at specification time | — |

## Definition of Done

- [ ] Every functional and non-functional requirement is implemented or explicitly
  deferred in a versioned package update.
- [ ] All twelve PRD Gherkin criteria have executable evidence.
- [ ] Default read surfaces are filesystem-pure.
- [ ] Automatic recall is accepted/current/bounded.
- [ ] Every durable write uses the shared validated security/atomic seam.
- [ ] Generated memory data is ignored and legacy latest artifacts receive no new
  writes.
- [ ] Existing Markdown and lexical/no-network behavior remain compatible.
- [ ] Targeted and full repository verification pass.
- [ ] User, CLI, module, wiki, template, and roadmap documentation agree.
- [ ] Docpack review reports zero blockers.
