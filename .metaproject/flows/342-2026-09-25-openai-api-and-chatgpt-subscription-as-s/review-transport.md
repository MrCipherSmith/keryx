# Independent transport logic review

STATUS: DONE
Verdict: APPROVE

## Scope and spec gate
Reviewed peer-owned `src/harness/provider/openai-codex/openai-codex-provider.ts`, changes in `openai/openai-provider.ts`, `make-provider.ts`, and the Shell OAuth credential seam. Flow342 AC1, AC3, AC4, AC6 transport requirements pass source/fixture review. Login/UI and release validation remain covered by their own workers. Read-only review of transport; no transport code modified.

## Findings
No reproducible blocker or major defect found in this transport scope.

- Subscription requests pin the upstream Codex `/responses` URL, use OAuth bearer/account headers, emit `store:false` and streaming, and omit Platform-only token/temperature controls.
- Native normalized tools serialize through the existing Responses function_call/function_call_output mapping; tool roundtrip fixture succeeds. Reasoning replay ownership now separates Platform and subscription identities.
- Auth resolution occurs on each stream, so rotated/login-replaced tokens are not permanently captured. One authentication recovery is permitted before output, while any emitted content prevents replay.
- Scoped factory credentials cannot discover ambient saved OAuth; explicit OAuth supplier is a separately granted capability. Missing grant produces actionable authentication error rather than FakeProvider.
- Pre-cancelled calls stop before authorization/network. Accepted stalled body cancellation now races the read, cancels the reader and returns a normalized cancelled event.
- Platform factory/parser regressions remain passing.

## Evidence
`bun test src/harness/provider/openai-codex src/harness/provider/openai/openai-provider.test.ts src/harness/provider/make-provider.test.ts`: **56 passed, 0 failed**, exit 0. Covers login → saved JWT → native factory → streamed tool call/result/text, per-turn credential reload, scope isolation, missing authorization, 401 refresh, reasoning replay, cancellation, and Platform regressions.

Primary protocol references and pinned upstream commit are in `context-upstream.md`. No live credential or subscription entitlement request was made; fixture validation does not assert the user's current entitlement or backend availability.

## Routing audit
`ctx_used: yes`; `wiki_used: yes` (index and provider component); `raw_rg_used: no`; `graph_used: attempted/unavailable-for-new-file` — current graph predates the concurrently created adapter, and reports target-not-indexed. No graph result was treated as current; review followed explicitly assigned files and verified source directly. Parent will rebuild the shared graph after all workers finish.

## Readline selection follow-up

New `loginSubscriptionInReadline` and picker branch reviewed: correct device login before model listing, browser URL/code disclosure, bounded signal cancellation, and SIGINT listener cleanup. `bun test src/commands/select-subscription.test.ts src/commands/select.test.ts`: **37 passed, 0 failed**, exit 0. Startup and bare `/provider` use this picker.

**Resolved AC2 path gap (major, closed after independent recheck):** explicit `/provider openai-codex` in `src/commands/shell.ts` takes the nonempty-argument branch, sets providerName and constructs a provider directly, then continues without calling the selector. With no saved subscription grant this does not initiate device login; the next model turn fails authentication. Route that explicit subscription selection through `selectProviderModel(io, {onlyProvider:"openai-codex"})` when available, or otherwise make the supported menu-only behavior explicit. Reported to root and verifier; this does not change the native transport verdict above.

### Closure verification

Explicit `/provider openai-codex` now invokes `selectAndApply({onlyProvider:"openai-codex"})`; the former direct-construction bypass is gone. The authenticated picker selects the authorized model before applying state. Login/model-selection rejection is caught and leaves the prior active provider/model intact. Missing selector capability prints actionable guidance instead of switching to an unusable subscription provider.

Independent rerun: `bun test src/commands/shell-subscription-selection.test.ts src/commands/select-subscription.test.ts` — **4 passed, 0 failed**, exit 0. The new explicit-command tests exercise the actual `runShell` branch, including rejected selection; picker tests exercise device challenge/browser/code, persisted grant, authorized model, and cancellation. Final verdict remains **APPROVE**, no unresolved findings.
