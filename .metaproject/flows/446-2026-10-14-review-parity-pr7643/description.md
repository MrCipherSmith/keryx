# Review parity: pre-filter, mutation contract, PR-contract role, follow-up closure, severity policy, AC8 bugs

Status: draft, awaiting operator review of PRD and AC before freeze
Source: user description (origin: human-request)

## Problem

The AC8 live run of flow 419 reviewed a merged frontend PR of a private client project with the 0.3.114 gates inside `keryx shell`, then was compared with the published Claude reference review of the same PR. keryx matched 3 of the reference's 6 minors and missed 3: a mutant on a `?? ""` fallback, a documentation sentence outside the diff (PR checklist "Documentation needed" unticked), and a two-line comment that a comment rule limits. It also graded two survivors as major where the reference held them at minor. 17 of 19 reviewer replies were empty. Root causes, each traced in the review package of that run:

1. The scope pre-filter dropped the comment-only hunk (`prefilter:comment-only`), although the repository has a comment rule and that hunk is the thing the rule checks.
2. On a shell host the reviewers cannot execute; the main session chose 3 mutants by hand (scope limited to the added conditional only). No reviewer proposed mutants for code downstream of the diff, and `not_reached` is not part of the code or the report.
3. No role owns the PR-body checklist or documentation outside the diff.
4. `Parent follow-up:` lines in raw replies are free text; nothing turns them into obligations.
5. The severity audit raises every surviving mutant to major, whatever kind of mutant it is.
6. By-products: `keryx review dispatch-check` rejects the generator's own `model.routed` field; review-layout loops on NEEDS_CONTEXT when the reviewer cannot run a browser.

## Expected Outcome

keryx reviews a PR at least at the level of the published reference: on the the reference PR fixture every reference finding is either raised or explicitly reported as not run, severities do not exceed the reference without an observable-behavior reason, and no gate fails on keryx's own output.

## Outcome criteria

- Запрос (дословно): «Разбери оба прогона и сравни что можно, найди причину расхождения. Keryx должен ревьюить минимум на том же уровне» (source: helyx 204797, 2026-10-14 11:11)
- Эффект (формализация агента): a review of the same diff loses none of the reference's findings silently: comment-rule hunks are kept, mutants come from reviewers and the report says how many were not run, docs and PR-body mismatches have an owner, follow-ups are closed or reported unverified, and presentation-only survivors are not raised.
- Как наблюдать (предложение агента): replay of the stored the reference PR diff through the new scope and ledger code in tests; `report.md` shows a `Not run: N candidates` line and a follow-ups section; operator re-runs the AC8 procedure on the next real PR and compares with the reference again.

## Out of Scope

- Live runs of external agents and any re-run of the whole 19-role review on the reference PR without the operator's OK.
- Vantage-specific reviewer skills (they live in the client project, not in keryx).
- Changing the verifier (it stays delete-only).
- Cleaning stale worktrees and the stale local `~/keryx` checkout.
