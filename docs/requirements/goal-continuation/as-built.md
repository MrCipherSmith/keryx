# SLATE-27 — bounded autonomous continuation for `/goal` (as-built)

Implemented in `.metaproject/flows/186-2026-08-21-bounded-autonomous-continuation-for-goal/`
(source of truth for the full design history, including the mid-implementation
acceptance-criteria revisions — see that flow's `journal.md`). This file is a
short as-built summary; `competitor-survey.md` in this same directory is the
research that motivated the feature.

## What shipped

`/goal <text> [--workspace <id>] --auto [N]` — `src/commands/goal-command.ts`.

- **Parsing** (`parseGoalArgs`): `--auto` recognized only when trailing,
  optionally followed by a positive-integer round-cap override, composable
  with `--workspace` in either order. A non-integer value after `--auto`
  is NOT a parse error — it falls through as ordinary goal text, mirroring
  the file's own pre-existing "Review finding 5" resolution for
  `--workspace` (no way to distinguish a real flag from prose that happens
  to contain the token).
- **Auto-provisioning**: when armed and the slate's course has no bound
  flow, `/goal` creates one via `createFlowService` (`src/flow/service.ts`
  — the same service `keryx flow`'s CLI handlers use), using its default
  four-task scaffold and one acceptance criterion tied directly to the goal
  text. `keryx flow plan`'s "model-suggested breakdown" was the original
  design here; it turned out to be purely advisory console output that
  writes nothing to flow state, so it was dropped.
- **The loop**: after the first turn, while armed and the bound flow isn't
  done, re-drives `runAgentTurn` with a synthesized continuation message
  naming the flow's live remaining tasks. The stop condition is
  `slateSession.opened` — observing the SAME `isCourseDone`/
  `courseFromSlate` check `closeSlateOnFlowDone` already runs inside every
  `runAgentTurn` call's own `finally`, not a second implementation of it.
- **Verifier**: before the final stop, one `spawn_subagent` (`mode:
  "read_only"`) call independently checks whether the stated goal was
  actually achieved. On a rejected verdict with round budget remaining, the
  loop reopens the slate (fresh Anchors injected) and rebinds it to the
  SAME flow/workspace for exactly one more round — a single second chance,
  not a re-verify loop.
- **Isolation**: the armed round budget lives only on the in-memory
  `SlateSessionRef` (`src/session/slate-lifecycle.ts`) for the current
  attempt — never in `slate.json` — so a resumed or forked session never
  silently inherits an unattended loop.

## Deliberately out of scope (v1)

- No new persistent goal-state file — Task Manager's `flow.json` is the
  durable record.
- No cross-session autonomous resumption.
- No general adversarial multi-skeptic committee — one verifier call per
  `/goal --auto` invocation.
- No change to approval-mode semantics — every tool call inside every
  round still goes through the existing `resolveApprovalDecision` gate,
  unchanged.

## Verification

- 49 tests in `src/commands/goal-command.test.ts` (31 new), covering all 9
  frozen acceptance criteria.
- Live end-to-end smoke test in both the readline shell (`shell.ts`) and
  the full TUI (`tui-shell.ts`), against a real local model
  (`rapid-mlx/qwen3.5-4b-4bit`): a trivial `--auto`-armed goal correctly
  auto-provisioned a flow, ran a real approval-gated `shell_exec`, streamed
  round-progress output live in both shells, and the verifier correctly
  judged the stated goal achieved even though the flow's generic scaffold
  tasks were not all marked done.
- Full project suite: 5281 pass / 47 pre-existing unrelated fail (macOS
  path/sandbox environment issues in `serve-server.test.ts`, unrelated to
  this change) / 18 skip.
