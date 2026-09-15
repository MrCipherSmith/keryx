# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Written against `ea569c92` and the measurements in `context-map.md`.

## Criteria

- AC1: Four new bundled skills exist and pass the flow 257 gate with no exemption and no new entry in `KNOWN_ROUTING_GAPS` or `KNOWN_DESCRIPTION_COLLISIONS`: debugging/root-cause, in-flight adversarial doubt, source-driven development, and deprecation/migration. Each carries the full anatomy (a literal "not for" clause, a Red Flags table of at least three substantive rows unique to it, a Verification section), a description that names when to reach for it rather than what it does, a `SKILL_LENGTH_CEILINGS` entry equal to its line count, and a `BUNDLED_GDSKILLS` registration whose trigger token set collides with no other skill's.
- AC2: Every one of the four has a `ROUTING_CORPUS` entry meeting the corpus's own floors — at least three positives written as a user would ask, at least two of them quoting none of the skill's own triggers, and at least two negatives each naming a different existing skill that must outrank it — and `RANK1_FIRST` / `RANK1_TOTAL` are re-measured in the same commit that lands the last of them.
- AC3: No new skill's description or "not for" clause names another skill in a way that hands that skill the scorer's +30 name bonus on a query the new skill should win; a test case in the corpus proves it for each of the four.
- AC4: Two new rules ship in `src/gdskills/bundled/rules/core/`, byte-identical in the install mirror: a definition of done that reconciles the bar already stated elsewhere, and a CLI interface design rule covering exit codes, stdout versus stderr, `--json` stability and flag deprecation. The definition-of-done rule names, by file and line, every rule whose text it reconciles, and those citations are covered by the `xref:path` sweep.
- AC5: `keryx review floor` exists: a diff-scoped check, built on `buildReviewScope`, that reports a lowered numeric threshold, an added `.skip`/`.only`, a removed assertion, and a new lint or type suppression. Each of the four detections has a fixture diff that fails without the check and a control diff that does not fire, and the command reports nothing on a diff that only adds ordinary code.
- AC6: `keryx review floor` reports its findings on this branch's own diff against `main` and the report is recorded in the flow journal — the guard is run against real work, not only fixtures.
- AC7: The `task-implementer` output contract carries structured `noticed_not_touched`, `assumptions` and `not_touched` fields, declared in `output-contract.schema.json` so a result using them is not refused by `additionalProperties: false`; `task-implementer-contract.test.ts`, `contract-enforcement.test.ts` and `contract-keywords.test.ts` pass, and a test asserts a result carrying all three validates while one carrying an undeclared field does not.
- AC8: `task-implementer`'s `SKILL.md` instructs the agent to fill those three fields and says what belongs in each, and its ceiling is lowered by the number of lines trimmed to pay for the addition — the file does not grow past 670.
- AC9: `interviewer` closes the gap that survives flow 257: a hedged but non-vague answer does not by itself license `ready_to_proceed: true`, and the confirmation step states a confidence per question rather than only per answer. The change is paid for within the file's ceiling of 131.
- AC10: `perf-check` states that a change measuring neutral is reverted, not kept, and that reverted attempts are recorded so the next agent does not repeat them; `review-performance` cites the same bar rather than restating it. Both stay at or below their ceilings (104 and 374).
- AC11: Every technique adapted from `addyosmani/agent-skills` carries an MIT credit in the document that adapts it, following the convention `docs/skills/rejected-skill-changes.md` established. No `THIRD_PARTY_NOTICES.md` is created at the repo root unless `package.json` `files` is changed to publish it, and if it is created the flow says why the inline convention was insufficient.
- AC12: Mirrored bundled and installed files are byte-identical, `bun ./src/cli.ts skills verify --bundled` exits 0, typecheck and eslint pass, and the full `bun test` suite has no failure absent from the baseline recorded in `journal.md`.
- AC13: The final review round against the PR head ends with zero open blocker, major or minor findings, every finding at or above minor carries a terminal disposition backed by a verifier claim from a later round, and `keryx flow complete` passes its review gate.
