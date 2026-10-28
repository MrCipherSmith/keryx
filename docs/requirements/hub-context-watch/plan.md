# Hub context watch implementation plan
Version: 0.1.1

Status: implementation and verification complete; final Hub handoff pending. Human freeze/start were confirmed before runtime work. Original task definitions remain below; execution outcomes are recorded in journal.md and report.md.

## Tasks and dependencies

- T1: Confirm Hub spec digest, human freeze and exact eight criteria; start the ready Flow using an agent principal.
- T2: Write behavior tests for the CLI, cache transaction validation/serialization and watch cancellation/retry before implementation. Record RED failures for absent behavior.
- T3: Implement shared safe sync transaction used by one-shot and watch, retaining index routing and existing cache layout.
- T4: Implement bounded foreground watcher, typed sanitized failures, retry/cancellation and CLI flags; no daemon or serve integration.
- T5: Verify real two-process contention, late response, temporary offline recovery, revoked credential and signal shutdown; inspect code/Git/source documents unchanged.
- T6: Run relevant connector/CLI regressions, type/lint/build and packaged standalone smoke. Do not reinstall shared root dependencies.
- T7: Independent correctness/security review; fix within scope and repeat affected gates.
- T8: Write usage/recovery/change report; upload review-bundle Code Revision and exact-candidate Evidence; submit for owner review. No select/delivery, merge, release or deployment.

Each verification is a tracked checklist item in the journal and Evidence. Hub currently has no local-task mirror; no duplicate .metaproject/flows authority is created. Current read-only laptop MCP key is not upgraded; canonical writes use the existing server-inherited agent identity with explicit attribution.

## State × event matrix

| State | Poll/retry | Concurrent writer | Signal | Auth/permanent failure |
|---|---|---|---|---|
| No cache | Full snapshot, validate then commit | Busy; wait without writing | Cancel; no incomplete cache | Stop nonzero; no fabricated cache |
| Current cache | Incremental delta; unchanged bytes preserved | Serialize before cursor read | Preserve committed cache | Stop; preserve disk data |
| Offline/stale | Backoff; retain revision; success clears stale state | Busy does not advance cursor | Cancel sleep/request | Stop without endless retries |
| Updating | Validate complete response before atomic replace | No overlapping transaction | No commit after abort; retain completed rename | Preserve last valid state |
| Cache committed, index failure | Report fatal with actual cursor | Release own lock | Preserve cache and index | Explicit partial outcome; no success claim |

## Context and verification basis

Existing sync: src/hub/connector.ts; CLI: src/commands/hub.ts; protocol: src/hub/contracts.ts and domain.ts. Graph affected lists connector consumers; graph predates untracked output artifacts, source was inspected directly. Wiki index has no dedicated Hub page. Memory search found no relevant Hub decision. Existing connector documentation confirms manual sync and no background serve integration.
