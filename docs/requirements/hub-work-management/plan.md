# Implementation and verification plan

Historical milestone record: the counts below describe their named pre-review test scopes, not the current PR head. Current validation and per-finding outcomes are recorded in [PR1113 correction results](../../../.metaproject/flows/480-2026-11-01-implement-collaborative-hub-work-metadat/review-fixes/report.md).
Version: 0.2.0

Status: implementation/verification waves executed for the candidate; no remote owner acceptance or public production rollout performed. Baseline main 0.4.1/v0.4.0 must be rechecked; preserve active parallel branches and frozen machine contracts.

## Before coding

Owner reviews P1–P9 in decisions.md, approves this package revision and creates/freezes managed implementation Flow. Choose a current isolated worktree from agreed main SHA; do not implement in the old dirty prototype checkout by default. Re-resolve project rules per task. No implicit approval of semantics from prior image mockups. No extra execution metrics were requested; previous user opt-out is retained.

## Dependency waves

| Task | Deliverable / boundary | Depends on | Required exit proof |
|---|---|---|---|
| M0 | Exact baseline/source/API audit; map every legacy read/write/conversion entry and UI owner | owner approval | scoped facts, current schemas, writer compatibility map |
| M1 | Closed record/write/event JSON schemas, exact HTTP projections/OpenAPI and transition/authorization tables; generate supporting contexts/revisions write projections from closed schema | M0 | schema valid/invalid examples; owner-reviewed contract; no placeholder endpoint |
| M2 | Additive SQLite storage, immutable revision/document archive, CAS/idempotency/event/outbox atomicity, quotas | M1 | real DB restart/concurrency/transaction failure tests |
| M3 | Flow/Intent/Attempt application lifecycle, approved amendments, context resolution and coverage | M2 | RED→GREEN transition/property/foreign-ID/race tests; no runtime coupling |
| M4 | Subject/Evidence/ReviewSubmission/Decision, human selection and aggregate Flow acceptance | M3 | exact subject and criterion decisions; unauthorized/contradictory/stale tests |
| M5 | Contributor CLI/MCP and metadata inbox/outbox, manual/Git-only reference submission | M3,M4 | actual HTTP+CLI/MCP loss/replay/revocation; no human tool exposure |
| M6 | Existing session/run/legacy result adapter with exact association and unknown allocation recovery | M3,M5 | actual two-process execution; no modified frozen v2; no duplicate run |
| M7 | Optional configured Git/CI read observer and freshness | M4,M5 | actual local fake provider API, wrong-repo/head/dup/reordered/unavailable; no vendor write |
| M8 | Legacy mode/conversion guard, startup writer-version gate, backup/rollback | M2,M4,M6 | real old-client writes/conversion races; restore with and without managed data |
| U0 | Parallel UI design/HTML fixtures under own directory | this draft | explicit mock banner, agreed visual/interaction states; no production coupling |
| U1 | Product UI implementation behind capability/version check | M1,M4,M5; approved design | all state-matrix cells, RU/EN375 px, existing machine screens unchanged |
| V1 | Exact candidate integrated tests and packaging/upgrade; all AC evidence matrix | M6,M7,M8,U1 | relevant installed lint/types/tests/build, untracked scope included |
| V2 | Independent correctness/security/migration/UI review and fix loop | V1 | no unaddressed blockers; exact head/source coverage |
| H1 | Immutable candidate/evidence owner handoff | V2 | no self-acceptance, deploy, Git/npm publication |

M7 may be omitted ONLY from an explicitly reduced owner-approved release contract that preserves manual references and labels observer unavailable. This draft includes M7 as a required release task; a worker cannot silently defer it.

## Verification work, not optional prose

Turn each group below into tracked implementation tasks when Flow is created. Tests are proposed until implemented; do not claim commands exist now.

- T-domain: Flow→Intent→two Attempts (agent/manual), multi-run attempt, single-run ownership, explicit role/owner attribution. Criterion mappings, cross-project parents/subjects/cursors, amendment races and stale closures.
- T-review: exact subject/Evidence set; missing/fail/inconclusive coverage and acceptance-side waiver overlays; unwaivable refusal, spoofed human/CI, agent REST/MCP/machine refusal, two reviewers racing, late contradictory Evidence, mutable PR head. Accepted historical Decision stays unchanged.
- T-sync: actual HTTP response lost after commit, restart before/after outbox ack, same-key altered body, duplicate/reordered observations, unknown execution allocation, cursor gap/full resync and project switch. No operation/acceptance duplicated.
- T-execution: existing two local serve processes and deterministic actual native tools, exact metadata binding, controller revoked vs work contributor rights, local context drift, cancellation unknown/late result; no physical-lock release from Attempt state.
- T-git: real read adapter against synthetic configured provider, SHA1/SHA256 repository formats, inaccessible repo, wrong head, force-push/deletion, CI workflow source spoofing and last-known metadata. No outbound network to real vendor required in automated tests.
- T-knowledge: exact document-version archive; shared cache refs; required missing overlay refusal; report context is claimed vs actual; wiki proposal/no-update reason and human verification separated.
- T-compat: v1 Flow/Evidence/review-bundle, v2 sessions, SSO/MCP/context-watch/serve regressions. Every legacy writer guard, dry-run stale, concurrent conversion/start, min-writer gate, backup trial and rollback refusal after managed data.
- T-UI: Overview→same attention item in Flow/session; two Attempts, Evidence diff, human decision; Git-only manual result, requested changes→new Attempt; project switch/in-flight read/unknown submit/reconnect/observer and375 px RU/EN/keyboard. Both semantic and browser checks, no screenshot-only claim.
- T-resource: caps/quota atomic refusal, log redaction, attachment unavailable/retention, accepted raw artifact retention, bounded pages; no full source upload required.
- T-release: actual source/standalone/container schema assets and feature-off compatibility, install/upgrade smoke from0.4.x DB; explicit unexecuted external GitHub/real-team checks.

## Final checks

Use project-local code-verifier and review orchestration. Health changed scope may miss untracked new files; include all new source and frontend files. Never disable existing test isolation/hooks for a production proof. Current graph stale: rebuild before certifying final impact. Standard tests are actual installed scripts discovered from chosen checkout; package/docs checks are run with `node docs/requirements/hub-work-management/verify.cjs`.

## Risks and rollout

First pilot: one project, at least two human principals, a manual Git contributor and one native agent. Export/backup new metadata and verify full replayability before wider use. Runtime control and product work remain separate views/authorities. Product acceptance can precede or follow PR merge by explicit policy; UI never equates them. All owner review decisions remain external to implementation agent self-report.

## Candidate completion evidence

The integrated backend and three UI increments are implemented on feat-hub-work-management. Backend 1783 tests passed; UI 142 tests passed at the native-integration milestone (before the 151-test reload-recovery milestone); packaging 6 tests passed, plus67 CLI/reference checks. Types, lint, frontend build and embedded assets passed. Independent backend, membership/snapshot delta, UI core/advanced and native UI reviews approved their exact scopes after reproduced findings were corrected. Full native browser association was checked against a synthetic Hub/WebSocket peer; actual model/provider execution is not claimed. A separate isolated Linux test host Linux source-archive runtime and official SDK MCP trial passed without production changes. See verification.md and the operator handoff for exact boundaries. Local Flow480 stays in-progress for owner handoff; no judged AC is signed as a human by an agent.
