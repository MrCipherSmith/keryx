# Keryx Review-Depth Parity PRD
Version: 0.1.0 (draft, awaiting the operator's AC review and freeze)

## Origin

- **origin:** `~/notes/review-depth-gap-7659.md` (keryx vs a Claude-driven review of the same pull request, 2026-10-12) and `~/notes/flow-417-ac16-findings.md` (the file read for this draft ends at section M; there is no section N yet, so the review-depth evidence is taken from sections G, H and M: run 9 depth check, run 11 payloads, the cycle 17 completion gate). The notes are the evidence base; every number below that is not marked "to be measured in T1" is quoted from them.
- **trigger:** the flow 417 AC16 live run and the review gap on PR 939/940. AC16 asked for a keryx review round that matches a Claude-driven review. Cycle 11 reached the same five Major findings as Claude but took about 2h20m against about 18 minutes. The PR 7659 comparison then showed that even a completed keryx round is shallower than the Claude one: 0 major, 3 minor against 1 major, 14 minor, 3 questions.
- **owner:** MrCipherSmith.

## Problem

A keryx review round reaches a closed package, but not the depth of a review driven by Claude on the same pull request. On PR 7659 (the comparison in the first origin note):

| | Claude | keryx |
|---|---|---|
| Result | 1 major, 1 cycle, 14 minor, 3 questions (19 items) | 0 major, 3 minor |
| Reviewers | 13 agents | 10 of 11 completed |
| Raw findings | about 40 (estimate in the note) | 5 (3 after merge) |
| Mutation pass | 12 mutants run in a copy of the worktree, A/B/F/G survived | not run |

The note classifies the 19 Claude items against keryx output: A = reviewer never started (6 items), B = reviewer ran, nothing in its raw answer (5), input truncated (1), C = found but lost by a filter (1, in prose only), D = kept (4, one of them with understated severity), E = execution pass missing (1, and it is the reason the single major was understated). The conclusion of the note: the loss is **before** the filter. Merging and de-duplication worked; the raw findings differ by a factor of about 8, not the filtering.

The note names five causes, in order of weight:

1. **The reviewer set is narrowed to `diff`.** `keryx review required --mode diff` excludes architecture, performance, clean-code, highload and security ("not derived from the changed files"). That alone accounts for 5 of the 6 A-class items. The orchestrator rule is "`all` for `--all` or no narrowing flag; `diff` only when the operator named a narrower mode"; the operator named none.
2. **Path matching is broken for project-skill reviewers.** `review-vantage-domains` (paths `src/analytics/**`, `src/pipelines/**`, `pathsSource: description`) is excluded as `no-matching-paths` although 12 of 13 changed files are under `src/pipelines/**`. Reproduced with `keryx review required --mode diff` on a scope of a single `src/pipelines/index.ts`; also reproduced in `all` mode. The path parser is correct (`reviewerPathGate` returns the right paths); the glob tokens from the description do not reach the matcher. The code location is not found by text search.
3. **The execution (mutation) pass is optional and not deterministic.** There is no `keryx review mutate`. `research.json` records `executionRequired: false` for all 10 runs with the reason "source-only review", even for the testing reviewer that returned `DONE_WITH_CONCERNS` with a ready script of 6 mutants. The closing step accepts `Not run: mutation pass` because the skill text carries a rule meant for unattended runs, while this run had an operator in Telegram. Without a run there is no red evidence, so no reviewer can legitimately issue `major`, and the verifier can only delete, never raise. That is why the rule "behaviour without a pinned assertion is major" (it lives in the target project's `reviewing.md` item 4 and `testing.md`) reached the keryx reviewers but produced `minor`.
4. **Per-role depth.** The same files and the same diff, but Claude agents received a context pack (round-1 fix intent, reviewer comments, CI status, backend pins) while keryx handed over `comments.json` truncated to 800 characters.
5. **`review-regression` is not in the required set.** Blast radius was computed (40 of 795 files) but no regression reviewer ran. Claude had one, with "30 files / 249 tests" on dependents.

Section G (run 9) of the second note adds the shell-side evidence: raw reviewer outputs were tiny (performance 16 B, security 66 B, backend 200 B, architecture 356 B, largest 1.4 KB), so a 12-wide set was reached while each reviewer returned a cursory result.

## Goal

A keryx review round on a pull request reaches the depth of a Claude-driven review of the same pull request: the same reviewer roles run, project reviewers are selected by their own path rules, the testing reviewer's mutation pass is executed deterministically, severity follows evidence, and the reviewers see the same context a Claude reviewer sees. Depth is **measured** against the PR 7659 baseline, not asserted.

## Non-goals

- Shell stability and flow-control defects (sections A and D-M of the first note: follow-through of an open plan, slash-command queue, Ctrl+C, hangs, approvals). They are separate tracks.
- Telegram / remote control (section B of the first note).
- The metaproject layers as review context (gdgraph, gdwiki, memory, testing context, flow state). That is the sibling package `docs/requirements/keryx-review-metaproject/`. The two packages share one context-pack builder; the boundary is fixed in R5 below.
- A new reviewer taxonomy. The roles are the ones keryx already ships plus the project reviewers.
- Making Jev part of this flow. Jev triage (`docs/requirements/keryx-jev-review/`) stays additive and advisory.
- Changing the delete-only discipline of `review-verifier` (see Decision 1: severity audit is a separate pass).

## Users

- The operator, who today cannot trust "0 major" from a keryx round and re-runs the review with Claude.
- Maintainers of project reviewer skills (for example the Vantage Frontend skills), whose path rules must be honoured.
- `review-orchestrator`, the closing gate (`review complete`) and `keryx review required`/`dispatch-check`, which carry the rules changed here.

## Requirements

### R1 - The full set is the default for a pull request

For a PR review, `keryx review required` uses mode `all` unless the operator named a narrower mode. `diff` requires an explicit operator instruction, recorded as a quote. `keryx review dispatch` (and `dispatch-check`) refuses a reviewer set narrower than `required` without that quote. The default is applied in the orchestrator prompt and in the autonomous profile (`autonomous-profile.ts` per the note; location to be confirmed in T1). The coverage report states, for every role absent from the set, whether it was excluded by an operator quote or by a path rule.

### R2 - Project-skill path gates work

The glob tokens from a project reviewer's description (and `metadata.paths`) reach the matcher. A project reviewer whose paths match the changed files is not excluded as `no-matching-paths`, in `diff` and in `all` mode. A regression test pins the PR 7659 case (a scope of a single `src/pipelines/index.ts` selects `review-vantage-domains`) and the second reported case (`review-vantage-core` for `src/core/x.ts`). The fix finds and removes the cause in the assembly of `required`/`skipped`, not by adding an override.

### R3 - A deterministic mutation pass

A new command `keryx review mutate` (proposed name) runs a bounded set of mutants:

- it works in a **copy** of the worktree and restores the original in a `finally` block;
- an anchor must match exactly once, otherwise the mutant is recorded as `not-applicable`, never silently skipped;
- the cap is selectable (`--cap 6|12`, the values used in the note);
- the baseline run of the targeted tests is recorded first (the note's baseline: 27 of 27 green); a red baseline stops the pass with a named reason;
- the outcome table (mutant, file, line, killed or survived, test that killed it) is written under `research-evidence/` and referenced from `research.json`.

Mutants come from the testing reviewer's own proposal (the script the reviewer already returns) or from a deterministic default set (to be chosen in T1: boundary flip, guard removal, `??` default removal, executor swap are the classes seen in the note).

### R4 - Closing rule for execution

When the testing reviewer returns "mutation pending" and the tests or the script are executable, `executionRequired` is `true` and `Not run: mutation pass` is not an acceptable closing state while an operator is present. It stays acceptable in an unattended run (the existing rule) and for an explicit operator quote. `review complete` refuses with the exact command to run (`keryx review mutate ...`). An environment that cannot run the tests (no browser, no server, missing toolchain) is a named, recorded reason, not a silent `Not run`.

### R5 - One context pack for the reviewers (pull request section)

A deterministic builder (proposed: `keryx review context`) produces a versioned context pack per round and hands each reviewer a slice of it. This package owns the **pull-request section**: full text of every review comment and PR body (no 800-character truncation; if a cap stays it is stated in the pack and in the report), round-1 fix intent and the previous round's findings and decisions, CI status and the failing job summary, and the pins the PR names (for example the backend commit). The sibling package `keryx-review-metaproject` adds the metaproject layer sections to the same builder. The pack has a content hash; reviewers receive references plus the slice they need, not an identical 58 KB blob each (run 11 payloads: 58 KB of `review_context` identical for every reviewer; per-reviewer filtering is T1 measurement and design work).

### R6 - Regression reviewer in the required set

When blast radius is computed for the round (`keryx review blast-radius`), `review-regression` is in the required set and receives the dependents and their tests. If blast radius is not computed, the coverage row says so with a reason, never a silent absence.

### R7 - Severity follows evidence

The rule "behaviour without a pinned assertion plus a surviving mutant = major; without a run = minor marked `unproven`" is part of the review contract:

- a finding that cites a surviving mutant from the R3 table may carry `major`; a finding with no execution evidence is capped at `minor` and labelled `unproven` in `findings.json` and in the report;
- raising a severity is a **separate pass** (`severity audit`) that consumes the R3 table and independent reviewer agreement; `review-verifier` keeps its delete-only contract (see Decision 1);
- the audit never raises on reasoning alone (the existing reasoning-capped verdict discipline stays).

### R8 - A floor of substantive raw evidence per reviewer

`review complete` checks that every required reviewer produced substantive evidence for the slices it was assigned: at least the assigned-slice coverage record, and a raw answer that is not an empty `{"findings":[]}` without a statement of what was read. The thresholds (minimum evidence size, slices covered) are **to be measured in T1** from the PR 7659 and PR 7435 runs; no number is fixed in this draft. An empty-by-construction answer is recorded as `shallow`, shown in coverage, and fails the gate unless the operator accepts it with a quote.

### R9 - Measurement and control

The package ships a repeatable comparison: re-run PR 7659 in mode `all` and classify the 19 Claude items against the result with the same A-E classes, then run the control PR 7840 to check that no false major appears. Time, input tokens and cost are measured before and after (the note: mutation costs 6-12 test runs). The classification lives in a checked-in fixture so a later change can be compared.

### R10 - Surfaces (TUI and CLI)

Every function above that a person uses has a visible surface (details in the acceptance criteria): the existing `/review` and `/reviews` inspectors (`src/tui/review-inspector.ts`, `src/tui/reviews-inspector.ts`) show the required versus dispatched set with the exclusion reason per role, the mutation outcome table, `unproven` severities and the shallow-evidence flags; a sidebar line reports the round's depth state; a settings-modal entry (`src/tui/settings-model.ts`) sets the default mode and shows that `diff` needs an operator quote; `keryx help` documents `review mutate` and `review context`.

## Success criteria

- On PR 7659 in mode `all`, no Claude item is in class A; the single major is reached when a mutant survives; at least 12 of 19 Claude items are found (the target stated in the note; the operator confirms it in Decision 4).
- The raw findings per reviewer rise from 0-2 to the order of 3-7 on the same files (the note's target; confirmed in Decision 4).
- On the control PR 7840 no false major appears.
- `Not run` in a closed package with a live operator is 0 without an operator quote.
- Every reviewer path rule in the PR 7659 scope selects the reviewer it names.

## Risks

- **Cost and time.** `all` plus mutations is slower and dearer than `diff`. The measure is T1 and R9; the operator decides the acceptable ceiling (Decision 2). Cheaper tiers for mechanical roles stay available through the existing routing; the gain must not be paid for by quality (the flow-reviewer PRD records the same risk).
- **Mutation on an unfamiliar repository.** A wrong anchor or an unrunnable test suite gives noise. R3 records `not-applicable` and a red baseline as stops, never as "killed".
- **False majors from the severity rule.** A surviving mutant in a weak test is a real test gap, but a major can be over-claimed. The control PR and the audit pass (R7, R9) exist for that.
- **Thresholds invented too early.** R8 deliberately leaves the numbers for T1.
- **Overlap with the sibling package** on the context builder. Mitigated by the R5 boundary and Decision 5.
- **Evidence limits.** The classification in the note rests on raw answers and reports; Claude's own raw answers were not available, and the "about 40 raw findings" figure is an estimate (the note says so).

## Tasks

- **T1 - Baseline measurement, before any code change.** Re-run PR 7659 in `all` mode on the current release without changes; record reviewers run, raw findings per reviewer, time, tokens, cost, the A-E classification; reproduce the path-gate defect (R2) on a fixture; measure raw evidence sizes for the R8 thresholds; locate the code sites the notes could not (path gate assembly, autonomous profile, the closing rule text). Every "to be measured in T1" in this package is answered here.
- **T2** - R1, R2 (selection correctness). **T3** - R3, R4 (mutation pass and closing rule). **T4** - R7, R8 (severity and evidence floor). **T5** - R5, R6 (context pack and regression). **T6** - R9, R10 (comparison fixture and surfaces). Final: replay and control run.

## Decisions needed from the operator

1. **Severity upgrade path.** Recommended: a separate `severity audit` pass that may raise a severity only on execution evidence (a surviving mutant), leaving `review-verifier` delete-only. Alternative: let `review-verifier` raise. The second weakens a discipline built on measured results (delete-only, execution beats reasoning).
2. **Default mode for a pull request.** Recommended: `all` by default, `diff` only on an explicit operator quote. Alternative: keep `diff` and have the orchestrator ask. The note's data says `diff` loses 5 of 6 A-class items. Related: the acceptable time and cost ceiling per round (to be proposed from T1 numbers).
3. **Mutation policy with a live operator.** Recommended: execution is required, `Not run` is allowed only with an operator quote or a recorded environment reason. Alternative: required only when the testing reviewer asks for it. The note found the latter let the pass slip through.
4. **Parity targets.** Recommended: use the note's targets (A = 0, at least 12 of 19, raw findings 3-7 per reviewer, no false major on PR 7840) as the frozen numbers. Alternative: freeze only A = 0 and the no-false-major control, and set the rest after T1.
5. **Ordering and the shared context builder.** Recommended: this flow first; it creates the pack skeleton with the pull-request section (R5); the metaproject flow adds layer sections to it. Alternative: build both sections in one flow, or the other order.
6. **Evidence floor strictness (R8).** Recommended: a `shallow` reviewer fails the gate unless accepted by an operator quote. Alternative: warn only, never fail.
7. **Scope of mutants.** Recommended: the testing reviewer's proposal plus a small deterministic default set, cap 6 by default, 12 on request. Alternative: only reviewer-proposed mutants.
