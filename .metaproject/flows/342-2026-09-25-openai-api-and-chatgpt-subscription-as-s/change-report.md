# OpenAI subscription implementation
Version: 0.1.0
Date: 2026-09-26

## Result

Implemented on `codex/openai-subscription` in `/Users/Goodea/goodea/keryx-openai-subscription`, based on `main` at `0a5d23eb0` (0.3.3). Implementation commit: `27958ff5`. Release publication and live personal-account authorization are separate follow-up steps.

- `openai`: Platform API key, native OpenAI Responses transport.
- `openai-codex`: ChatGPT subscription, browser-completed device authorization, native Codex Responses transport.
- Both entries appear before credentials exist. TUI and readline subscription selection initiate device login. Connection test, model discovery, saved selection, credential refresh and disconnect use the appropriate identity.
- Existing OAuth grants named `openai` remain readable; subscription logout removes canonical and legacy OAuth grants while preserving the API key. Subscription tokens never populate `OPENAI_API_KEY`.
- Every subscription turn resolves the current grant. Refresh rotation is protected by in-process sharing and an existing cross-process file lock; logout/new-login changes are checked before saving. One authentication retry is allowed before any streamed output.
- Shared Responses parsing preserves text, tool calls/results and provider-specific reasoning replay. Requests pin the subscription endpoint and omit Platform-only temperature/output-budget fields.

## Review corrections

Independent peer reviews cover OAuth lifecycle/security, transport/factory, and Shell UI integration. Two findings were repaired with regressions: a cancelled device poll retained a process timer; readline selection did not initiate subscription login. Final evidence and closure are recorded in the three review reports and `verification.md`.

CLI tests also now restore `process.exitCode`; a pre-existing provider-status test now accounts for the credential-free local Rapid-MLX provider on macOS.

## Verification

Initial integrated provider/OAuth/UI suite: 515 passed, 0 failed (44 files). Typecheck, script typecheck, build and documentation links passed. Changed-source ESLint/TypeScript health reported PASS with zero findings. Additional final verification, including expanded impacted tests and correction regressions, is recorded in `verification.md`; that report is authoritative for final counts and limitations.

Final changed-test gate: **1410 passed, 0 failed**, exit 0; later Shell/readline/TUI checks and explicit subscription-switch regressions also passed. Final typecheck, lint and build passed. Overall verification is **PASS_WITH_WARNINGS** because the generic test-log security scanner emitted advisory findings; this is not represented as an exhaustive security audit.

No live login or inference request with a user's subscription was performed. Offline tests validate request/storage/stream contracts, not individual entitlement. Primary protocol source links and pinned upstream revision are in `context-upstream.md`.

## Try after release (or from this worktree)

Run `keryx shell`, then `/provider` → **ChatGPT / Codex**. Enable device-code login in ChatGPT security settings if required, complete the displayed code in the browser, select a returned model and send a short prompt. The independent API option is **OpenAI API**. `/connect` provides connection test and disconnect.

Before release, use `bun src/cli.ts shell` from this worktree; an already installed `keryx` executable does not automatically use this branch.

All seven flow tasks and criteria have local implementation evidence. Criteria are explicitly signed `agent:codex`, not as a human approval. The managed flow remains in progress until its future PR/release lifecycle is completed; no remote PR, merge, push or release was performed. The worktree uses the existing checkout's dependencies through a local ignored `node_modules` symlink.

## Routing audit

`graph_used: yes` (rebuilt after new modules); `wiki_used: yes`; `ctx_used: yes`; `raw_rg_used: no`.
