# Pull request context: MrCipherSmith/keryx#939

Head ede409d5a9d9a5403f51b3f12edc6ac4704d805c, collection round 1, collected 2026-10-12T18:37:50.678Z.

## Intent (round 1)

**Run review-orchestrator inline with a fail-closed preflight (flow 417)**

## Summary
- `review-orchestrator`, `flow-orchestrator` and `job-orchestrator` open with a preflight: the agent that loads the skill runs inline in the main session; without `Agent` or with the nesting depth spent the whole output is `STATUS: BLOCKED nested_dispatch_unavailable — run this skill in the main session`. `SUBAGENT-STOP` removed from the orchestrating skills.
- Prose-only diffs end in `no round: <reason>`; the default profile is read-only, `--fix` is a separate profile bounded by `REVIEW_ROUND_CAP`.
- Reviewer waves are split by diff domain, at most 10 per wave for `--all`/full review (`keryx review budget --full`); `RATE_LIMITED` halves the wave at most twice, then `BLOCKED rate_limited`.
- Agent vocabulary carries the spawn tool for orchestrators; managed block, `catalog.md` and `routing.md` state the inline rule.
- review-orchestrator skill 1712 → 1615 lines (ceiling lowered); docs, README and CHANGELOG updated.

## Test plan
- [x] `bun test src/commands src/gdskills src/review src/agents` (2 pre-existing budget tests pinned to `--parallel 4`)
- [x] Mutation proof for wave ceiling, rate halvings, spawn host list, BLOCKED line (flow journal)
- [ ] CI incl. `mkdocs build --strict`
- [ ] Smoke after release: round inline in the main session; skill as a subagent without `Agent` ends in the one BLOCKED line

## CI: passing

- deploy to GitHub Pages: skipped
- standard-pr: passing
- opentui native (darwin-arm64): passing
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- opentui native (linux-arm64): passing
- opentui native (darwin-x64): passing
- client matrix (terminal): passing
- typecheck-and-tests: passing
- client matrix (runtime): passing
- vscode-extension: passing
- wiki validate (gate) + freshness (report): passing
- metrics-contract: passing
- AC8 full suite (5000 ms, preload): passing
- linux sandbox (bubblewrap) live smoke: passing
- opentui native (linux-x64): passing
- client matrix (streaming): passing
- client matrix (cancel-resume): passing
- dependency-audit: passing
- standard-baseline: passing
- mkdocs build --strict: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

