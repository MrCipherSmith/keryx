# Keryx Memory Reliability Metrics and Validation
Version: 1.2.0

## Purpose

Define measurable implementation gates and the evidence required before the
corrective memory work may be called complete.

## Quality Gates

| ID | Gate | Target | Evidence |
|---|---|---:|---|
| M-1 | default recall filesystem writes | 0 across service, CLI, harness, MCP, approval | snapshot/purity tests |
| M-2 | default recall Git changes | 0 | before/after `git status --short` assertion |
| M-3 | non-accepted automatic hits | 0 across defined status matrix | integration fixtures |
| M-4 | absolute paths in agent/MCP hits | 0 | projection contract tests |
| M-5 | results above hard limit | 0 | boundary/property tests |
| M-6 | durable write paths bypassing shared seam | 0 | seam spy/coverage matrix |
| M-7 | partial canonical supersession after injected recoverable failure | 0 | rollback test |
| M-8 | temporal boundary disagreement | 0 | shared `Valid-To == date` fixture |
| M-9 | generated memory classes not ignored after init | 0 | Git ignore integration test |
| M-10 | canonical memory entry incorrectly ignored | 0 | Git ignore integration test |
| M-11 | production dependencies added | 0 | lock/package diff |
| M-12 | docpack review blockers | 0 | review report/output |

## Baseline Capture

Before implementation, record:

- current targeted test commands and results;
- full `bun run check` result if reasonably available;
- current tracked/untracked memory generated paths;
- current CLI help and tool descriptor shapes;
- representative lexical result ordering and scores;
- current optional embedding/no-network behavior.

The baseline is evidence, not an excuse to preserve defective hidden writes.

## Test Matrix

### Pure recall

Each row must assert returned behavior and a byte/path-level filesystem snapshot.

| Surface | Invocation | Expected persistence |
|---|---|---|
| service | `MemoryService.search()` | none |
| CLI text | `memory search <q>` | none |
| CLI JSON | `memory search <q> --json` | none |
| harness port | `MetaprojectPort.memorySearch()` | none |
| unified tool | `memory_search` | none |
| MCP | `memory.search` | none |
| approval | `buildApprovalContext()` | none |
| flow selection | `collectContext()` memory reads | flow output only as explicitly owned by flow; no memory artifacts |

### Authority matrix

Run matching entries through harness, MCP, approval, flow related memory,
procedural injection, and skill verification.

| Entry state | Automatic guidance expected |
|---|---|
| accepted + current + in scope | yes, subject to type/class consumer rules |
| accepted + out of scope | no for scoped consumers |
| draft | no |
| conflict | no |
| deprecated | no |
| superseded | no |
| accepted + expired | no |
| accepted + future `Valid-From` | no |

### Lifecycle matrix

Test every allowed and rejected edge from the specification state table:

- success changes status/provenance/changelog once;
- repeated target is idempotent;
- invalid edge returns an actionable error;
- terminal superseded cannot reactivate through transition;
- advisory guard writes and reports warning;
- enforced/CI guard blocks and preserves bytes;
- path escape and non-memory targets fail before write.

### Artifact matrix

- zero artifact after default search;
- valid bounded Markdown/JSON after explicit save;
- unique paths across repeated/concurrent saves;
- no overwrite on run-ID collision;
- interrupted write does not publish completed run;
- absolute paths/full details absent;
- persisted JSON validates against
  `schemas/memory-search-report.schema.json`;
- report, catalog, vectors, temp, and legacy artifacts ignored;
- canonical entry/config/template not ignored.

### Compatibility matrix

- legacy entry without typing/temporal headers;
- existing explicit status/module/entity/class/as-of filters;
- deterministic lexical ordering and score components;
- unavailable/corrupt embedding capability fallback;
- missing/corrupt catalog does not break recall;
- stable harness/MCP tool names and schemas except documented result tightening;
- old partial `memory.config.json` deep-merges with defaults.

## Proposed Verification Commands

Commands are illustrative until implementation begins; use repository-local
scripts and the testing module to select the final changed scope.

```bash
keryx test related src/memory/service.ts
keryx test related src/harness/tool/metaproject-adapter.ts
keryx test related src/mcp/tools.ts
keryx test related src/commands/agent-approval-context.ts
keryx test run --changed
bun test src/memory
bun test src/commands/agent-approval-context.test.ts
bun test src/harness/tool/metaproject-adapter.test.ts
bun test src/mcp/mcp.test.ts
bun test src/flow/context-inject.test.ts
bun run check
```

Use gdctx-normalized output for long logs. A release claim requires the actual
commands and outcomes to be recorded in the implementation flow/report, not copied
blindly from this planned list.

## Filesystem Purity Method

The purity helper should capture:

1. project-relative non-ignored file list;
2. content hash or bytes for every captured file;
3. Git porcelain status;
4. optionally relevant directory metadata when portable.

