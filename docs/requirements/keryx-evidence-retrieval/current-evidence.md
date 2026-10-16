# Current Evidence and Decisions
Version: 0.1.0

## Inspection baseline
Static inspection of keryx, not executed benchmark proof. Recheck keryx
implementation HEAD before coding; shared checkout changes and graph snapshot
are not fresh caller proof.

| Inspected path | Observation |
|---|---|
| src/memory/service.ts | Opt-in semantic path reranks lexical candidatePool; errors fall back. |
| src/memory/embedding/index.ts | Derived memory-entry cache, full build, model metadata; not raw-evidence search lane. |
| src/session/store.ts | Session/archive source-reader seam. |
| src/session/bounded-request.ts | Bounded request differs from entire archive. |
| src/harness/context/manifest.ts | Available context sources mapped trustedAsPolicy=true; not safe unchanged for raw ERL. |
| src/harness/tool/output-spill.ts | Spilled full text differs from visible preview. |
| src/sac/proposal-lifecycle.ts | Acceptance human-gated; ERL must not bypass. |

## Decisions and alternatives
1. Separate evidence owner, not broaden accepted-memory influence: relevance is not truth.
2. Independent vector pool, not lexical-only rerank: paraphrases need discovery.
3. Final-request exact spans, not session/time cutoff: compaction changes visibility.
4. Immutable generations, not in-place catalog/vector edits: consistent readers/crash safety.
5. Explicit local indexing first, not daemon: observable cost/scope/deletion.
6. Implement within keryx; any third-party code reuse needs license/commercial review.

## Acceptance status
Static, as of PR #1022 head `796e563c7` (code unchanged since `fca318a88`; the
only later commit adds the server handoff note). Nothing below is a measured benefit.

| Item | State |
|---|---|
| Code P0–P4 | Present on the branch; lexical retrieval and automatic recall (off by default) are reachable, hybrid is not. |
| Hybrid | Gated by `hybrid-owner-unavailable`: no approved embedding owner is wired to CLI, tool or automatic recall. A synthetic or fixture vector source is not an acceptable substitute. |
| T12 paired evaluation (AC9) | **Open.** Smoke set, partial runner and a real lexical arm B exist (`scripts/benchmark/*evidence-evaluation*`). Arms A, C, D, E, the frozen holdout, three timing repetitions, grounded-answer scoring and paired uncertainty are not done. No claim that hybrid beats lexical. |
| T13 independent review | **Reduced static assessment, not approval.** See `.metaproject/data/review/pr1022-t13/` T13-interim.md, T13-focused.md, T13-fixes.md. Five substantial findings were fixed and statically re-inspected; the remaining gaps listed in T13-focused.md are unresolved or in progress. |
| CI | Reported per head on the PR; a green CI is not acceptance. |
| TUI surface | None. Known gap against the repository rule that every feature has a TUI surface and docs. |
| Rollout decision | **Pending operator.** |

## Deferred
Code-history graph import, contradiction inference, global cache, external transcript adapters,
always-on watcher and ANN backend. V1 uses bounded vector scan; choose ANN only
when measured cost justifies extra dependencies and lifecycle complexity.
