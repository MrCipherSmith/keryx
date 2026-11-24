# Desktop Review v2: Fix findings action launches a Flow from a Review

Status: formalized
Source: session brief (Desktop Review v2, last missing item); docs/requirements/keryx-desktop-review-v2 (prd.md R7, specification.md «Исправить замечания», implementation-plan.md stage 4 row)

## Problem

Desktop Review v2 stages 0–4 are merged, but the plan's stage-4 item «Действие «Исправить замечания» как Flow» was never built: stage 1 deferred it and the stage-4 brief left it out. A user whose own pull request has open Keryx review findings has no Desktop action that turns those findings into a managed fix Flow; they must start a session and describe the findings by hand.

## Expected Outcome

- The Review panel in the Reviews tab offers a labelled "Fix findings" action on a Review of the viewer's own open pull request whose latest reviewed result has open findings (blocker, major or minor).
- Pressing it uses the existing "Create Flow" path of stage 1: the PR's bound session (newest, else a new session bound to the PR) opens with a prepared, unsent prompt that asks flow-orchestrator to create a fix Flow for the PR seeded with those findings, naming the Review round, the reviewed range, the counts and the exact `keryx review desk-run status` command that returns the findings of the reference attempt.
- The one new flow package that then appears is offered on the PR's work row ("Link Flow #N?") exactly as for Create Flow, so the Flow is bound to the PR only on the user's Link.
- The plan records the item as done.

## Outcome criteria

- not measured — a Desktop action whose use is not instrumented; the evidence is the tests and a later live run.

## Out of Scope

- New flow creation paths, a new CLI command, or auto-sending the prompt: the user confirms by sending it.
- The PR-card variant keyed on GitHub `CHANGES_REQUESTED` or unresolved threads (spec "Pull requests · Действия"): recorded in the plan as deferred.
- Moving the subscription auto-fix settings (O19) into rules.
- Real-PR manual scenarios (stage 3 AC9, stage 4 T10).
