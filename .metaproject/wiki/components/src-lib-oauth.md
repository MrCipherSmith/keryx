---
Title: Module src/lib/oauth
Version: 1.0.1
Type: component
Status: accepted
VerifiedScope: sha256:8789e876176447e987d1b2ac2f81ed67bca8868ccacb165edb09b8af9bc2e722
Summary: "OAuth support layer for device-code login (xAI Grok, GitHub Copilot, ChatGPT/Codex), grant storage in auth.json, token refresh, and environment injection of saved access tokens."
---

# Module src/lib/oauth

## Overview

`src/lib/oauth` is the OAuth support layer inside `src/lib`. It owns sign-in and saved-grant state for providers that authenticate with a device-code flow: xAI Grok, GitHub Copilot, and ChatGPT/Codex. The CLI commands in `src/commands` and the terminal UI in `src/tui` call into it to start a login, store the resulting grant, decide whether a stored grant needs refreshing, and expose the access token to a process. The module does not draw the prompts or run the product flows; those stay with the callers.

## Key concepts

| Concept | Description |
|---------|-------------|
| **`OAuthGrant`** | The stored credential for one provider: `access`, an optional `refresh`, `expires` (epoch milliseconds, absent when the issuer gave no `expires_in`), `accountId`, `obtainedAt` and `lastRefreshedAt`. Persisted in the `oauthGrants` map of the user-global `auth.json` (mode 0600). |
| **`OAuthGrantMethod`** | How a grant was obtained, `"device-code"` or `"oauth-pkce-loopback"`. The login paths in this module only write `"device-code"`. |
| **`LoginChallenge`** | What the user needs to finish sign-in outside the process: `userCode`, `verificationUri`, optional `verificationUriComplete`, and human-readable `instructions`. Built by `present` in `login.ts`. |
| **`DeviceLoginInput` / `DeviceLoginResult`** | Input to `loginDeviceCode`: provider, injected `fetch`, optional `sleep`, `now`, `signal` and `dir`, plus the `onChallenge` callback. The result is `{ ok: true, provider }` or `{ ok: false, error, refused? }`, where `refused` marks a login the catalog forbids. |
| **`ProviderAuthCatalog` / `AuthMethodKind` / `DeviceCodeEndpoints`** | Declarations in `catalog.ts` of the auth methods a provider sanctions and its device endpoints, client ID, scope and headers. A method is listed only when the vendor allows third-party clients. |
| **`DeviceCodeChallenge` / `DeviceTokenSet`** | Protocol-level values from `device-code.ts`. The `deviceCode` stays inside the process. |
| **Provider alias** | `openai` is read and cleared as `openai-codex`. `loadOAuthGrant`, `listOAuthGrantProviders` and `logoutProvider` all apply this mapping. |
| **Refresh** | Exchanging a saved `refresh` token for a new access token once `expires` is within a 120-second skew window (`grantNeedsRefresh`). |
| **OAuth access environment** | A fixed mapping, `OAUTH_ENV_KEYS`, from provider to environment variable: `grok` to `XAI_API_KEY` and `github-copilot` to `GITHUB_COPILOT_TOKEN`. |

## How it works

The module is layered, and each layer depends only on the ones below it.

At the bottom, `catalog.ts` declares, per provider, which auth methods are sanctioned and the device-code endpoints, client IDs and request headers they use (`XAI_GROK_DEVICE`, `GITHUB_COPILOT_DEVICE`). `catalogRefusal` supplies the message for subscription logins the catalog forbids. Protocol code sits next to it. `device-code.ts` implements the generic RFC 8628 steps (request a code, poll the token endpoint, refresh an access token) and reports failures as `DeviceCodeError` with a `kind`. `openai-codex.ts` and `copilot.ts` add the provider-specific steps: the ChatGPT device endpoints, and the exchange of a GitHub token for a Copilot token. `openai-subscription.ts` refreshes ChatGPT grants.

In the middle, `grants.ts` is the storage and model layer. It reads and writes the `oauthGrants` map through `src/lib/shell-config`, keyed by provider. `grantFromTokens` turns a token set into an `OAuthGrant` with an absolute expiry time. `oauthGrantStatus` returns the redacted view that `keryx auth status` prints, so token values only leave the store through the access functions. `envWithOAuthAccess` and `applyOAuthAccessToEnv` copy tokens into the fixed environment variables in `OAUTH_ENV_KEYS`.

At the top, `login.ts` is the orchestrator. `loginDeviceCode` checks the catalog, chooses the Codex path (`loginCodex`) or the RFC 8628 path (`loginRfc8628`), passes the challenge to the caller's `onChallenge` callback, and then saves the grant. It also holds the refresh entry points, `refreshProviderGrant` and `refreshSavedGrants`, and `logoutProvider`.

`open-url.ts` sits outside this chain. `login.ts` does not import it. The callers (`src/commands/auth.ts`, `src/tui/tui-shell.ts`, `src/commands/select.ts`, `src/commands/mcp-servers.ts`) call `openVerificationUrl` when they receive a challenge.

## Main flows

### Start a device-code login and save the grant

