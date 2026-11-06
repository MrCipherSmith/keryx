---
Title: Module src/harness/search
Version: 1.4.0
Type: component
Status: accepted
Summary: "`src/harness/search` is the harness-side search layer. It defines the search provider contracts, a registry of six built-in providers, and a controller that runs only the provider the operator explicitly selected. Provider adapters never reach the network directly: every request goes through the sandboxed web transport, and the default factory is the trusted composition root that wires the two together."
---

# Module src/harness/search

## Summary

`src/harness/search` is the harness-side search layer. It defines the search provider contracts, a registry of five built-in providers, and a controller that runs only the provider the operator explicitly selected. Provider adapters never reach the network directly: every request goes through the sandboxed web transport, and the default factory is the trusted composition root that wires the two together.

## Overview

This module owns how the app finds and runs web search. It holds the registry of the six built-in providers (DuckDuckGo, SearXNG, Brave, Tavily, Exa and DeepSeek), the config-backed controller behind the `/search-provider` and `/search-connect` flows, and the shared types that describe providers and their normalized results. It does not render UI, parse command arguments or open sockets. The controller hands descriptors and states back to the surfaces that draw them, and all HTTP goes out through the web-harness transport it is given.

It depends on `src/lib` for search configuration and credential storage, on `src/harness/web` for the sandboxed transport and the web worker runner, and on `src/commands/providers` for the chat-model API key DeepSeek's search borrows.

## How it works

The module has four layers: contracts, a registry of provider adapters, a controller, and a composition root.

- **Contracts (`types.ts`)**
  - `SearchProviderDescriptor` is the uniform shape every provider exposes: id, display name, `local` or `remote` kind, form fields, credential schema, capabilities, and the `testConnection` and `search` methods.
  - `SandboxedWebTransport` is the only network boundary. Adapters receive it as a dependency and must not call `fetch` or an SDK.
  - `types.ts` has no internal imports.

- **Registry (`registry.ts`)**
  - `createSearchProviderRegistry(transport, resolveCredential)` builds the six descriptors once, in a fixed order. There is no runtime registration.
  - `fetchPage` is an OPTIONAL descriptor capability: a provider that can retrieve a page itself exposes it (DeepSeek, whose Fetch API returns Markdown). Every other descriptor omits it, and that omission is what keeps `web_fetch` on the sandbox transport.
  - Brave, Tavily and Exa share one `remote` helper that differs only in endpoint, credential injection (`header` or `json-body`) and result mapping. DeepSeek is hand-written: its credential crosses as `Authorization: Bearer <key>`, a non-2xx status has to name the fix (HTTP 402 means an empty balance, not a broken endpoint), and the model gets `summary` rather than the UI-length `snippet`.
  - Each adapter normalizes its raw payload into `NormalizedSearchResult` and caps output at 10 results.
  - The DuckDuckGo adapter treats an anomaly page as a refusal rather than an empty result set. It backs off, and when the ladder runs out it throws `RATE_LIMITED_SEARCH_ERROR` so the caller does not retry at once.
  - `SearchProviderRegistry` exposes `get` and `testConfigured`. The free function `connectedProviderIds` reduces connection states to the IDs that are connected.

- **Controller (`controller.ts`)**
  - `SearchProviderController` reads and writes search configuration through `src/lib/search-config`, records which provider is active, and runs the `configure`, `test`, `select`, `search` and `fetchPage` operations.
  - `fetchPage` validates the target's SYNTAX at the seam (`parsePublicHttpsUrl`), delegates to the active descriptor's optional `fetchPage`, and answers `no-fetch-provider` when there is none — a direction to the transport, not an error — or `provider-disconnected` when the operator selected a provider that is not connected. An ACTIVE provider that refuses a page never falls back; a provider that never answered (`retryable`) does.
  - It returns descriptors and states rather than rendering them. Its own comment says it deliberately owns no terminal output.
  - Selection is explicit. A non-default provider must be connected before it can be selected or used.
  - `connect()` is the one "connect" operation (configure → test → activate); both argument paths and the TUI wizard call it, so the policy cannot drift between surfaces.
  - A permanent refusal (402, rejected key, a permanent 4xx) is remembered for five minutes in a store shared by every controller in the process, keyed by config dir — `/search-provider` and the agent tools hold different instances. A successful `test`/`select`/`configure` clears it.

- **Composition root (`default-controller.ts`)**
  - `createDefaultSearchProviderController(configDir?)` builds a `SandboxedWebTransport` over the system web worker runner, resolves credentials with `searchCredentialResolver`, and returns the controller. The resolver prefers a credential saved for search and, for DeepSeek only, falls back to the chat-model API key from `src/commands/providers` — one account bills both.
  - No adapter reads `process.env`.

- **Public entry point (`index.ts`)**
  - Re-exports the registry, controller, default factory, `describeConnectionFailure`, the type surface and `DEFAULT_SEARCH_PROVIDER_ID`.
  - The recommended import path for consumers.

## Key concepts

