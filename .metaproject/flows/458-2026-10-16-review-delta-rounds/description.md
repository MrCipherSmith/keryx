# Fix rounds review the delta, flows plan states up front, review lines dedupe

Status: formalized
Source: owner (origin: human-request)

## Problem

A vantage-frontend fix (PR #7955, keryx 0.3.117) cost ~13.5 h and ~12.4M subagent tokens, 78% of it review: three rounds of 16/13/11 reviewers + verifier over the WHOLE branch each time, while the working fix was ready after 1 h 50 min; 5 of 9 majors were introduced by fix rounds (no state×event plan), findings were duplicated across up to 7 reviewers with drifting severity, every reviewer ran code, and keryx tooling (ledger root, ingest head) cost extra retries.

Verified on 0.3.119 (anchors in context.md):
- review-orchestrator runs one round; rounds 2+ come from outer loops (flow-orchestrator Phase 4, flow complete/manage, job-orchestrator 2.7, review-pr-feedback `--all` every round, feature-dev, autonomous runner). The orchestrator skill FORBIDS a delta round (RO/SKILL.md:719-723); `review start` has no round awareness; `prior_findings` exists only in a schema.
- A prior round cannot be found across machines: no lookup beyond local `.metaproject/reviews`; 389 committed package files are never searched; published reviews carry no machine-readable block and `comments collect` drops keryx's own comments.
- No duplicate merge or canonical severity; overlapping lines (frontend / project overlay / frontend-conventions / code-boss) all run; nothing limits reviewers running code.
- `projectRootOfPackage` = `pkg/../../..` → `.metaproject/flows` for flow packages; no way to record a deliberately skipped reviewer; ingest without `--head` uses the cwd HEAD, not the package head.
- flow-orchestrator: no state×event matrix, no gate after first green, executor UX tradeoffs only journaled, reviewer `suggested_fix` applied as-is, fix rounds always test-author then implementer.

## Expected Outcome

`keryx review start` itself knows the round: it finds the previous round of the same target from every source (local package, git history, the PR's keryx block, other PR comments, the flow package), and splits the new diff into FIX changes (small roster, prior findings attached, each finding re-checked) and NEW changes (round-1 treatment); unchanged code is not re-reviewed. Every orchestrator gets this by just calling `review start`. Duplicate findings merge with one canonical severity; overlapping reviewer lines collapse to one per slice; only the parent, the verifier and one testing reviewer run code, time-limited. flow-orchestrator plans a state×event matrix for UI/store work, gates after the first green, asks the operator about UX-changing tradeoffs, treats suggested fixes as hypotheses, and runs one implementer when red probes exist.

## Outcome criteria

- Запрос: «в обычном виде будет только 1 раунд… review-orchestrator должен понять что это второй или третий раунд, и для фиксов применить то что мы обсудили, а если пришли новые изменения то для них как в 1м раунде»; «нужно предлагать все возможные источники поиска предидущих раундов» (claude-code session 2026-10-16, after the PR #7955 cost report)
- Эффект: повторный раунд ревью стоит в разы меньше (фиксы — 3–4 роли, новые изменения — как раунд 1, неизменённое не пересматривается) и определяется одинаково на любой машине и при любом оркестраторе; меньше дублей; фло реже порождает новые дефекты фиксами.
- Как наблюдать: на реальном многораундовом PR keryx (#1005 или #992) раунд 2 по новому плану находит дефекты раунда 2 при доле прежних запусков; владелец видит то же на следующем PR vantage-frontend.

## Out of Scope

- Changing what each reviewer looks for.
- GitHub re-review webhooks (the round is detected when review start runs, whoever triggers it).
