# Hub context watch PRD
Version: 0.1.1

Status: implementation verified; owner acceptance pending. Original product goals remain unchanged; see report.md for executed release checks.

## Problem and goal

Developers working in multiple explicitly connected clones/worktrees currently run hub sync manually to refresh shared wiki/spec context. A running watch process should receive canonical changes automatically without touching application code or local wiki files.

Users: developers and agents using an explicitly bound local checkout. The Hub remains the authority; downloaded document approval is server provenance, never a new local approval.

## Requirements

- R1: An opt-in watch command immediately syncs, then polls incrementally while it runs. Existing one-shot behavior remains compatible. Verification: judged.
- R2: Concurrent one-shot/watch writers sharing a cache cannot roll it back, lose documents or publish partial data. Invalid responses preserve the previous cache. Verification: judged.
- R3: Temporary failures retain last good context, report stale state and retry; revoked credentials stop requests. Verification: judged.
- R4: Shutdown cancels waiting/in-flight work and releases owned resources without changing code, Git or approvals. Verification: judged.
- R5: Real HTTP, two-checkout and compiled-client checks produce Evidence tied to an exact Code Revision; the owner accepts the result. Verification: judged.

## Release criteria

- All eight specification acceptance criteria have executed, exact-candidate evidence.
- Connector and CLI regression gates pass; documentation distinguishes foreground watch from a persistent service.
- Implementation is submitted for review without acceptance, Git publication or deployment.

## Outcome criteria

- In an owner trial with two connected working copies, a newly approved Hub document becomes visible in their common cache without another manual sync while watch runs. Observation: compare document digest and cache cursor after an update and after reconnecting.
- Reduced context staleness across a team: not measured — this prototype has no production telemetry or adoption study.

## Risks and recommendation

Atomic rename alone does not prevent stale concurrent writers. Serialize cache transactions before reading the prior cursor. Offline data remains on disk and is not remotely erased by revocation. A killed process can leave a lock; recovery must be conservative and documented. Start with foreground watch; integrate with serve only in a later Flow.
