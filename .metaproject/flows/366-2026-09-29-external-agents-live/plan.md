# Implementation Plan

Status: draft

## Approach

Run the real vendors first, read what they actually emit, then fix only what disagrees. Record after the codecs are right, so fixtures match reality and not a guess. Runs use a trivial read-only task in the disposable worktree that `agents external run` already creates.

## Steps

1. Operator enables `externalAgents.enabled` in the keryx user config and accepts the token spend (asked over helyx).
2. Live run per vendor (claude, codex, agy), raw output saved to the scratchpad; compare against `src/harness/external/codec/{claude-cli,codex-cli,antigravity-cli}.ts`.
3. Fix each disagreement in the codec, failing test first.
4. Sanitize the transcripts (home path, account, session ids, tokens) into fixtures with a version header; add the fixture-scan test and the replay tests; add the env-gated live test.
5. Update the docs (`harness.md`, `docs/verification/keryx-shell-tui-test-catalog.md`, CHANGELOG), bump the patch version.
6. PR, CI, review round, squash-merge, tag, npm poll, install, smoke including one live run.

## Risks

- A vendor run costs subscription quota: one trivial task each, no retries loop.
- Vendor output may contain account data: sanitize before anything leaves the scratchpad, and scan fixtures in a test.
- A vendor may need a login keryx cannot verify: report it as not verified instead of working around it.
- Live runs are not reproducible in CI: replay fixtures carry CI, live tests are opt-in.
