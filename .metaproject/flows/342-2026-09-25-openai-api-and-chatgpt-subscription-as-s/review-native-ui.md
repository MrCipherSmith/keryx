# Native/UI integration review

Date: 2026-09-26
Reviewer: auth_review (local review-logic)
Scope: provider selection, subscription model discovery, connection status/test/disconnect, TUI authorization, provider catalog. Native transport implementation reviewed separately by another worker.

## Verdict

APPROVE_WITH_SUGGESTIONS for the original UI-worker changes after the AC2 correction described below. No remaining major finding in the reviewed TUI/connection/model-list code. The reviewer implemented the requested readline correction, so that correction requires a separate reviewer rather than self-approval.

## Spec compliance

- AC1: distinct always-visible OpenAI API and ChatGPT / Codex choices; catalog methods separate API-key and device-code login. Subscription is not registered as a Chat Completions transport.
- AC2: TUI credential gate handles OAuth without an envKey, displays verification challenge, opens the browser, cancels with Escape. A readline gap was found and corrected.
- AC5: subscription connection testing and live model discovery use the authenticated Codex models endpoint and account header. API-key-only state does not mark subscription connected. Connection classification/removal preserves the other credential. Legacy OAuth is recognized through the grant loader fallback.
- AC6: reviewed synthetic model discovery, connection separation, and TUI cancellation tests. Personal Pro entitlement and upstream availability remain unverified without a user login.

## Finding F-001 — major — corrected

Original `pickProviderModel` in `src/commands/select.ts` immediately requested models after selecting a provider and fell back to the curated model array. With an empty auth directory, `keryx shell --no-tui` could select `openai-codex` without invoking device authorization, contradicting AC2 and causing an authentication error on the first model turn.

Class scope: `src/commands/select.ts::pickProviderModel`; callers `src/commands/shell.ts::realSelectProviderModel` and its non-TUI startup picker. Enumeration: complete `keryx ctx rg --all` searches for `pickProviderModel`, `collectCredential`, and OAuth usage; TUI's separate `selectProviderModelInTui` already had the credential step.

Correction authorized by the root: initiate device login for a missing grant, print verification URL/code, open browser through an injectable seam, cancel through SIGINT/AbortSignal, retry rejected saved authentication once, and require an authorized live model list. `src/commands/select-subscription.test.ts` recorded 2 failures before implementation and now passes both cases (login/persistence/model selection and cancellation without guessed-model fallback).

Peer follow-up found the explicit readline `/provider openai-codex` branch bypassed the selector. That branch now calls the same restricted picker and preserves the existing session on cancellation. `src/commands/shell-subscription-selection.test.ts` recorded 2 failures before correction and now passes; combined Shell/select verification is 68 passed. The TUI `/provider` dispatcher always opens the normal credential wizard, including when arguments are present; it does not directly assign a provider. The active-subscription disconnect toast now accurately states that the next turn needs a new login because credentials are re-read per turn.

## Evidence

- Native/API/factory regression: 74 passed, 0 failed, 266 assertions.
- Selection plus subscription regression after correction: 46 passed, 0 failed, 119 assertions.
- Earlier changed-suite run: 1404 passed, two report entries for one stale keyless-local-provider expectation; assigned to the final verifier and corrected outside this review.
- Owned provider lint passed and full typecheck passed before the final readline addition; final verifier owns the aggregate rerun.
- No credentials or live account actions used.

Routing: graph_used=yes (initial native dependency context; no stale graph assertion about new files); wiki_used=yes (OAuth component and index); ctx_used=yes (diff/search/read/test artifacts); raw_rg_used=no.
