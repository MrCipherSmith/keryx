# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With `externalAgents.enabled` on, `keryx agents external run claude-cli --task "reply with the single word ok; change nothing" --json` runs a real `claude` process to completion and the JSON outcome carries a non-empty parsed answer. [verify: exec `keryx agents external run claude-cli --task "reply with the single word ok; change nothing" --json`]
- AC2: antigravity-cli ran to completion against its real installed binary (task worded to need no tools, since agy denies unaskable tool calls), and codex-cli was run for real: its subscription usage limit is recorded and classified, with its 0.159.0 expired-login wording fixed in the codec; a successful codex run is not obtainable before the limit resets on 2026-10-03, so the codex live test stays available under `KERYX_LIVE_EXTERNAL=1`. [verify: exec `bun test src/harness/external/live-fixtures.test.ts`]
- AC3: Every place where a real vendor's output disagreed with its codec is fixed in the codec, with a test that fails on the old code and passes on the new; if no disagreement was found, the flow journal says so per vendor. [verify: exec `bun test src/harness/external`]
- AC4: One sanitized transcript per vendor lives in the test fixtures with the vendor binary version in its header; the file holds no home path, token, key or account identifier, and a fixture-scan test enforces that. [verify: exec `bun test src/harness/external`]
- AC5: A replay test per vendor parses its fixture through the codec in CI; a live test per vendor exists and is skipped unless `KERYX_LIVE_EXTERNAL=1` is set. [verify: exec `bun test src/harness/external`]
- AC6: The statements that external agents were never run against a real vendor process are replaced by the tested versions and the run date in `docs/verification/keryx-shell-tui-test-catalog.md` and `harness.md`; Gemini stays marked unverified. [verify: exec `grep -q 'Live-verified' docs/verification/keryx-shell-tui-test-catalog.md`]
- AC7: No run reads a vendor credential store: the recorded runs leave `~/.gemini/antigravity-cli/` and the vendors' auth files untouched by keryx code, and no key or token appears in any committed file. [verify: exec `bun test src/mcp-client/credential-boundary.test.ts src/harness/external`]
- AC8: The change ships as the next patch release with CHANGELOG and package.json updated, CI green on the PR head, and the installed build passes `keryx --version`, `keryx review tier`, `keryx mcp list` and one live `keryx agents external run` through the real CLI route. [verify: exec `keryx agents external run claude-cli --task "reply with the single word ok; change nothing" --json`]
- AC9: The flow stops after the release smoke; write mode and W2 wait for the operator's word. [verify: none — a stop is an absence of work; the journal entry and the operator report are the evidence]
