# Evidence Retrieval Implementation Plan
Version: 0.1.1

## Status and execution contract
All phases planned, none implemented in this doc change. Use fresh implementation
branch, recheck actual HEAD seams and accepted constraints; preserve unrelated edits.
Each phase produces executable tests/review/status evidence. Commands below are
PLANNED and become executable only after named suites exist, not checks already run.

## P0 — Contracts and safe source adapters
Implement src/evidence/{types,config,sources,security}.ts and service facade, schema
loading/defaults/canonical scope, existing archive-reader and scanner integrations.
No embedding or automatic injection. Tests src/evidence/contracts.test.ts and
sources.test.ts cover AC1/3/6. Gate: no implicit scan/network, redaction precedes storage.
Contracts suite must metaschema-validate all three Draft 2020-12 schemas and test
accepted/rejected payloads, local refs, diagnostics and code/coverage combinations
using repository-approved validator.
Verification: judged

## P1 — Explicit lexical retrieval
Depends P0. Deterministic chunker, full source/locator hashes, lexical index, source
revalidation, CLI and evidence_search. BEFORE enabling ANY retrieval implement
minimum immutable full-build publication/checksums/writer lease/reader pins,
durable ledger, owner deletion/revocation hooks, delivery cancellation/revalidation,
30-day retention and safe disable/clear. Mandatory for lexical retrieval, not
postponed to hybrid/automatic. Tests src/evidence/search.test.ts, lifecycle.test.ts
and src/harness/tool/evidence-search.test.ts cover AC1/3/6/7/8 plus full-build
crash/concurrency AC5. Gate: no post-revocation delivery even with source on disk,
retention and all empty-result branches. Do not ship P1 without lifecycle gates.
Verification: judged

## P2 — Incremental generations and hybrid discovery
Depends P1. Extend safe full-build generation/ledger lifecycle with incremental
complete-record cursor, approved embeddings/reuse and independent semantic pool.
Tests src/evidence/index.test.ts and hybrid.test.ts cover AC2/5/8 with deterministic
embedder, crash/concurrent-reader faults and rewrite/rename/torn append fixtures.
Gate: full/incremental equivalence, zero post-delete delivery, no incompatible vectors.
Verification: judged

## P3 — Exact visible projection
Depends P1, parallel-safe with P2 via lexical fixtures. Instrument bounded-request
assembly and actual provider serializers, not trusted manifest source availability.
Full payload hash, exact/partial/transformed attribution, one bounded repack protocol.
Tests src/evidence/visibility.test.ts plus fixtures for every supporting adapter
cover AC4. Unsupported adapters return unknown. Gate: zero false exact exclusions.
Verification: judged

## P4 — Opt-in automatic recall and lifecycle
Depends P2/P3. Reserved evidence budget, one retrieval per user turn, privacy/network
approval boundary, automatic integration with P1 lifecycle. Tests src/evidence/automatic.test.ts
and lifecycle.test.ts cover AC1/6/7/8. Gate: final request assertions, required context
intact, cancellation races safe; auto still off by default.
Verification: judged

## P5 — Evaluation and rollout
Depends all phases. Build paired evaluation per metrics protocol, full repository
checks from actual package scripts, review and operator docs/wiki/roadmap updates.
Gate AC9: record security, quality, cost/latency, uncertainty, unsupported adapters;
operator decides rollout, not one demo. No numeric performance claim without report.
Verification: judged

## Planned execution commands and prompts
For each created suite run bun test <suite paths named above>; at completion
bun test src/evidence src/harness/tool/evidence-search.test.ts (planned), relevant
existing related suites, and repository type/lint checks after reading package.json.
Documentation check already available: python3 docs/requirements/keryx-evidence-retrieval/verify.py.

Copy-ready prompt, replace N with 0–5 and name prerequisite evidence:
> Implement P<N> of docs/requirements/keryx-evidence-retrieval only. Read README,
> spec, policies, lifecycle and phase first; inspect actual HEAD interfaces. Publish
> plan, preserve unrelated changes, implement named tests, run them and related
> checks, review/fix blockers, report actual verification. Do not broaden scope or
> claim later phases. Auto remains off until P4 gates pass.

Stop for missing safe deletion hook, ambiguous source identity, missing consent
boundary or inability to instrument actual serialized provider payload. Never
substitute session timestamps or whole-file flags for those correctness gates.
