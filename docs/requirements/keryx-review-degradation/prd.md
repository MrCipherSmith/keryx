# PRD: review-degradation, a reviewer for "is the code worse than on the base branch"

Status: FROZEN by the operator on 2026-10-28 (Helyx message 230859, after poll 311). Flow 479. No code or skill files exist yet.

## Problem

`review-regression` answers one question: which dependents of the change does it break. It is scope B of a deep round, runs over a code-graph blast radius, and its ingest screen refuses everything below `major`, everything outside the computed set, and every claim that names no changed symbol.

A study of the human reviews on 100 pull requests of one author in a large React/MobX frontend project (October 2026; the data stays private, this PRD is anonymous) shows that the lead human reviewer's regression and quality findings are mostly a different question: **is the code, after this PR, worse than on the base branch?** That question is asked of the diff itself and of every consumer of a shared symbol it touched. `review-regression` cannot ask it. The recurring classes:

1. **Behaviour delta of the diff against base.** An input event that used to be handled by one owner is now caught by another (keyboard Escape bubbling out of a portalled menu closes the whole popup). A decode step now runs twice on one path. Found by probing, not by reading.
2. **Silent default or normalisation change.** An empty value used to fall through to one placeholder and now falls through to another, in every consumer of a shared component. A validation rule gets stricter in one place and looser in another, so a value the backend refuses now passes the client check.
3. **Diff and description disagree.** The description says shared code is unchanged while the diff edits shared files; a label, a form behaviour or a save payload changes with no mention.
4. **Debt introduced by the PR.** A second data model beside the existing one, leftovers of the old API surface, a ref used as state, a dead branch. The reviewer's own words: this is not follow-up material, it is debt and regression of the code.
5. **Performance delta.** Every keystroke rebuilds every row; a second observer is added to every list.
6. **Cross-PR hazard.** Two open PRs conflict, and whichever lands second silently drops the other's fix with no test turning red.
7. **A test that cannot see the regression.** It uses the one input that works, it pins a neighbour of the changed symbol, or the red proof is missing.

Each of these was filed by a human with evidence: a probe, a consumer sweep over the head, a merge-tree of two heads, a red test. Findings without evidence were questions.

## Decision

Add a new reviewer skill `review-degradation`, beside `review-regression`, not instead of it and not by widening it. `review-regression` keeps its scope-B contract and its screen untouched: those are enforced in code and its precision depends on them.

`review-degradation` asks: **after this change, is the code worse than on the base: in behaviour, in defaults, in speed, or in structure, and can that be shown?**

- Scope: the diff against base plus every consumer of each shared symbol the diff changed (the consumer list comes from `keryx gdgraph affected`, not from the model).
- Severities: `blocker`, `major`, `minor`, `info` (no `minor` floor as in scope B).
- Every finding carries a **class** (`behaviour-delta`, `default-change`, `diff-vs-description`, `debt`, `performance`, `cross-pr`, `blind-test`) and **evidence** (`probe`, `consumer-trace`, `merge-trace`, `red-test`, `base-diff`).
- **Fail-closed rule, enforced in code.** Gates written only in skill prose do not hold (see the orchestrator benchmark). `keryx review ingest` downgrades a `review-degradation` finding of `major` or above that carries no evidence to `info` and lists it under a new heading in `scope.md`. It does not reject it: a true claim should survive, labelled as unproven.
- Output lanes: findings, questions, pre-existing, verified clean. A "verified clean" entry names what was traced, so silence cannot read as "nothing found".
- Tier: `deep`, profile `full` only at first. Moving it into `recommended` waits for the trial result below.

## Not in the scope

- No change to `review-regression`, its screen, or scope B dispatch.
- No change to the severity ladder or the exit criterion in `review-orchestrator`.
- No wiring into any private project's own review pipeline, in this flow or because of it (operator decision, 2026-10-28). That project's rules are not copied into keryx; the skill is generic and carries no project text.
- Style, naming and architecture of code the PR did not touch.

## Trial before wiring (operator decision)