Run the target recall, recapture, and require equality. Exclude only a test-owned
temporary root that is not inside the project under test. Do not exclude
`.metaproject/data/memory`, because writes there are the defect being detected.

## Security Write-Seam Coverage

Instrument the shared seam or inject a fake so each operation proves it was called:

| Operation | New entry | Existing entry | Multi-entry |
|---|---:|---:|---:|
| manual create/force | yes | overwrite | no |
| ingest | create | reconcile | no |
| reflect | create pattern | skip existing | no |
| transition | no | update | no |
| supersede | no | update | yes |

The test suite must fail if any Keryx-owned canonical write bypasses the seam.

## Performance and Boundaries

This initiative does not set a strict latency SLO because no benchmark baseline is
yet recorded. It does require:

- one canonical store scan per default search, not additional report rereads;
- no report rendering/persistence cost without explicit request;
- configured and hard result/excerpt limits applied before adapter serialization;
- semantic rerank candidate pool remaining bounded;
- no network on default paths.

If implementation materially changes search work, record comparative local timing
as informational evidence without making an unsupported performance claim.

## Documentation Validation

Before completion:

- all package Markdown files have `Version` directly below H1;
- README links every package file;
- PRD requirement IDs map to specification and plan tasks;
- planned commands are not labeled implemented early;
- CLI help, registry, module docs, architecture docs, setup docs, templates, and
  wiki agree with runtime behavior;
- requirements roadmap status is updated and version-bumped;
- docpack review reports zero blockers.

## Evidence Record Template

Fill this section or link an implementation flow report during P6.

| Evidence | Command/test | Result | Date/commit |
|---|---|---|---|
| targeted memory/harness/MCP/flow/command/init-update/security/embedding suites | `keryx ctx run -- bun test src/memory src/harness/tool src/mcp src/flow src/commands/memory-p0.test.ts src/commands/memory-report.test.ts src/commands/init.test.ts src/commands/update.test.ts src/commands/module-commands.test.ts src/security src/memory/embedding` | **PASS: 319 passed, 0 failed, 2 skipped; 321 tests/61 files.** Skips are platform-gated live sandbox tests. | 2026-08-10 |
| post-doc source/template regression suite | `keryx ctx run -- bun test src/standard/command-registry.test.ts src/commands/module-commands.test.ts src/lib/templates.test.ts src/memory/templates.test.ts src/lib/metaproject-gitignore.test.ts src/commands/init.test.ts src/commands/update.test.ts` | **PASS: 25 passed, 0 failed; 25 tests/7 files.** | 2026-08-10 |
| CLI help/registry and purity/report smoke | `bun run src/cli.ts memory --help`; `bun run src/cli.ts commands --json`; source CLI search with and without `--save-report` | **PASS:** help includes `--save-report` and `transition`; registry includes search/supersede/transition metadata; default JSON has no report, explicit run publishes a unique bounded report. | 2026-08-10 |
| init/update ignore policy | init/update tests above; generated block inspection | **PASS:** catalog, embeddings, artifacts, runtime reports ignored; canonical Markdown/config not ignored; migration is advisory/non-destructive. | 2026-08-10 |
| security/atomic failure injection | included in targeted suite (`src/memory/lifecycle-write-p4.test.ts`, supersede/write seam tests) | **PASS within targeted run:** guarded transitions, atomic replacement, rollback, and security outcomes covered; no failures. | 2026-08-10 |
| TypeScript check | `keryx ctx run -- bunx tsc --noEmit` | **PASS: exit 0, no diagnostics.** | 2026-08-10 |
| post-rebase changed-scope tests | explicit 26-file `bun test` selection plus pre-push `keryx test run --changed` | **PASS:** manual branch selection 127 passed/0 failed; pre-push selection 129 passed/0 failed across 34 files. | 2026-08-10 |
| full Bun suite | `bun run check` | **CONCERN/EXCEPTION: 3,010 passed, 14 skipped, 90 failed / 3,114 tests across 316 files.** Failures are concentrated in sandbox-restricted live socket and user-global store/listener scenarios; the local sandbox cannot provide the required bind/global-write environment. Do not label the full suite pass; GitHub CI on PR #261 is the authoritative merge gate. | 2026-08-10 |
| memory check on non-empty fixture | `cd fixtures/memory-reliability-p0 && keryx ctx rg "^# " .metaproject/memory && keryx memory check` | **WARN/EXPECTED FIXTURE STATE:** 6 canonical entries; 12 intentional dedup/conflict issues plus missing optional catalog. No writes. Owner memory fixture maintainers; follow-up is regenerate catalog and resolve fixture conflicts only if fixture semantics change. | 2026-08-10 |
| memory check on project store | `keryx memory check` | **PASS:** all checks passed on the project store. | 2026-08-10 |
| wiki/index/link verification | `keryx wiki index`; `keryx wiki check-links`; `keryx wiki validate` | **PASS:** 39 pages indexed; 42 pages/233 links checked, 0 broken; validation passed. | 2026-08-10 |
| graph refresh/blast radius | `keryx gdgraph build`; `keryx gdgraph affected` for registry, module commands, memory templates, gitignore, and `src-memory` wiki | **PASS:** graph rebuilt with 685 total nodes/1,502 edges and 100% import resolution; dependents inspected for changed code anchors. | 2026-08-10 |
| docpack structural verification | deterministic Bun check over package Markdown/README/schema | **PASS:** 6 Markdown files, all have `Version` directly under H1; README links all package Markdown files; report schema parses as valid JSON. | 2026-08-10 |
| docpack/adversarial review | requirements-package-standard + docpack-review checklist; stale-claim scan via `keryx ctx rg` | **PASS_WITH_WARNINGS:** no structural/version/link/schema blockers; generic `latest.*` references are retained only for other modules or explicit legacy-migration/history wording. | 2026-08-10 |
| health | `keryx health run --changed --since origin/main --source typescript,complexity` | **PASS:** changed-scope score 93; no gate condition triggered. | 2026-08-10 |
| flow consistency | local source CLI `flow renumber/status/implemented/complete`; `keryx flow check` | **PASS_WITH_KNOWN_EXCEPTION:** post-rebase collisions were resolved through Task Manager by renumbering memory flows 105–111 to 135–141; all seven passed acceptance, health, and security completion gates against PR #261. The pre-existing flow 002 checksum mismatch remains owned by Task Manager maintainers. | 2026-08-10 |
| legacy artifact retirement | backup/hash + `apply_patch` deletion | **PASS:** initial exact backups at `/private/tmp/keryx-memory-latest-backup-2026-08-10/`; `latest.md` SHA-256 `02ffcdc4fda1133613e73ce02d8b401329e3f81101406b0b83e11b76c617fac6`, `latest.json` SHA-256 `ec9f67830a693d2641439d6c8d4519f3c23361ed967c9f71c958a02cec6453f3`. A stale system `keryx` smoke recreated only these two files; their exact second contents were backed up under `/private/tmp/keryx-memory-latest-backup-2026-08-10/rerun-after-global-cli/` (`latest.md` SHA-256 `ba18dc8d7600a7a049282f086816bda8cf9d098d031a810a6e563d98e7b08526`, `latest.json` SHA-256 `08c77d9d8b46d3c849da90403dc8950aef60907f81816bc6e49619d9db1b6e29`) before deleting only those two repository files again with `apply_patch`; final absence verified, no staging/index mutation. | 2026-08-10 |

