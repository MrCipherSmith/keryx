# Implementation Plan

Status: ready to freeze

## Approach

Separate focus ownership from rendering cost. Restore the previous live, attached, visible focus when a composer choice closes, without stealing newer modal/field focus. Use a bounded mounted transcript window for old completed blocks; never destroy a node still updated by streaming or side-worker callbacks. Persistent session archive is outside the rendering window and must remain unchanged.

Evidence: PTY synthetic streaming baseline at 4000 user/assistant messages had 22093 mounted nodes and 145.4 ms median / 185.7 ms p95 key-to-frame latency; all 120 probes arrived. Busy Side-1 submission reached the side provider but left no focus. These are controlled reproductions, not a direct measurement of c053e35.

## Steps

1. T1: Freeze criteria and preserve benchmark/context evidence.
2. T2: Review and integrate external focus patch; implement safe completed-history mounting bound with protected nodes and explicit older-history access. External run 688e927f-c9fc-4222-a1e2-a4967d20cf3f only prepared the focus patch; history bounding is not implemented.
3. T3: Run real-renderer focus/history regressions and type checks; verify tests fail without the corresponding implementation.
4. Additional test task: Repeat PTY streaming and busy submission measurements with the same history points and report distribution and probe losses.
5. T4: Independent review, resolve findings and hand off without PR/merge/push.

## Risks

- Destroying historical renderables can invalidate active callback references; prefer detachment with explicit ownership and remounting until safe lifecycle integration is proven.
