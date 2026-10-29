# Pull request context: MrCipherSmith/keryx#1058

Head 208a4d2faa4dfbf71b2992d027bda25762b34456, collection round 1, collected 2026-10-25T04:50:21.666Z.

## Intent (round 1)

**feat(review): record operator acts answered by the host's own question**

## Summary
- `decide-premise`, `confirm-plan`, `waive-mutation` and `override-reviewers` accept `--answered-by <source>:<ref> --answer-text "<verbatim>" --question-text "<as asked>"` without a TTY and record `confirmedVia: "host-question"` with the verbatim question and answer, plus a `keryx decisions` entry.
- keryx does not verify the answer. This reverses TM-04 §5 on the operator's instruction (polls 225 and 227), the same trade as `flow ac confirm`; the docs, limitations page and skills say so.
- `review complete` (and its `--waive` flags), unattended runs and a nested keryx still refuse. A shell floor in `src/trigger/unattended.ts` refuses the flag in agent shells.
- Skills (`review-orchestrator`, `job-orchestrator`, `review-premise`), TM-04 §6b, README, CLI reference and guides updated.

Flow 467. AC11 (recording the PR 1052 decisions) and AC12 (live operator check) follow after merge.

## Test plan
- [x] `bun test src/commands/review-host-question.test.ts` (41 tests)
- [x] existing review-operator, operator-confirm-review and harness-robustness tests pass unedited
- [x] `bun test src/gdskills src/docs` and the CLI reference coverage tests
- [x] `bun run typecheck`
- [ ] review round

## CI: passing

- deploy to GitHub Pages: skipped
- standard-pr: passing
- opentui native (darwin-arm64): passing
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- opentui native (linux-arm64): passing
- opentui native (darwin-x64): passing
- client matrix (terminal): passing
- linux sandbox (bubblewrap) live smoke: passing
- client matrix (runtime): passing
- standard-baseline: passing
- dependency-audit: passing
- metrics-contract: passing
- client matrix (streaming): passing
- client matrix (cancel-resume): passing
- opentui native (linux-x64): passing
- AC8 full suite (5000 ms, preload): passing
- typecheck-and-tests: passing
- wiki validate (gate) + freshness (report): passing
- vscode-extension: passing
- mkdocs build --strict: passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

