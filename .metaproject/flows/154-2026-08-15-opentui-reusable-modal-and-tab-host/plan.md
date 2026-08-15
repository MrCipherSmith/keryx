# Plan

## Approach

Add `src/tui/modal-host.ts` (name per spec) that dynamically uses OpenTUI
like the rest of `src/tui/`. Host owns chrome; callers pass `renderTab`.
Wire overlay via `withOverlay` / `addOverlaySource`. TDD: failing tests
for AC-1…AC-6, then implement.

Rejected: another full-screen `overlayBox` clone (not a panel). Rejected:
shipping `/session-info` in this flow.

## Tasks

T1 context — confirm chrome overlay API and capability gate.
T2 test — headless tests first (TDD).
T3 implement — host matching spec API.
T4 review — code-verifier + review-orchestrator; fix before PR.
T5 verify — focused tests + health on changed scope.
T6 docs — mark package status only if implementation lands; do not overclaim.

## PR

Draft PR from `feat/tui-modal-tabs` → `main`. User pre-selected completion A.