### PRD acceptance-criteria evidence mapping

| PRD AC | Evidence |
|---|---|
| AC-1 pure recall | P0–P1 purity tests in targeted run; source CLI default JSON smoke; M-1/M-2. |
| AC-2 explicit reports | report tests, source CLI `--save-report` smoke, unique ignored runtime path; M-4/M-5. |
| AC-3 accepted-only recall | harness/MCP/approval/flow/skills authority matrix tests; targeted run; M-3/M-4/M-5. |
| AC-4 bounded safe projections | projection/adapter/MCP/approval tests; targeted run; M-4/M-5. |
| AC-5 lifecycle transitions | lifecycle state/idempotency/CLI tests; targeted run and registry/help evidence. |
| AC-6 guarded writes | write-seam/security/atomic tests; targeted run; M-6. |
| AC-7 atomic supersession | pair rollback/injected-failure tests; targeted run; M-7. |
| AC-8 temporal consistency | temporal fixture and P5 tests; targeted run; M-8. |
| AC-9 generated Git policy/migration | init/update/gitignore tests, backup/deletion hashes, migration docs; M-9/M-10. |
| AC-10 compatibility/catalog/legacy entries | legacy/typing/config/catalog/embedding/no-network tests; targeted run. |
| AC-11 optional embeddings fail soft | embedding capability fallback tests; targeted run. |
| AC-12 coherent documentation/contracts | help/registry, docs/wiki/index/link/structural/adversarial checks; this P6 report. |

## Release Decision

The package may move to `implemented` only when:

- all M-1 through M-12 targets are met;
- every PRD acceptance criterion has test/evidence mapping;
- P0 through P6 are complete;
- no blocker remains in the plan;
- documentation review passes;
- any warning has an explicit owner and does not violate read purity, accepted-only
  influence, durable-write security, or canonical-data safety.

The evidence above supports a verified handoff, not a PRD/flow `implemented` or
`complete` transition. The release-level exceptions are the reproduced live-
proxy full-suite failures, the pre-existing flow-002 checksum mismatch, the
expected non-empty fixture warnings, and health's pre-existing WARN score; each
has an owner/follow-up and none violates the memory reliability invariants.
