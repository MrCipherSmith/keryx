# Implementation Plan

Status: draft (for operator review before freeze)

## Approach

Verification result first: of the 16 findings in the two flow 376 review rounds, 15 are fixed on main
(4f1326d2; F-001 further hardened by bbfaa901) and F-011 was dismissed by the operator. This flow takes
only the two residuals the reviews recorded themselves: the missing ack for approval frames (F-004) and
the untested shell call sites (F-010, F-014, F-015, F-016). One flow, because both touch the same
shell/serve surface and one version bump.

Approval ack: add one shell-to-serve post for an approval id (same auth and proof as the other shell
posts), keep the approval entry's finish step but move it behind the ack with a short timer. Version
skew inside one package is not a concern; an old shell with a new serve would show "not confirmed",
which is the safe wording.

Call sites: move the four closures out of `tui-shell.ts` into a module that takes its dependencies
(queue accessors, `remoteBridge`, `io`), import it there, test it directly.

## Steps

1. T1 context: re-read http-surface `pressApproval`, client `resolveApproval`, tui-shell call sites.
2. T2 implement the ack (client post, serve route, delayed finish, `APPROVAL_ACK_MS`, late and foreign acks).
3. T5 extract the TUI wiring module and write the call-site tests (record the per-call red check in the journal).
4. T3 tests for AC1-AC5, TUI line and counter.
5. T6 docs, CHANGELOG, wiki, version bump, extend the docs test.
6. T4 self-review, draft PR.

## Risks

- A delayed finish keeps the buttons on the message a few seconds longer; the replay guard
  (`finished`) must treat a press during the wait as already answered.
- tui-shell.ts is large; the extraction must not change behaviour (existing main-queue and
  shell-bridge tests stay green).
- The operator may prefer to drop AC5's counter; it is the part most open to taste.