A replay on 3 to 5 of the operator's own PRs in the private project, read-only, with the human reviewers' findings as ground truth. The ground-truth set is labelled by hand once, kept in the session scratchpad, and never committed. The public report states counts and classes only.

## Acceptance criteria (draft)

- AC1: `review-degradation` exists as a skill under `.metaproject/skills/gdskills/review/review-degradation/SKILL.md` with its bundled copy under `src/gdskills/bundled/skills/review/review-degradation/`, byte-identical, registered in `src/gdskills/catalog.ts` (`deep`, profile `full`), `src/gdskills/skill-length-ceilings.ts` and `src/gdskills/bundled/install-manifest.json`. Check: the existing catalog, ceiling and bundle-parity tests pass with the new entry.
- AC2: The skill states its one question, the seven classes, the five evidence kinds, the four output lanes and the shared laws, and says in its first screen how it differs from `review-regression`. It carries no project-specific rule name, path or quotation. Check: a skill-text test for the sections plus a denylist test over the skill text.
- AC3: `review-finding.schema.json` (both copies) accepts optional `degradation_class` and `evidence_kind` on a finding, with the closed lists above, and still validates every existing finding. Check: schema tests; the existing fixtures validate unchanged.
- AC4: Ingest downgrades a `review-degradation` finding of `major` or `blocker` without `evidence_kind` to `info`, records it in `scope.md` under its own heading with the rule name, and prints it on the terminal. A finding with evidence is kept at its severity. Other reviewers' findings are not touched. Check: unit tests in `src/review/` for both branches and for a finding from another reviewer.
- AC5: Consumers of a changed shared symbol are taken from the code graph: the reviewer payload carries the `keryx gdgraph affected` set for changed exports, with a recorded cap, as the blast-radius payload does. The summary states whether the cap dropped consumers. Check: payload-builder test with a capped set.
- AC6: Profile and routing: the reviewer is in profile `full` and not in `recommended`; a `delta` round (FIX slice) does not dispatch it unless the slice touches a shared symbol. Check: tests in `src/review/coverage.test.ts`, `src/review/slice-routing` tests and `src/review/caps` tests.
- AC7: Its findings appear in the TUI review panel and reviews inspector with class and evidence kind, and the unproven (downgraded) ones are marked. Check: `src/tui/review-panel.test.ts` and `src/tui/reviews-inspector.test.ts` cases.
- AC8: `review-orchestrator` (both copies, byte-identical, under its line ceiling) lists the reviewer, its profile and when it is dispatched. Check: skill-text test.
- AC9: README, the docs site review guide and CHANGELOG describe the reviewer, the classes, the evidence rule and the downgrade. Check: docs coverage and link tests stay green.
- AC10 (trial): the replay on 3 to 5 PRs reports, per PR, how many of the human lead reviewer's regression and quality findings the reviewer reproduced at the same or an adjacent severity, and how many `major` or above findings it filed that a human then judged wrong. Draft thresholds: at least half of the ground-truth findings reproduced, and no more than one unconfirmed `major` per PR. Below that, the skill is revised and the trial repeated; it is not wired. Check: an anonymous report in `docs/` with counts and classes only; the operator signs the result.
- AC11 (not tied to any project): the reviewer ships as a generic keryx skill in the npm package, profile `full`, and this flow wires it into no project's own pipeline. Check: no file of this flow references a private project's pipeline, and a denylist test over the skill, bundle and docs stays green.
- AC12 (promotion decision): after the trial the report states the cost of a round with the reviewer against the same round without it (tokens, wall time, extra findings kept after ingest) and its effectiveness (AC10 numbers). The operator then decides whether it moves to `recommended` or the core set; until then it stays in `full`. Check: the report carries both numbers and the decision is recorded as an operator decision, not written by the agent.

## Open points for the operator

- Promotion to `recommended` or the core set is decided after the trial, from the cost and effectiveness numbers of AC12.
- AC10 thresholds are a first guess; confirm or replace them before freeze.
