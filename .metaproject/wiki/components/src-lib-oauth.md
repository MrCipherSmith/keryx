---
Title: Module src/lib/oauth
Version: 0.1.0
Type: component
Status: draft
Summary: "OAuth support layer for device-code login, grant management, token refresh, and authenticated runtime access."
---

# Module src/lib/oauth

## Overview

`src/lib/oauth` is the OAuth support layer inside `src/lib`. It provides the building blocks used by CLI commands, the terminal UI, and provider integrations to start a login, manage saved OAuth grants, refresh expired credentials, and make access tokens available to processes that require them.

This module owns OAuth authentication and grant state at a level below user-facing commands. It does not implement the full command UI or provider-specific product flows. Instead, it exposes a reusable API for:

- Starting a device-code login and returning the challenge information needed for the user to continue
- Recording, loading, listing, and deleting OAuth grants after login
- Checking whether a stored grant has a usable access token or needs refresh
- Refreshing provider grants and returning current access tokens
- Preparing environment variables that make OAuth access available to a process or provider adapter

**Module stats:** 15 files, 19 public symbols, 7 cross-module imports from `src/lib`.

## Key concepts

| Concept | Description |
|---------|-------------|
| **`OAuthGrant`** | The normalized credential record for an authenticated provider. Represents state needed to reuse an existing sign-in. |
| **`OAuthGrantMethod`** | The flow or mechanism through which a grant was obtained. Keeps grant state distinct from raw token values. |
| **`LoginChallenge`** | Information produced when a login is started and the user must complete an external authorization step. Contains the data needed for the user to continue outside the application. |
| **`DeviceLoginInput` / `DeviceLoginResult`** | Input and result types for the device-code login operation exposed through `loginDeviceCode`. |
| **Provider** | A target that can be authenticated through OAuth. Provider identity is visible in grant lifecycle and refresh APIs. |
| **Refresh** | The process of exchanging a saved grant for a current access token when the previous token is no longer valid. |
| **OAuth access environment** | An environment object that makes an access token available to an external process or provider runtime. |

## Architecture

The module follows a small layered design:

```
┌─────────────────────────────────────────────┐
│             Public API (19 symbols)         │
├─────────────────────────────────────────────┤
│  login.ts         │ Central entry point     │
│  grants.ts        │ Grant model & lifecycle │
│  catalog.ts       │ Provider metadata       │
├───────────────────┼─────────────────────────┤
│  device-code.ts   │ Device-code protocol    │
│  open-url.ts      │ URL-opening helper      │
└───────────────────┴─────────────────────────┘
```

**Key files:**

- `src/lib/oauth/login.ts` — Central login orchestration. Connects `loginDeviceCode` with lower-level helpers.
- `src/lib/oauth/grants.ts` — Most widely imported file. Owns `OAuthGrant`, `OAuthGrantMethod`, and related functions: `loadOAuthGrant`, `saveOAuthGrant`, `deleteOAuthGrant`, `listOAuthGrantProviders`, `oauthGrantStatus`, `oauthAccessToken`, `grantNeedsRefresh`.
- `src/lib/oauth/catalog.ts` — Shared provider catalog or metadata. Imported by seven files.
- `src/lib/oauth/device-code.ts` — Device-code protocol implementation. Produces `LoginChallenge` and completes login.
- `src/lib/oauth/open-url.ts` — URL-opening support for presenting authorization challenges to users.

## Main flows

### Start a device-code login and save the grant

1. A command or TUI action begins a login using `DeviceLoginInput` and calls `loginDeviceCode`.
2. `login.ts` uses the device-code implementation to produce a `LoginChallenge` for the user.
3. The application opens the required authorization URL with the URL-opening helper.
4. After authorization completes, the login call returns a `DeviceLoginResult`.
5. Tokens from the result can be normalized into an `OAuthGrant` with `grantFromTokens` and recorded with `saveOAuthGrant`.

This flow separates user-facing presentation from credential management: the UI handles the challenge, while the module owns login completion and grant creation.

### Refresh a saved provider grant

1. A caller asks the module to refresh saved credentials, for example through `refreshSavedGrants` or for a specific provider with `refreshProviderGrant`.
2. The module may enumerate saved provider identities with `listOAuthGrantProviders` and load individual grants with `loadOAuthGrant`.
3. `grantNeedsRefresh` determines whether a grant requires a fresh token, and `oauthAccessToken` can return a current token for a usable grant.
4. When a grant is refreshed, the updated credential can be saved again through `saveOAuthGrant`.

This flow is useful before provider operations that require a valid token, allowing stored credentials to be reused safely instead of forcing a new interactive login.

### Provide OAuth access to a provider runtime

1. `src/harness/provider` or a command needs an authenticated environment for an external process or provider adapter.
2. It can call `envWithOAuthAccess` to obtain an environment containing the OAuth token, or `applyOAuthAccessToEnv` to add the token to an existing environment.
3. The helpers use the module's grant and token helpers so callers do not need to inspect grant internals directly.

This keeps token handling localized to the OAuth module while allowing commands and provider code to work with ordinary environment data.

## Public API

### Device login

- `LoginChallenge` — Interface with challenge details for the user
- `DeviceLoginInput` — Interface with input parameters for login
- `DeviceLoginResult` — Result of a completed device login
- `loginDeviceCode` — Initiates the device-code login flow

### Grant lifecycle

- `OAuthGrant` — Interface representing a stored OAuth credential
- `OAuthGrantMethod` — Enum or type for grant acquisition methods
- `loadOAuthGrant` — Load a saved grant for a provider
- `saveOAuthGrant` — Persist a grant after login or refresh
- `deleteOAuthGrant` — Remove a saved grant
- `listOAuthGrantProviders` — Enumerate providers with stored grants
- `oauthGrantStatus` — Get the current status of a grant
- `logoutProvider` — Revoke a grant and clean up stored credentials

### Token refresh and access

- `oauthAccessToken` — Extract a usable access token from a grant
- `grantNeedsRefresh` — Check if a grant's token is expired or invalid
- `refreshProviderGrant` — Refresh credentials for a specific provider
- `refreshSavedGrants` — Refresh all stored provider grants

### Environment helpers

- `envWithOAuthAccess` — Build an environment object with OAuth access
- `applyOAuthAccessToEnv` — Add OAuth access to an existing environment
- `grantFromTokens` — Construct a grant from raw OAuth tokens

## Dependencies

| Module | Imports | Role |
|--------|---------|------|
| `src/lib` | 7 | Shared library primitives |
| `src/commands` | 10 | CLI login and credential workflows |
| `src/tui` | 4 | Interactive login and credential display |
| `src/harness/provider` | 1 | Authenticated provider access |

---

## Reference

### Key file stats

| File | Imported by | Imports |
|------|-------------|---------|
| `src/lib/oauth/grants.ts` | 9 | 1 |
| `src/lib/oauth/catalog.ts` | 7 | 1 |
| `src/lib/oauth/device-code.ts` | 6 | 0 |
| `src/lib/oauth/login.ts` | 5 | 6 |
| `src/lib/oauth/open-url.ts` | 5 | 0 |
| `src/lib/oauth/login.test.ts` | 0 | 5 |

### Graph signals

- Files: 15
- Cross-module imports: 7
- Public symbols: 19

---

## Related pages

- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/provider](src-harness-provider.md)

---

## Changelog

- **0.1.0** — Initial prose draft generated by `keryx wiki collect` (2026-09-16)
