# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source of the wording: `docs/requirements/keryx-review-degradation/prd.md`, frozen by the operator on 2026-10-28 (Helyx message 230859). The reviewer is a generic keryx skill in the npm package, profile `full`; no project's own pipeline is wired in this flow.

## Criteria

- AC1: `review-degradation` exists as a skill under `.metaproject/skills/gdskills/review/review-degradation/SKILL.md` with a byte-identical bundled copy under `src/gdskills/bundled/skills/review/review-degradation/`, registered in `src/gdskills/catalog.ts` (tier `deep`, profile `full` only), `src/gdskills/skill-length-ceilings.ts` and `src/gdskills/bundled/install-manifest.json`; the existing catalog, ceiling and bundle-parity tests pass with the entry. [verify: exec `bun test src/gdskills/`]
- AC2: The skill states its one question, the seven classes (`behaviour-delta`, `default-change`, `diff-vs-description`, `debt`, `performance`, `cross-pr`, `blind-test`), the five evidence kinds (`probe`, `consumer-trace`, `merge-trace`, `red-test`, `base-diff`), the four output lanes and the shared laws, and says in its first screen how it differs from `review-regression`; it carries no project-specific rule name, path or quotation. [verify: exec `bun test src/gdskills/review-degradation-skill.test.ts`]
- AC3: `review-finding.schema.json` (every copy) accepts optional `degradation_class` and `evidence_kind` with those closed lists, and every existing finding fixture still validates unchanged. [verify: exec `bun test src/contracts/ src/review/`]
- AC4: `keryx review ingest` downgrades a `review-degradation` finding of `major` or `blocker` that has no `evidence_kind` to `info`, records it in `scope.md` under its own heading with the rule name, and prints it on the terminal; a finding with evidence keeps its severity; findings of other reviewers are not touched. [verify: exec `bun test src/review/degradation-screen.test.ts`]
- AC5: The reviewer payload carries the `keryx gdgraph affected` consumers of each changed shared export, with a recorded cap, and the summary states whether the cap dropped consumers. [verify: exec `bun test src/review/degradation-payload.test.ts`]
- AC6: The reviewer is in profile `full` and not in `recommended`; a `delta` round (FIX slice) dispatches it only when the slice touches a shared symbol. [verify: exec `bun test src/review/coverage.test.ts src/review/dispatch.test.ts src/review/slice-routing.test.ts`]
- AC7: Its findings appear in the TUI review panel and reviews inspector with class and evidence kind, and findings downgraded for missing evidence are marked as unproven. [verify: exec `bun test src/tui/review-panel.test.ts src/tui/reviews-inspector.test.ts`]
- AC8: `review-orchestrator` (both copies, byte-identical, under its line ceiling) lists the reviewer, its profile and when it is dispatched. [verify: exec `bun test src/gdskills/`]
- AC9: README, the docs-site review guide and CHANGELOG describe the reviewer, the classes, the evidence rule and the downgrade. [verify: exec `bun run docs:check`]
- AC10: A replay on 3 to 5 of the operator's own pull requests in the private frontend project, read-only, with the human lead reviewer's regression and quality findings as hand-labelled ground truth (kept in the session scratchpad, never committed), reports per PR how many ground-truth findings were reproduced at the same or an adjacent severity and how many `major` or above findings were judged wrong by a human. Draft thresholds, confirmed by the operator: at least half reproduced and at most one unconfirmed `major` per PR. The public report is anonymous: counts and classes only. [verify: judged]
- AC11: The skill, bundle and docs contain no reference to a private project's pipeline, rule names or paths, and this flow wires the reviewer into no project's own pipeline. [verify: exec `bun test src/gdskills/review-degradation-skill.test.ts`]
- AC12: After the trial a report states the cost of a round with the reviewer against the same round without it (tokens, wall time, findings kept after ingest) and its effectiveness (AC10 numbers); whether it moves from `full` to `recommended` or the core set is recorded as the operator's decision, not written by the agent. [verify: judged]
