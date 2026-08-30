# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `filter_stats` is written into the round's structured output — `{total, dropped_prefilter, dropped_low_confidence, dropped_refuted, retained, by_reason}` or a superset — by the producer that does the filtering, not assembled afterwards from prose.
- AC2: Every count distinguishes **measured zero** from **not measured**. A stage that did not run reports as absent or `null`, never as `0`. A test asserts the two are distinguishable in the recorded artifact, because instrumentation that reports zero when nothing measured reads as a clean result and is worse than none.
- AC3: `filter_stats` has a consumer. At least one command or gate reads it back and does something with it — reports it, checks it, or refuses on it. A field nothing reads is the `attempts.count` defect repeated, and this flow exists to stop that class.
- AC4: The four dismissal states are distinguishable end to end, and only `dismissed-incorrect` is treated as model error. A test asserts that a `dismissed-wont-fix` finding contributes nothing to the model-error signal.
- AC5: `.metaproject/memory/review-notes/` is written by the pipeline when a finding is dismissed as incorrect, closing the loop the roadmap records as never having produced anything. The note names the finding, the reason, and the commit or round it came from.
- AC6: A dismissal still requires a recorded human decision, unchanged from AC6 of flow 204. Adding a taxonomy must not create a path where the orchestrator classifies a finding as its own error and moves on unattended.
- AC7: The 65 bundled skills are evaluated by something that runs. Structural validation at minimum: required frontmatter, resolvable cross-references, no concrete model name, no persona or home-directory path. It runs over the whole tree with a non-vacuity assertion on the denominator.
- AC8: The evaluation is demonstrated to FAIL a skill that deserves to fail. A judge that approves everything measures nothing; the proof is a deliberately broken fixture skill that the evaluator rejects, and the test asserts the rejection reason.
- AC9: Cross-family review reads the existing provider configuration (`llm-providers.json` / `src/lib/provider-config.ts`) rather than introducing a second source of provider truth.
- AC10: Cross-family review is **opt-in and recorded**. It is never a silent default — dispatching to another provider spends tokens and sends code to a second vendor — and the round records which family reviewed, so a recall comparison is possible later.
- AC11: With no second provider configured, everything degrades to single-family review with a stated reason and exit 0. Absence of a second provider is a normal state, not an error.
- AC12: Every claim this flow's prose makes about enforcement is wired, or the claim is not made. Softening a verb is not a resolution. Carried forward from flows 205 and 206 because this flow writes new prose about instrumentation.
- AC13: Both trees carry every skill, rule and schema edit; verified by diff, with the mirror and build-parity guards passing.
- AC14: `bun run typecheck` clean; `bun test` has no new failures against the baseline recorded in this flow's journal; `bun run test:guards` 0 fail; `bun run check:doc-links` 0 broken.
