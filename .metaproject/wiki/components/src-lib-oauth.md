---
Title: Module src/lib/oauth
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/lib/oauth` groups 15 file(s). Depends on `src/lib`. Exposes 19 public symbol(s)."
---
# Module src/lib/oauth

## Summary

`src/lib/oauth` is the OAuth support layer inside `src/lib`. It provides the building blocks used by CLI commands, the terminal UI, and provider integrations to start a login, manage saved OAuth grants, refresh expired credentials, and make access tokens available to processes that require them.

The module contains 15 files and depends on `src/lib` through 7 cross-module imports. It exposes 19 public symbols and is consumed mainly by `src/commands`, `src/tui`, and `src/harness/provider`.

## Overview

This module owns OAuth authentication and grant state at a level below user-facing commands. It does not implement the full command UI or provider-specific product flows. Instead, it exposes a reusable API for:

- starting a device-code login and returning the challenge information needed for the user to continue;
- recording, loading, listing, and deleting OAuth grants after login;
- checking whether a stored grant has a usable access token or needs refresh;
- refreshing provider grants and returning current access tokens;
- preparing environment variables that make OAuth access available to a process or provider adapter.

The result is a bridge between interactive sign-in and authenticated runtime behavior. `src/commands` and `src/tui` use it for login and credential state, while `src/harness/provider` uses it to obtain OAuth access for provider work.

## How it works

The public API and key-file graph suggest a small layered design:

- **Login orchestration:** `src/lib/oauth/login.ts` is the central entry point for login behavior. It connects the public `loginDeviceCode` function with lower-level login helpers and is exercised by `src/lib/oauth/login.test.ts`.
- **Device-code flow:** `src/lib/oauth/device-code.ts` contains the lower-level device-code logic used to create a `LoginChallenge` and complete the login attempt. `src/lib/oauth/open-url.ts` provides URL-opening support so the challenge can be presented to the user.
- **Grant storage and lifecycle:** `src/lib/oauth/grants.ts` is the most widely imported file and appears to own the OAuth grant model. It is the likely home for `OAuthGrant`, `OAuthGrantMethod`, and functions such as `loadOAuthGrant`, `saveOAuthGrant`, `deleteOAuthGrant`, `listOAuthGrantProviders`, `oauthGrantStatus`, `oauthAccessToken`, and `grantNeedsRefresh`.
- **Provider catalog and metadata:** `src/lib/oauth/catalog.ts` imports one dependency and is used by seven files, which suggests it holds shared provider catalog or metadata used by the rest of the module.
- **Consumer integration:** `src/commands` imports this module most heavily, `src/tui` uses it for interactive login and credential display, and `src/harness/provider` uses it when a provider needs authenticated access.

The module depends on `src/lib` for shared primitives and exposes a narrow authentication surface to the rest of the application.

## Key concepts

- **`OAuthGrant`:** the normalized credential record for an authenticated provider. It represents the state needed to reuse an existing sign-in rather than asking the user to log in again.
- **`OAuthGrantMethod`:** the flow or mechanism through which a grant was obtained. The public API uses this concept to keep grant state distinct from raw token values.
- **Provider:** a target that can be authenticated through OAuth. Provider identity is visible in grant lifecycle and refresh APIs.
- **`LoginChallenge`:** information produced when a login is started and the user must complete an external authorization step. In the device-code flow, this is the data that lets the user continue outside the application.
- **`DeviceLoginInput` and `DeviceLoginResult`:** the input and result types for the device-code login operation exposed through `loginDeviceCode`.
- **Refresh:** the process of exchanging a saved grant for a current access token when the previous token is no longer suitable for use.
- **OAuth access environment:** an environment object or mutation that makes an access token available to an external process or provider runtime, exposed through `envWithOAuthAccess` and `applyOAuthAccessToEnv`.

## Main flows

### 1. Start a device-code login and save the grant

1. A command or TUI action begins a login using `DeviceLoginInput` and calls `loginDeviceCode`.
2. `login.ts` uses the device-code implementation to produce a `LoginChallenge` for the user.
3. The application opens the required authorization URL with the URL-opening helper.
4. After authorization completes, the login call returns a `DeviceLoginResult`.
5. Tokens from the result can be normalized into an `OAuthGrant` with `grantFromTokens` and recorded with `saveOAuthGrant`.

This flow separates user-facing presentation from credential management: the UI handles the challenge, while the module owns login completion and grant creation.

### 2. Refresh a saved provider grant

1. A caller asks the module to refresh saved credentials, for example through `refreshSavedGrants` or for a specific provider with `refreshProviderGrant`.
2. The module may enumerate saved provider identities with `listOAuthGrantProviders` and load individual grants with `loadOAuthGrant`.
3. `grantNeedsRefresh` determines whether a grant requires a fresh token, and `oauthAccessToken` can return a current token for a usable grant.
4. When a grant is refreshed, the updated credential can be saved again through `saveOAuthGrant`.

This flow is useful before provider operations that require a valid token, allowing stored credentials to be reused safely instead of forcing a new interactive login.

### 3. Provide OAuth access to a provider runtime

1. `src/harness/provider` or a command needs an authenticated environment for an external process or provider adapter.
2. It can call `envWithOAuthAccess` to obtain an environment containing the OAuth token, or `applyOAuthAccessToEnv` to add the token to an existing environment.
3. The helpers use the module’s grant and token helpers so callers do not need to inspect grant internals directly.

This keeps token handling localized to the OAuth module while allowing commands and provider code to work with ordinary environment data.

## Public API groups

The 19 public symbols are focused on three concerns: login, grants, and runtime access.

- **Device login:** `LoginChallenge`, `DeviceLoginInput`, `DeviceLoginResult`, and `loginDeviceCode`.
- **Grant lifecycle:** `OAuthGrant`, `OAuthGrantMethod`, `loadOAuthGrant`, `saveOAuthGrant`, `deleteOAuthGrant`, `listOAuthGrantProviders`, and `oauthGrantStatus`.
- **Token refresh and access:** `oauthAccessToken`, `grantNeedsRefresh`, `refreshProviderGrant`, and `refreshSavedGrants`.
- **Environment and conversion helpers:** `envWithOAuthAccess`, `applyOAuthAccessToEnv`, and `grantFromTokens`.

## Dependency shape

- Depends on `src/lib` for shared library behavior.
- Imported by `src/commands`, making it a core dependency for CLI workflows.
- Imported by `src/tui`, which needs login challenges and grant status.
- Imported by `src/harness/provider`, which needs authenticated provider access.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `LoginChallenge` (interface)
- `DeviceLoginInput` (interface)
- `DeviceLoginResult`
- `loginDeviceCode` (function)
- `refreshProviderGrant` (function)
- `refreshSavedGrants` (function)
- `logoutProvider` (function)
- `OAuthGrantMethod`
- `OAuthGrant` (interface)
- `loadOAuthGrant` (function)
- `saveOAuthGrant` (function)
- `deleteOAuthGrant` (function)
- `listOAuthGrantProviders` (function)
- `oauthGrantStatus` (function)
- `oauthAccessToken` (function)
- `grantNeedsRefresh` (function)
- `envWithOAuthAccess` (function)
- `applyOAuthAccessToEnv` (function)
- `grantFromTokens` (function)

### Key files

- `src/lib/oauth/login.ts` - imported by 5, imports 6
- `src/lib/oauth/grants.ts` - imported by 9, imports 1
- `src/lib/oauth/catalog.ts` - imported by 7, imports 1
- `src/lib/oauth/device-code.ts` - imported by 6, imports 0
- `src/lib/oauth/login.test.ts` - imported by 0, imports 5
- `src/lib/oauth/open-url.ts` - imported by 5, imports 0

### Depends on

- `src/lib` - 7 import(s)

### Depended on by

- `src/commands` - 10 import(s)
- `src/tui` - 4 import(s)
- `src/harness/provider` - 1 import(s)

### Graph signals

- Files: 15
- Cross-module imports: 7

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/provider](src-harness-provider.md)

## Changelog

- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
