# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A live model catalog module fetches each CONNECTED provider's model list from its real endpoint (the same `/models` fetch `/model` and `providers test` already use — reused, not duplicated), in parallel, each fetch bounded by a timeout (≤8 s) and a response-size cap, and records per provider: status (ok | auth-failed | unreachable | timeout | not-supported), fetched model ids, fetchedAt. Unconnected providers (no key / no grant / not running) are never probed. Unit-tested with injected fetch, including a timeout and a 401.
- AC2: `keryx shell` starts the catalog refresh during the startup loading phase without blocking the first prompt: the spinner line names the refresh ("checking providers…"), and the shell becomes usable after at most the existing startup budget even if a provider hangs; results land when ready. Pinned by a test with a hanging fake provider.
- AC3: The catalog is cached on disk (user config dir, no credentials in it, mode 0600) with a freshness TTL; a stale or missing cache triggers the refresh, a fresh one is used immediately. `providers test` (flow 304) updates the same cache.
- AC4: The `/routing` flat picker lists ONLY connected providers and, for each, the live fetched model ids from the catalog; the hardcoded curated lists appear only as a clearly marked fallback when a provider's fetch failed or is unsupported (row suffix "(offline list)"). Providers whose status is auth-failed/unreachable show that status instead of pretending their models are available. The same catalog feeds any other picker that currently reads `detectProviders()`'s curated lists for connected hosted providers, and `/model` is unaffected or improved, not regressed.
- AC5: Balance: for providers that expose a documented balance/credit endpoint (at least OpenRouter `GET /api/v1/key` or `/api/v1/credits`, and DeepSeek `GET /user/balance`), the refresh also reads the remaining balance/limit, bounded the same way; providers without such an endpoint show no balance (never a guessed number). Unit-tested with injected fetch per provider; the key is never logged or placed in the cache or any error text.
- AC6: TUI: the `/connect` provider list and the connected-provider step show each provider's catalog status (ok / auth failed / unreachable) and balance when known, plus the catalog age; a provider that fails at startup is surfaced once as a non-blocking notice line ("openrouter: auth failed — /connect to fix"). English UI text.
- AC7: CLI: `keryx providers status [--json] [--refresh]` prints the catalog per connected provider (status, model count, balance if known, fetchedAt); `--refresh` forces a re-fetch. Registered in HELP_GROUPS, docs/docs/cli-reference.md, commands-by-task regenerated.
- AC8: No network in unit tests; macOS-safe; import zones respected (core must not import client); a revert-check shows the AC4 picker test fails against the old hardcoded source.
- AC9: Live check on this machine against the operator's connected providers (run with `env -u OPENROUTER_API_KEY`): the catalog lists real current models for each connected provider, OpenRouter balance is read, `/routing` shows the fetched list; results journaled without any key.
- AC10: CI green on the PR; `keryx health run` passes; docs (cli-reference, README provider section if it describes the picker) updated.
