# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review jev-select` accepts `--diff <file>|-` or `--ref <base>`, reads the candidate reviewer list from the same source `keryx review reviewers --json` uses, and outputs `{reviewer, probability, decision: "keep"|"skip", reason}` per candidate.
- AC2: `jev-select` skips a candidate only when its probability is strictly below `review.jev.select_skip_below` (default `0.15`), and never skips `review-logic`, `review-architecture`, `review-security-code`, or `review-highload` regardless of Jev's answer.
- AC3: `jev-select` fails open — every candidate decided `keep` with a reason, exit code `0` — when `review.jev.select` is not enabled, no Jev/OpenRouter credential is resolvable, or any Jev call fails partway through a batch; it never refuses the round and never makes an unmeasured lever cost reviewer coverage.
- AC4: `review-orchestrator`'s two SKILL.md copies (`.metaproject/skills/gdskills/review/review-orchestrator/` and `src/gdskills/bundled/skills/review/review-orchestrator/`) are wired to run `jev-select` before Wave A/B dispatch when `review.jev.select` is on, and to run `keryx review ci-triage` on a PR whose checks are red when `review.jev.ci_triage` is on — both advisory, both recorded in the report.
- AC5: Both SKILL.md copies stay byte-identical to each other and at exactly the recorded line ceiling (1723) in `src/gdskills/skill-length-ceilings.ts`; both SKILL.detail.md copies carry the measured verdicts for `review-jev-risk`/`review-jev-contract` (weaker than a strong model, off by default), `review-jev-rules` (not useful on top of a strong reviewer), and `review-jev-scenarios`/`review-jev-docs`/`review-jev-comments` (experimental).
- AC6: `keryx review jev-profile show` prints every `review.jev.*` key next to its measured verdict; `keryx review jev-profile --apply recommended` merge-writes `ci_triage`/`select`/`edit_guard: true` and `risk`/`contract`/`rules`/`scenarios`/`docs`/`comments: false` into `.metaproject/tasks.config.json`, preserving every other key.
- AC7: A `/jevprofile` TUI modal exists, is registered in `AGENT_SLASH_COMMANDS` and `HELP_GROUPS`, and `docs/docs/commands-by-task.md` reflects it (regenerated via `bun scripts/generate-commands-by-task.ts`).
- AC8: `docs/docs/jev-in-review.md` exists with the measured numbers from this task (no project name — "a large production React/MobX frontend"), linked from both `README.md` and `docs/docs/README.md`; `docs/docs/cli-reference.md` documents `jev-select`/`jev-profile`; `CHANGELOG.md` has an entry under `## [Unreleased]`.
- AC9: `keryx test related` for every touched file, `bun run typecheck`, and `bun run lint` are all clean; a PR is open on `feat/jev-orchestrator` with CI green (known flaky jobs rerun at most once), not merged.
