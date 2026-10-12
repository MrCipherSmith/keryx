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

## Deferred
Code-history graph import, contradiction inference, global cache, external transcript adapters,
always-on watcher and ANN backend. V1 uses bounded vector scan; choose ANN only
when measured cost justifies extra dependencies and lifecycle complexity.
