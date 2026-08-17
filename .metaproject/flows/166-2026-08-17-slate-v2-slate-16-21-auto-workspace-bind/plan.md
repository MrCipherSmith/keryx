# Plan

Four strictly sequential phases, each its own PR (mirrors how Slate v1 was
shipped this session — review + fix cycle, CI green, merge, then next phase).
Coordinator (this session) waits for CI/merge between phases rather than
letting a dispatched agent poll itself.

## Phase 1 — T1: SLATE-20 (review confirm-token) + T2: SLATE-21 (finish SLATE-7 evidence)
Independent of each other, no file overlap, small — one PR.

## Phase 2 — T3: SLATE-19 (cross-runtime agent-tool parity)
Depends on Phase 1 merged (touches the same `propose`/`review` handlers).

## Phase 3 — T4: SLATE-16 (resolve-or-create) + T5: SLATE-17 (mid-session re-eval)
Depends on Phase 2's `workspace_list`/`workspace_create` tools existing.

## Phase 4 — T6: SLATE-18 (autonomous wrap-up dispatch)
Depends on Phase 2's `workspace_propose` and Phase 3's binding existing.

Trade-off considered: a single big PR was rejected — the spec's own
Recommendation section says SLATE-20 is independently shippable and the
16/17/18/19 block should land together but is still large enough to review
in one pass per sub-step, matching the granularity Slate v1 used (~1
requirement cluster per PR).
