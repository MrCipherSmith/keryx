# Flow 470 operator decisions and inherited provenance

Base: main. Owner: MrCipherSmith. Flow 469 remains history; its recorded base below is historical only. Explicit freeze remains pending.

Delivery target selected by operator: draft PR to main → review → merge → release → operator manual testing. Publish, merge and release require separate approvals.

## Historical decisions from flow 469

# Operator decisions before freeze

Date: 2026-10-20. Flow: 469. Owner: MrCipherSmith. Base: docs/keryx-learn-probe-docpack. Root: /Users/Goodea/goodea/keryx. Execution statistics declined.

- Correct existing docs/requirements/keryx-learn-probe/ in place with version bumps. No runtime dispatch before explicit freeze. Orchestrator verifies; neighboring agents implement.
- Budget must be finite and >0, otherwise probe-no-budget. Missing/invalid task-set: probe-bad-task-set. Invalid runs/other values: probe-invalid-arguments. Exit 2, before writes. Missing task ID in valid task-set remains no-task/unmeasurable.
- All unmeasurable comparisons: arms={base:null,probe:null}, delta=null, no evidence. Preserve actual runs/transcripts on partial failure; pre-run no-task/underpowered/gold-leak use runs=[].
- Add trigger/action digest to identity and immutable snapshot in plan. Add durable completed-seed/spend checkpoints; resume only matching environment/request/snapshot.
- Recoverable finalization: comparison persisted, then sourceRef-deduplicated evidence update under lock using current confidence, then durable finalization marker. Resume finalization without model reruns or comparison rewrites. Only fully finalized probe gets already-completed.
- Operator clarification: comparison publication is the drift cut-off. Text/status drift detected before publication yields unmeasurable/environment-drift without evidence. After publication (including crash recovery), comparison remains byte-identical; locked finalization skips evidence if text/status drifted and checkpoint records evidence=skipped with reason environment-drift. CLI reports that finalization outcome separately, returns exit 3 for the invocation that records the skip, and does not change confidence. A fully finalized rerun still refuses already-completed, exit 2.
- Add plan/checkpoint schemas; align comparison/task-set schemas, examples, identity descriptions and ACs. Separate immutable plan and mutable checkpoint schemas if needed.
- Permit learn.ts router import only for probe command; decision modules accept/apply/promote/graduate acquire no probe dependency or behavior. Keep apply.ts Partial evidence map and domain fallback unchanged; regression check proposal sourceType/sections.
- Gold checks before seeds must verify existence in base ref as well as removal. Diagnostics on stderr, not fictional reachablePaths field.
- Both arms use identical context-on baseline/toolset, differing only by pattern. JSON stdout contains JSON only; plan/confirmation/diagnostics stderr/TTY. Preserve terminal approval and dry-run zero writes.
- Live outcome measurements are not release/CI gates. Preserve historical review with appended explicit dispositions rather than silently treating recommendations as settled requirements.
- agent-1 verified apply fallback and found identity/checkpoint/finalization gaps. agent-2 verified ablation worktree/context-on reuse and missing base-ref existence check; signal/resume plumbing is new work.
- Baseline limitations: graph reports moved repo/new paths; health last ran 2026-09-09. Wiki query was tangential. Refresh impact/health before runtime acceptance. Do not touch unrelated dirty paths.
- Slate Seed recording failed (no open slate). These durable decisions substitute for lost scratch persistence, not accepted cross-session knowledge.

## Current prefreeze clarification

Operator selected the existing managed-ignore implementation: add probe storage to `<git-common-dir>/info/exclude`, not tracked `.gitignore`. Preserve init/update no-.gitignore-write contract and add an explicit probe-root guard. Source docpack wording is clarified accordingly; this is not permission to redesign init/update. Explicit freeze remains a separate decision.