1. A command or TUI action (`src/commands/auth.ts`, `src/commands/select.ts`, `src/tui/tui-shell.ts`) calls `loginDeviceCode` with a `DeviceLoginInput`.
2. `loginDeviceCode` looks up the provider with `authCatalogEntry`. If the provider does not list `device-code`, it returns a refusal or an unsupported error. For `openai-codex` it runs `loginCodex`. For other providers it runs `loginRfc8628`, which requests a device code, calls `onChallenge` with a `LoginChallenge`, and polls for the token. For `github-copilot` the GitHub token is then exchanged with `exchangeGithubTokenForCopilot`, and the returned API base URL is stored with `saveProviderBaseUrl`.
3. The caller shows the challenge to the user and opens `verificationUriComplete` through `openVerificationUrl`, while the poll continues.
4. On success, `grantFromTokens("device-code", …)` builds the grant and `saveOAuthGrant` writes it. For Codex, the module reads the grant back and fails with "Could not save ChatGPT login securely" if the stored access token does not match.
5. Any error becomes `{ ok: false, error }`. A cancelled signal produces "Device authorization was cancelled."

### Refresh saved grants before a session uses them

1. A surface such as `keryx shell` (`src/commands/shell.ts`) or ACP (`src/commands/acp.ts`) calls `refreshSavedGrants` with an HTTP object, a signal that bounds the total time, and the config directory.
2. It walks the providers `grok`, `github-copilot` and `openai-codex` one at a time, because each refresh rewrites `auth.json` and parallel writes would lose a grant.
3. For each grant, `grantNeedsRefresh` checks whether `expires` falls within 120 seconds. A grant that has expired and has no refresh token produces a warning that tells the user to run `keryx auth login`, rather than a silent failure.
4. `refreshProviderGrant` dispatches by provider. ChatGPT grants go to `refreshOpenAiCodexGrant`, Copilot grants go through the GitHub exchange again, and the others go to `refreshAccessToken`. The new grant is stamped with `lastRefreshedAt` and saved with `saveOAuthGrant`.
5. Failures are returned as warning strings for the caller to display. They are not thrown.

### Hand an access token to a provider runtime

1. `applyOAuthAccessToEnv` (called from `src/commands/auth.ts`, `src/tui/tui-shell.ts` and `src/commands/wiki.ts`) or `envWithOAuthAccess` (used by `src/commands/providers.ts`) reads each saved access token through `oauthAccessToken`.
2. A token is written only to its mapped variable, and only when that variable is unset or empty. `applyOAuthAccessToEnv` returns the keys it applied and records them with `noteSavedCredentialEnv`.
3. ChatGPT tokens are never copied onto `OPENAI_API_KEY`, because they are not platform API keys. Status and list surfaces (`oauthGrantStatus`, `listOAuthGrantProviders`) report metadata only and never return token values.

## Dependencies

| Module | Role |
|--------|------|
| `src/lib` | Shared library primitives (for example `src/lib/shell-config`, where grants are stored) |
| `src/commands` | CLI login and credential workflows |
| `src/tui` | Interactive login and credential display |
| `src/harness/provider` | Authenticated provider access |

---

<!-- keryx:reference:begin v=1 hash=a70ed0e8d07778b893498c6774e6d023124207090380f6cc1ecd0238f86e7ca5 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `OAuthGrantMethod`
- `OAuthGrant`
- `loadOAuthGrant`
- `saveOAuthGrant`
- `deleteOAuthGrant`
- `listOAuthGrantProviders`
- `oauthGrantStatus`
- `oauthAccessToken`
- `grantNeedsRefresh`
- `oauthEnvKeyFor`
- `envWithOAuthAccess`
- `applyOAuthAccessToEnv`
- `grantFromTokens`
- `LoginChallenge`
- `DeviceLoginInput`
- `DeviceLoginResult`
- `loginDeviceCode`
- `refreshProviderGrant`
- `refreshSavedGrants`
- `logoutProvider`

### Key files

- `src/lib/oauth/grants.ts` - imported by 25, imports 2
- `src/lib/oauth/login.ts` - imported by 11, imports 7
- `src/lib/oauth/openai-subscription.ts` - imported by 4, imports 6
- `src/lib/oauth/catalog.ts` - imported by 8, imports 1
- `src/lib/oauth/device-code.ts` - imported by 7, imports 0
- `src/lib/oauth/open-url.ts` - imported by 6, imports 0

### Depends on

- `src/lib` - 5 import(s)

### Depended on by

- `src/commands` - 18 import(s)
- `src/tui` - 4 import(s)
- `src/harness/provider` - 3 import(s)
- `src/harness` - 1 import(s)

### Dependency basis

- Production imports only: 18 import(s) from test file(s) (e.g. `src/commands/auth.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 21
- Cross-module imports: 5
<!-- keryx:reference:end -->

## Related pages

- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/provider](src-harness-provider.md)

---

## Changelog

- 1.0.1 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced. Hand-written data sections reconciled with the Reference block.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- **0.1.0** — Initial prose draft generated by `keryx wiki collect` (2026-09-16)
