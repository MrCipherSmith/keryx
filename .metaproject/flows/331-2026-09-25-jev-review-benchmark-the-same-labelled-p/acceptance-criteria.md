# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A labelled dataset is built deterministically from this repository's own history and committed under `bench/jev-review/` (or the repo's existing benchmark location): for merged PRs that have review packages in `.metaproject/flows/*/reviews/*`, each finding with its final disposition (acted-on / refuted / dismissed …), severity, file/line and reviewer; the PR's diff reference; plus the flow's frozen acceptance criteria and their confirmations. A builder script regenerates it; no private data (only this public repo); the label mapping (which dispositions count as true/false positive) is documented.
- AC2: A benchmark runner `keryx bench jev-review` (or a script under `scripts/`) evaluates each Jev review component on the dataset through a common adapter interface, arms: `without-jev` (the pipeline's existing result for that PR: findings as recorded) and `with-jev` (the same plus the Jev component's output or filtering). Components registered at start: CI triage (existing `--eval` set), `review conform` on PR metadata, and hooks for the in-flight components (`flow check-ac` — flow 328, `review-jev-rules` — flow 330, severity calibration / duplicate merge — later) that are skipped with a clear `not available` row until their code lands.
- AC3: Metrics per component and arm: precision and recall against the labels where defined (e.g. a Jev-rules finding matching a human-acted-on finding at the same file/region), added true positives not found by the existing reviewers (hand-labelled sample), noise (findings later refuted/dismissed), Jev calls, input tokens, cost, wall-clock; bootstrap or simple confidence intervals given the small n; results as JSON plus a markdown report.
- AC4: Honest-reporting rules are encoded in the report generator: n and CI are always printed next to each percentage; a component with n < 10 is labelled `anecdotal`; run-to-run variance is measured by repeating the Jev arm at least 2 times on a subset and reported.
- AC5: Offline mode replays recorded Jev answers (committed fixtures) so the benchmark and its tests run in CI without network; live mode (`--live`) calls Jev and records fresh answers; a cost cap (`--max-cost`, default documented) aborts before exceeding it.
- AC6: Live run (with `env -u OPENROUTER_API_KEY`) of every available component, results committed as `bench/jev-review/results-<date>.md|json`, and a short `docs/` page summarising what Jev improved, what it did not, and at what cost — written for the article, numbers only from the run.
- AC7: Tests: dataset builder on fixture flows, metric computations, adapter registry, offline replay; hermetic, macOS-safe; revert-checked.
- AC8: Docs (cli-reference or scripts README, HELP_GROUPS if a CLI verb is added), CI green, `keryx health run` passes, import zones respected.
