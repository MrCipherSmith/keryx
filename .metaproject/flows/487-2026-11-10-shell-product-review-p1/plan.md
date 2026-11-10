# Implementation plan

Reuse the leased session open and surface reset paths. Preserve the target context and archive independently of display, then render a labeled preview from the target. Give busy recipient dismissal its own result and restore the submitted text. Wire Escape to the current foreground turn when no overlay owns input. Carry Chat cancellation to the provider and keep the chat running. Start shell approvals on Deny and keep explicit Allow once available.

## State × event

| State | Event | Result |
| --- | --- | --- |
| Idle session A with history and usage | Resume B | Load full B context and archive, reset A transcript, block selection and counters, render B preview (AC1, AC2) |
| Idle session A | Resume fails or picker closes | Keep A and its current surface (AC2) |
| Main turn running with recipient picker open | Escape | Restore draft and leave main turn and queue intact (AC3) |
| Main turn running with recipient picker open | Choose Main queue or Side-1 | Deliver only to the chosen destination (AC3) |
| Agent or Chat streaming with no picker | Escape | Abort current request, settle the turn and allow a follow-up (AC4) |
| Approval or overlay owns keyboard | Escape | Keep the overlay's dismissal behavior (AC3, AC4, AC5) |
| Shell approval open | Bare Enter or Escape | Deny with no command side effect (AC5) |
| Shell approval open | Select Allow once and confirm | Run exactly this call (AC5) |

## Verification

Write behavioral regressions and confirm they fail against the baseline. Run the focused regressions and the surrounding terminal tests. Reproduce all five cases in fresh PTYs against a loopback provider and record results.
