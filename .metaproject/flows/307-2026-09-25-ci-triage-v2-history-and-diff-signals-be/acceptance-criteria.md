# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Triage computes deterministic signals for each failed job before asking Jev: (a) whether the same job or test passed on another attempt of the same run, (b) how many recent runs on other branches failed the same test and whether they later passed, (c) whether the run's diff changes the failing test file or files in its directory or files it imports, and (d) timeout/infra markers in the log (runner lost, network, OOM, timed out); each signal is computed through the read-only CI port and git, never a write.
- AC2: The signals are placed in Jev's `state` as a short, labelled block above the redacted log excerpt, within the existing 64k budget and after redaction, and the questions are rewritten to ask about them explicitly; a unit test pins the state layout and that no signal leaks unredacted text.
- AC3: `keryx review ci-triage --run <id>` triages every failed job of the run by default and prints one verdict per job, each with its signal lines as evidence; `--job` narrows to one; `--json` returns an array.
- AC4: `/ci` shows each job's signals as evidence lines in the detail view, and the verdict stays labelled advisory.
- AC5: A committed evaluation set of labelled failed jobs from this repository (at least the five 2026-09-25 cases - two real regressions and three flaky tests, with the correct job named for each - plus any further cases found in CI history) is stored as redacted fixtures, and `keryx review ci-triage --eval <file>` reports accuracy and per-case verdicts against those labels.
- AC6: A live evaluation run against the fixtures' real runs is recorded in the flow journal with the before and after accuracy and cost, and the docs state the measured accuracy honestly, whatever it is.
- AC7: When OpenRouter rejects the credential, the error names where the key came from (the `OPENROUTER_API_KEY` environment variable or the saved key) and says when that key does not look like an OpenRouter key (no `sk-or-` prefix), without printing the key; a test covers both sources.
- AC8: When the signals alone decide a case (for example the same test passed on a rerun of the same run), the verdict says so and states it as deterministic evidence, and Jev's probabilities are shown beside it rather than replacing it.
- AC9: The CLI reference, the `/ci` help entry and the CHANGELOG-facing notes describe the signals and the limits, in English.
- AC10: CI is green on the pull request and `keryx health run` passes before merge.
