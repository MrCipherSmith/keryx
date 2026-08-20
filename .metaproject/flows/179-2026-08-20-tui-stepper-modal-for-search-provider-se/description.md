# TUI: stepper modal for /search-provider (select provider, enter fields, test connection)

Status: formalized
Source: user description (session), grounded in direct code reading of
`src/tui/tui-shell.ts` and `src/harness/search/*`

## Problem

In the OpenTUI shell, `/search-provider` only accepts an inline
`<id> field=value... [key=...]` command line — there is no interactive way to
discover provider ids, required fields, or credential requirements. This
breaks an established convention already present in the same file: `/connect`
and `/provider` (bare, no args) open an interactive overlay wizard
(`pickProviderStep` → `promptBaseUrlStep` → `promptApiKeyStep`,
`tui-shell.ts:1084-1214`) for LLM providers. `/search-provider` and
`/search-connect` (`tui-shell.ts:3623-3693`) never adopted that pattern — they
stayed pure text parsing (`parseSearchProviderArgs`, `tui-shell.ts:985`), so a
user typing the bare command with no args just gets a static provider list
printed to the transcript, with no way to fill in fields interactively.

## Expected Outcome

Typing `/search-provider` with no arguments in the TUI opens a 3-step overlay
modal:

1. Select a provider from `searchProviderController.configurable()`.
2. Enter that provider's `descriptor.fields` (seeded with `defaultValue`),
   its credential if applicable (`descriptor.credentialSchema`), and choose
   whether to set it as the active provider after a successful test.
3. Run `configure()` + `test()` against it and show pass/fail; on success, if
   "set as active" was chosen, also call the same `select()` that
   `/search-connect` already uses.

`/search-provider <id> [field=value...] [key=...]` (called with args) is
UNCHANGED — it keeps working exactly as it does today for scripting/tests.
`/search-connect` is UNCHANGED — it remains "switch the active provider among
already-connected ones" exactly as it works now; the wizard's step-3 toggle
reuses that same underlying call, it does not duplicate or replace it.

## Out of Scope

- The plain readline shell (`src/commands/shell.ts`) — no OpenTUI primitives
  there, stays text-only.
- Adding new `SearchProviderId`s or provider adapters.
- Any change to `SandboxedWebTransport`, `web-policy.ts`, or the security
  sanitization boundary.
- Unifying `promptBaseUrlStep`/`promptApiKeyStep` into a generic reusable
  form-field component shared with the LLM-provider wizard (a reasonable
  follow-up, not required here — this flow's wizard is self-contained).
