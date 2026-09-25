# Review — flow 309, live provider catalog at startup (PR #712)

Two rounds ran against the flow 309 diff (`src/harness/provider-catalog.ts`,
`src/harness/provider-catalog-cache.ts`, `src/tui/tui-shell.ts`,
`src/tui/routing-inspector.ts`, `src/commands/providers.ts`,
`src/commands/routing.ts`, `src/harness/routing/table.ts`, plus tests and
docs), which replace `detectProviders()`'s curated/static model lists with a
live, cached, per-connected-provider catalog (status, live models, balance)
read by `/routing`'s flat picker, `/connect`, and a new
`keryx providers status` command.

**Round 1** raised five findings against the first commit on the branch —
two major, three minor. Both majors and all three minors were fixed in the
branch's second commit before merge:

- **F-001 (major)** — OpenRouter's `balancePath` was the doubled
  `/api/v1/credits` (the `baseUrl` already ends in `/api`) parsed against a
  response shape (`body.credits.{total,used,remaining}`) neither
  `/v1/credits` nor any other OpenRouter endpoint returns, so a connected,
  funded OpenRouter key always showed no balance.
- **F-002 (major)** — the full-refresh cache writer and the
  `providers test` single-entry patch writer both wrote
  `provider-catalog.json` with no lock between them; a patch landing while
  an older, still-in-flight startup refresh was running could be silently
  clobbered when that refresh finally finished and overwrote the whole file
  — a lost-update race.
- **F-003 (minor)** — the synthetic `fake` test-double provider was not
  excluded from the catalog and could appear in `providers status`,
  `/connect` and `/routing` next to real providers.
- **F-004 (minor)** — the AC6 startup notice callback painted into
  `announceStartupNotice`/`splash`/`io` with no check that the shell had
  already been torn down, a possible use-after-teardown write when a slow
  provider probe resolved after Esc/exit.
- **F-005 (minor)** — `fetchProviderBalance`'s response body was parsed with
  no size cap, unlike the already-capped `/models` fetch.

**Round 2** re-read the branch's second commit against the fixes above:
all five are fixed and verified (see `verifications.json` — each claim cites
the merge commit and, where a test exists, an actual green test run).
Round 2 **approves**, with one minor left open rather than blocking merge:

- **F-006 (minor, open)** — the F-004 destroyed-shell guard
  (`if (destroyed) return;` in `tui-shell.ts`'s `providerCatalogReady.then`
  callback) has no dedicated test exercising the destroyed-before-resolve
  race. `provider-catalog-startup.test.ts` covers the AC6 notice text and
  `provider-catalog.test.ts` covers the hang/timeout bound (AC2), but
  nothing drives the callback to fire after the shell is torn down and
  asserts it is a no-op. Tracked as follow-up debt, not a merge blocker —
  the guard itself is a one-line, low-risk change and the round otherwise
  verified clean.

