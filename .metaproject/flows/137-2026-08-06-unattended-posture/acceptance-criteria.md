# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: `docs/requirements/keryx-unattended-posture/specification.md` §Acceptance
criteria. The corpus referenced by AC2–AC5 is C-1 … C-5 of that document.

## Criteria

- AC1: A scripted read-only run completes with `human_interventions: 0` and produces a correct answer to a real project question.
- AC2: Every line of corpus C-1 is refused under every posture the mechanism offers and every grant it accepts; a real-runner pass leaves the fixture tree, the graph index and `package.json` unchanged, and `.env` unread.
- AC3: Every pattern in corpus C-2 is either refused at launch or rendered harmless by the mechanism; the test states which, per line.
- AC4: Every escape in corpus C-3 is refused or contained.
- AC5: Every input in corpus C-4 is refused or confined, asserted end-to-end against real ripgrep, including the symlink case.
- AC6: Corpus C-5 holds: a benign action demonstrably runs under the posture, and the unflagged default still prompts with byte-identical wording.
- AC7: A policy `deny` is terminal under every posture, and an `ask` with no approver resolves to `deny`; both asserted by tests rather than by unreachability.
- AC8: Reverting each individual guard fails at least one test in the corpus, and the report names which guard and which test. A guard nothing pins is not a guard.
- AC9: No documentation sentence asserts a category guarantee that the mechanism implements as a list; if a list survives anywhere, the docs say it is a list and that it will be incomplete.
- AC10: Containment contains no decision of the form "the command word is on a list of bad ones"; the report states, for each refusal path, the property that produces the refusal.
- AC11: The posture is visible in the TUI header and recorded in the run record, so an unattended run is distinguishable from a supervised one in the evidence.
- AC12: `bun run check` and `bun run check:doc-links` pass, with no test skipped or weakened.
