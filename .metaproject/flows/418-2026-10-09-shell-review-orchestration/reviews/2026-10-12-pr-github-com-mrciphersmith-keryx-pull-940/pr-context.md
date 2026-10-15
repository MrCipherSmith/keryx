# Pull request context: MrCipherSmith/keryx#940

Head 489d410fa0a01c78ed42e6c96580245c65486d8a, collection round 1, collected 2026-10-12T19:49:46.055Z.

## Intent (round 1)

**feat(shell): trust mode completes long review runs (flow 418, 0.3.87)**

## Summary

Flow 418. A keryx shell in `trust` mode should carry a large PR review to `review complete` with no input after the task (live comparison on a work project PR 7435: Claude 17m58s, shell did not finish in 2h20m).

- Trust mode: 200 tool rounds (40 in ask/auto), no prompt for routine local review commands after untrusted content (allowlist of local verbs), bounded plan follow-through, operator answers kept in the slate, waves of 10 subagents, subagent rounds 40 (max 200).
- TUI: slash commands typed while busy are queued; Ctrl+C cancels the turn, second press at idle exits.
- Review tooling: `keryx review slice` (domain slices of at most 150 KB, ledgers omitted), `dispatch-check`, `retry-plan`, `keryx ctx run --raw`, clearer read-outside-cwd error, shell-host section in review-orchestrator.
- Docs: long-run section in permission-modes.md, CHANGELOG 0.3.87. Flow folders 418 and 419 included.

AC12 (live PR 7435 run in trust mode) runs after this release.

## Test plan

- [x] `bunx tsc --noEmit -p .` clean
- [x] new and touched suites: agent, trust orchestration, tui, review, ctx, gdskills, docs
- [ ] CI (full suite, docs `--strict`)
- [ ] release smoke test, then the live PR 7435 run
- Known unrelated failures also on main: `src/tui/ci-triage-source.test.ts` (2), hostile-cwd shell tests, `resolveProjectRoot` with a stray `/tmp/.metaproject`.

## CI: passing

- standard-pr: passing
- deploy to GitHub Pages: skipped
- macOS real-host legs — OS sandbox + TUI pty launch: passing
- opentui native (darwin-arm64): passing
- opentui native (darwin-x64): passing
- opentui native (linux-arm64): passing
- dependency-audit: passing
- linux sandbox (bubblewrap) live smoke: passing
- client matrix (runtime): passing
- standard-baseline: passing
- AC8 full suite (5000 ms, preload): passing
- metrics-contract: passing
- client matrix (streaming): passing
- client matrix (cancel-resume): passing
- opentui native (linux-x64): passing
- mkdocs build --strict: passing
- vscode-extension: passing
- wiki validate (gate) + freshness (report): passing
- typecheck-and-tests: passing
- client matrix (terminal): passing

## Backend pins

_The pull request names none._

## Review comments (0, full text)