PR #712 squash-merged as `7abc0fb0bbb5c0b91dc930e6ca0f05295eecdc5b` into
`main`; CI was 19/19 (18 success, 1 skipped — "deploy to GitHub Pages", not
applicable to a PR build) on the PR, and `keryx health run` passes at this
head (project score 94, no gate conditions triggered).

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/commands/providers.ts",
    "problem": "OpenRouter's balance endpoint used a doubled `/api` path (`balancePath: \"/api/v1/credits\"` against a `baseUrl` that already ends in `/api`) and parsed a response shape neither `/v1/credits` nor any other OpenRouter endpoint returns (`body.credits.{total,used,remaining}`).",
    "impact": "`keryx providers status`, `/connect` and the routing picker's balance column always showed OpenRouter as having no balance (a 404 or a malformed body makes `fetchProviderBalance` return `undefined`), even for a correctly connected, funded key — the AC5 balance feature silently did not work for the most common hosted provider.",
    "suggested_fix": "Read the real `/v1/key` endpoint (`data.limit_remaining`, or fall back to `data.limit` when the key has no spending cap) and fall back to `/v1/credits` only for an unlimited key, both against the correct base URL.",
    "evidence": "Checked directly against openrouter.ai: `/api/v1/credits` 404s when appended to a `baseUrl` that already ends in `/api`, and neither `/v1/key` nor `/v1/credits` returns a top-level `credits` object.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/providers.ts OPENAI_COMPAT_PROVIDERS[].balancePath (one entry per hosted provider with a documented balance endpoint: openrouter, deepseek)",
        "src/commands/providers.ts fetchProviderBalance's per-balanceKind response parser"
      ],
      "enumeration_method": "grepped `balanceKind`/`balancePath` across every OPENAI_COMPAT_PROVIDERS entry and cross-checked each configured path and parser branch against that vendor's own documented balance endpoint; only the openrouter entry's path and parser mismatched, deepseek's `/user/balance` was already correct"
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "file": "src/harness/provider-catalog-cache.ts",
    "problem": "The full-refresh cache writer (`saveProviderCatalogCache`) and the single-provider patch writer `providers test` uses (`updateProviderCatalogEntry`) both wrote `provider-catalog.json` with no lock between them. A `providers test` patch landing while a slower full refresh (up to `CATALOG_FETCH_TIMEOUT_MS` per provider, run in parallel at `keryx shell` startup) was still in flight was silently clobbered once the older refresh finally finished and overwrote the whole file unconditionally.",
    "impact": "A provider an operator had just re-tested and fixed via `providers test` (or the `/connect` row's `[Test]` button) could have that corrected entry silently reverted to an older, still-in-flight startup refresh's result — a lost update with no error and nothing on the record showing it happened.",
    "suggested_fix": "Have both writers take the same on-disk lock (`withFileLock` over `provider-catalog.json.lock`) and have the full refresh merge into whatever is currently on disk rather than overwrite unconditionally, so a newer single-entry patch always wins over an older in-flight refresh.",
    "evidence": "Traced both writers in provider-catalog-cache.ts: neither took a lock, and `saveProviderCatalogCache` replaced the whole file unconditionally.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/provider-catalog-cache.ts saveProviderCatalogCache (full-refresh writer)",
        "src/harness/provider-catalog-cache.ts updateProviderCatalogEntry (providers-test single-entry writer)"
      ],
      "enumeration_method": "grepped every call to writeOwnerOnlyFileAtomic( and catalogFile( in provider-catalog-cache.ts to enumerate every writer of provider-catalog.json; these two are the only ones"
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/harness/provider-catalog.ts",
    "problem": "The synthetic `fake` test-double provider (used by shell tests / `keryx shell --provider fake`) was not excluded from the live provider catalog, so it could appear in `providers status`, `/connect` and the `/routing` picker next to real providers.",
    "impact": "An operator could see a `fake` row with no real status or balance mixed in with genuinely connected providers in every user-facing catalog reader.",
    "suggested_fix": "Exclude `detected.name === \"fake\"` at the single point every catalog reader inherits from — `buildCatalogEntry` returning `undefined` for it before it ever reaches the catalog.",
    "evidence": "provider-catalog.ts's buildCatalogEntry had no early-return for the fake provider.",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "problem": "The AC6 startup notice callback (`providerCatalogReady.then(...)`) painted directly into `announceStartupNotice`/`splash`/`io` with no check that the shell had already been torn down (e.g. the operator hit Esc/exit while a slow or timed-out provider probe was still resolving).",
    "impact": "A late-resolving catalog refresh could paint a notice into a destroyed shell surface — a use-after-teardown write.",
    "suggested_fix": "Guard the callback the same way the bus-join callbacks already do: `if (destroyed) return;` before doing anything with the resolved catalog.",
    "evidence": "tui-shell.ts's providerCatalogReady.then callback had no destroyed check.",
    "confidence": "high"
  },
  {
    "id": "F-005",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/commands/providers.ts",
    "problem": "`fetchProviderBalance`'s response body was read and JSON-parsed with no size cap, unlike the `/models` fetch which already refuses an oversized body via `MODELS_RESPONSE_BODY_LIMIT_BYTES`.",
    "impact": "A balance endpoint returning an unexpectedly large body (a misconfigured custom provider, or a compromised endpoint) could be read to completion with no bound.",
    "suggested_fix": "Cap the balance response body the same way the `/models` parser does.",
    "evidence": "fetchProviderBalance had no equivalent of a response-body size limit.",
    "confidence": "high"
  },
  {
    "id": "F-006",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "problem": "The F-004 fix (the `if (destroyed) return;` guard on the startup notice callback) has no dedicated test exercising the destroyed-before-resolve race. `provider-catalog-startup.test.ts` covers the AC6 notice text and `provider-catalog.test.ts` covers the hang/timeout bound (AC2), but nothing drives the callback to fire after the shell is torn down and asserts it is a no-op.",
    "impact": "A future refactor of the startup notice path could silently drop the destroyed guard with nothing failing to catch it.",
    "suggested_fix": "Add a unit/integration test that resolves `providerCatalogReady` after simulating shell teardown and asserts `announceStartupNotice` is not called.",
    "evidence": "Read provider-catalog-startup.test.ts and provider-catalog.test.ts in full: neither exercises the destroyed-guard branch.",
    "confidence": "high"
  }
]
```
