# Review engine speedup, step 3: chunk-pass findings reach the round (R4, E3.7.1-E3.7.4)

Status: draft (flow-init skill formalizes this)
Source: user description (origin: human-request)

## Problem

On the closed vantage-frontend round #8111 a chunk pass of `review-regression` found a major defect (R-001, `src/workspace/store/workspace-routing-store.ts:218`). `keryx review chunks merge` wrote it to `chunk-pass.json`, and nothing read it again: the only reader of the pass is the coverage count. The round's `findings.json` does not hold R-001, `review complete` closed without a word about it, and the skill has no step that carries pass findings into the round. Even a hand-made entry in the `keryx:findings` block would not survive `review ingest`: the scope-B screen applies to every finding whose reviewer is `review-regression`, and it rejects R-001 twice (`outside-set`: the file is neither changed nor in the blast radius; `no-link-to-change`). A pass that traces callers outside the set is the purpose of the pass, so the screen deletes exactly what the pass was run to find.

## Expected Outcome

- `chunks merge` prints the findings of the pass (id, severity, `file:line`, chunk) and, when some of them are not in the round's `findings.json`, a line `N chunk-pass findings not in round`; `--json` carries `findings` and `notInRound`. A package whose pass has no findings prints what it printed before.
- `review complete` does not stay silent about pass findings that are not in `findings.json`: it warns in its output and in `report.md`. It does not refuse (variant A, poll 283).
- `review ingest` brings the pass findings of the package into the round, from the live chunk state, as findings of reviewer `review-regression/chunk-NNN`. For those findings the screen does not apply `outside-set` and `no-link-to-change` and says so in its record; the `minSeverity` floor stays, so a minor from a pass is still dropped.
- The `review-orchestrator` skill has the step: pass results enter the collection of results, the verifier and the premise wave see them like any other finding, and a pass that finishes after the report was written is followed by a new ingest and a new report.

## Outcome criteria

- Запрос (дословно): «/home/altsay/arena/ideas/pr-review-management/23_KERYX_IMPLEMENTATION_PROMPT.md» (source: Helyx message 226364, 2026-10-25; R4 order: poll 293; scope and variant A: poll 283; start: poll 301)
- Эффект (формализация агента): a finding that a chunk pass raised cannot be lost between `chunks merge` and the closed round: it is shown when the pass is merged, recorded by ingest, and named by `complete` when it is still missing.
- Как наблюдать (предложение агента): on a copy of vantage-frontend #8111 `keryx review chunks merge --package <copy>` prints R-001 with `workspace-routing-store.ts:218` and the line `1 chunk-pass findings not in round`; `review complete` warns; after `review ingest` R-001 is in `findings.json` with reviewer `review-regression/chunk-001` and is not in the screen's `rejected`; on a copy of #8158 (no pass findings) the output of `merge` is unchanged.

## Out of Scope

R5 and R6 of the package (they wait for the operator's word), E3.1-E3.6 (speed of the passes), E4.5-E4.7, E5-E7, the PR-management service. No refusal in `review complete` (variant B was not chosen). No de-duplication of R-001 against F-009 (a different path and line, no decision yet). No human labelling of pass findings. No change to the retry accounting of R3 or to the wave events of R1+R2.