- **Search provider descriptor**: The uniform object each provider exposes, so the controller and surfaces iterate descriptors instead of switching on provider IDs.
- **Sandboxed transport**: `SandboxedWebTransport` and `SandboxedWebRequest`. A request carries a `capability` of `public-search` or `local-search`. Credentials are injected at this boundary as a header or JSON-body field (`CredentialInjection`), never in the URL or the environment.
- **Provider kind**: `local` (SearXNG, reached on loopback) or `remote` (DuckDuckGo and the five hosted APIs).
- **Normalized result**: `NormalizedSearchResult`, with title, canonical URL, snippet, optional publication date and provenance. It is the only result shape the module returns.
- **Connection state and reason**: `SearchProviderConnectionState`, and the `SearchConnectionResult.reason` values `missing-credential`, `invalid-credential`, `transport-failed`, `incompatible-response`, `rate-limited` and `insufficient-balance` (a paid provider accepting the key and refusing for lack of credit).
- **Provider page retrieval**: `ProviderPageResult`, returned by an optional `fetchPage` on a descriptor. `web_fetch` consumes it through the narrow `WebPageFetcher` seam, sanitizes the Markdown with the same `sanitizeWebContent` used for scraped HTML, and falls back to the transport on `no-fetch-provider` and on a `retryable` provider failure.
- **Default provider**: DuckDuckGo, given by `DEFAULT_SEARCH_PROVIDER_ID`. It needs no credential and is used only when no provider is selected, never as a fallback after another provider fails.

## Main flows

### Wire default search behavior

1. App code calls `createDefaultSearchProviderController(configDir?)`, which builds the sandboxed transport, the registry and the controller.
2. The controller is passed into command handlers, tool implementations or UI flows that need search.
3. `configurable()` lists all six descriptors. `selectable()` narrows them to DuckDuckGo plus any provider whose stored status is `connected`.

### Configure, test and select a provider

1. `configure` stores a provider's fields and an optional credential, and marks the provider `disconnected`.
2. `test` runs that descriptor's `testConnection` against the stored fields and records `connected` or `disconnected` with `lastTestedAt`.
3. `select` makes a provider active only if it is connected. Selecting DuckDuckGo always succeeds and marks it connected.

### Coordinate a search

1. A consumer calls `search(query, signal)` on the controller.
2. With no active provider, or DuckDuckGo active, the controller runs DuckDuckGo. Otherwise it requires the active provider's stored status to be `connected`, or returns `provider-disconnected`.
3. The adapter's `search` makes its request through the transport: DuckDuckGo with pacing and backoff, SearXNG on loopback, and the hosted APIs with the injected credential. A hosted adapter with no stored key refuses with reconnect wording, never an empty result set.
4. If the adapter throws, the controller returns `search-failed` with the error message as `detail`. It does not try another provider.

### Fetch a page through the active provider

1. `web_fetch` calls the active provider first (via `WebPageFetcher`, satisfied by `SearchProviderController`).
2. With no provider page capability, the controller answers `no-fetch-provider` and the tool uses the sandbox transport exactly as before.
3. An active provider that refuses (`fetch-failed`) is reported with its own detail; the tool does not retry through the transport.
4. Provider Markdown is passed to `sanitizeWebContent` as `text/markdown`: injection scan, secret redaction and the untrusted banner all still apply.

## Notes for maintainers

- Keep `index.ts` as the primary consumer-facing surface.
- Put new shared contracts in `types.ts` before moving them into runtime modules.
- If a new provider implementation is added, prefer exposing only the factory and type surface unless the provider needs to be part of the stable API.
- Treat `src/lib` and `src/harness/web` as the current external module dependency surface; avoid widening this module's dependencies without a clear need. The one deliberate exception is `src/commands/providers`: DeepSeek's search key is borrowed from the chat-model provider, and that registry is the single source of the env-var name. It is a directory-level cycle (`src/commands` already imports this module), accepted because six other harness modules already import it and `src/lib/import-policy.ts` does not forbid `client → adapter`; the alternative — every caller injecting a resolver — would spread the rule across four surfaces.

## Reference

### Public API

- `connectedProviderIds`
- `createSearchProviderRegistry`
- `SearchProviderRegistry`
- `SearchProviderController`
- `createDefaultSearchProviderController`
- `searchCredentialResolver`

### Key files

| File | Imports | Importers |
|------|---------|-----------|
| `src/harness/search/index.ts` | 4 | 9 |
| `src/harness/search/default-controller.ts` | 8 | 1 |
| `src/harness/search/types.ts` | 0 | 6 |
| `src/harness/search/controller.ts` | 3 | 2 |
| `src/harness/search/registry.ts` | 1 | 3 |
| `src/harness/search/search.test.ts` | 1 | 0 |

### Module dependencies

**Depends on:**
- `src/lib` (3 imports)
- `src/harness/web` (2 imports)
- `src/commands` (1 import)

**Depended on by:**
- `src/commands` (5 imports)
- `src/tui` (4 imports)
- `src/harness/tool/builtin` (1 import)
- `src/harness/web` (1 import)

### Entry points

- `src/harness/search/index.ts`

## Related pages

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/web](src-harness-web.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 1.1.0 — DeepSeek Search added as the sixth provider; credential borrowing from the chat-model key and the `insufficient-balance` reason documented.
- 1.2.0 — Optional provider page retrieval (`fetchPage`) and the `web_fetch` provider path documented.
- 1.3.0 — `connect()`, the permanent-refusal breaker, `provider-disconnected`/`retryable` page results and the deliberate `src/commands/providers` edge documented.
- 1.4.0 — Round-2 fixes: shared refusal store, bounded target lookup, cancellation as its own outcome, no fetch-side 429 ladder, capability-first `web_fetch` and a wizard routed through `connect()`.
