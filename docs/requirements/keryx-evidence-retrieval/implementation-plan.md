# Evidence Retrieval Implementation Plan
Version: 0.2.0

## Status and execution contract
Code for P0–P4 and the lexical part of P5 is present on the PR #1022 branch
(`feat/415-evidence-retrieval-layer`). **Implemented is not accepted:** T12
(paired evaluation, AC9) is open, T13 independent review is only a reduced static
assessment, and the rollout decision belongs to the operator. P1 session lifecycle
uses the operator-approved owner API scope: durable revocation and reader drain,
without adding archive deletion or ACP session/delete. Hybrid mode is gated: with
`enabled` and `mode: "hybrid"` and no approved embedding owner the runtime returns
`hybrid-owner-unavailable`, and no shipped CLI, tool or automatic-recall path
supplies an owner, so hybrid is unreachable from them. No benefit of hybrid, of
exact visibility or of incremental indexing has been measured.
Recheck actual HEAD seams and accepted constraints; preserve unrelated edits.
Each phase produces executable tests/review/status evidence. Command lists below
describe suites that now exist in the tree; whether they pass is reported by CI on
the PR, not by this document.

| Phase | Code on the branch | Acceptance state |
|---|---|---|
| P0 contracts, source adapters | `types`, `config`, `sources`, `service` | Implemented; focused tests exist. |
| P1 explicit lexical retrieval + lifecycle | `search`, `index`, `lifecycle`, `storage`, `tool`, `commands/evidence.ts` | Implemented; usable behind `enabled`. |
| P2 incremental + hybrid | `archive-*`, `hybrid`, `embedding-builder`, `vector-cache` | Code present; hybrid gated, no embedding owner wired; not measured. |
| P3 exact visible projection | `visibility`, `projection` | Implemented; exact attribution only where the adapter exposes the serialized request (OpenAI); others report unknown. |
| P4 opt-in automatic recall | `automatic`, wired in `commands/agent.ts` and `commands/shell.ts` | Implemented; off by default; lexical only. |
| P5 evaluation and rollout | `scripts/benchmark/*evidence-evaluation*`, lexical adapter, starter set | Partial: smoke set and lexical arm only. Arms A, C, D, E not run. **AC9 open.** |

Known gap: no TUI surface (panel, modal or slash command) exists for this feature.
Rollout decision: pending operator.

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
and src/evidence/tool.test.ts cover AC1/3/6/7/8 plus full-build
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
For each suite run bun test <suite paths named above>; at completion
bun test src/evidence (tool tests live in src/evidence/tool.test.ts), relevant
existing related suites, and repository type/lint checks after reading package.json.
Operator preference: general runs go through GitHub CI on the draft PR.
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
