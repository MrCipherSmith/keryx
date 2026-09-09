# PRD: Keryx Provider Auth
Version: 1.1.0

## Problem

Two gaps, one of them embarrassing.

**The provider list still authenticates one way.** Native Anthropic, OpenAI and
Gemini adapters exist, and the compat registry covers OpenRouter, DeepSeek,
Z.AI, Cerebras, Groq, Moonshot and xAI. Every one of them is a Bearer API key
from an environment variable or a TUI prompt. An operator with SuperGrok,
ChatGPT Plus or Copilot cannot use that subscription in keryx.

**That one way does not travel.** A key prompt works at a keyboard. It does not
work from a phone: the credential handoff link in
[keryx-remote-entry](../keryx-remote-entry/README.md) resolves to loopback, and
a loopback link is unreachable from somewhere else. Remote setup therefore stops
at the first provider that needs a credential.

## Goal

Make authorization work from a phone without a secret ever passing through the
chat, and offer every *vendor-sanctioned* subscription login — SuperGrok,
ChatGPT Plus/Pro, GitHub Copilot — next to the existing API-key path. Claude
Pro/Max, Gemini Google-account login, and a fictional DeepSeek OAuth stay
refused. The device authorization grant is the remote method; each provider
declares its permitted methods in the registry.

## Constraint that shapes the solution

Subscription login is adopted **only where the vendor sanctions third-party
clients**. That is now a per-vendor fact, not a blanket "no subscriptions":

- **Ship:** xAI SuperGrok, OpenAI ChatGPT Plus/Pro (Codex), GitHub Copilot.
- **Refuse:** Anthropic Claude Free/Pro/Max OAuth; Gemini "Sign in with Google";
  DeepSeek has no such grant.

This is a compliance boundary, not an engineering one. The matrix and sources
are in [decisions.md](decisions.md) §D-01.

## Non-goals

- Subscription login for providers whose terms forbid third-party clients.
- Any workaround that borrows another client's credentials.
- A second credential store.
- Reselling or pooling credentials.

## Users and scenarios

| User | Scenario | Outcome |
|---|---|---|
| Operator at the keyboard | Adds a provider needing an API key | Enters it in the TUI or through the local handoff link, as today. |
| Operator on a phone | Adds a provider supporting the device grant | Receives a short code and a verification URL, approves in the phone's browser; keryx obtains the token by polling. Nothing secret is in the chat. |
| Operator on a phone | Adds a provider needing an API key | Told plainly that this provider needs a key and that entry requires the machine — rather than being handed a link that cannot open. |
| Operator with SuperGrok | Wants Grok in keryx without an API key | `/provider` → xAI → SuperGrok device-code; usage from the subscription. |
| Operator with ChatGPT Plus/Pro | Wants Codex models in keryx | ChatGPT OAuth (browser locally, device-style headless remotely), or a platform API key. |
| Operator with a Copilot subscription | Wants to use it | Authorizes through the device flow, which GitHub sanctions. |
| Operator with a Claude Max subscription | Expects to authorize by link | Told that Anthropic's terms do not permit third-party subscription login, and pointed to a Console API key. Their account is not put at risk. |
| Operator with Gemini / DeepSeek | Expects a Google or DeepSeek subscription login | Gemini: API key only (Google-account OAuth is Gemini CLI). DeepSeek: API key only; no consumer OAuth exists. |
| Operator offline | Uses a local model | Ollama and other local providers declare method `none` and need nothing. |

## Requirements

### Functional

| ID | Requirement |
|---|---|
| FR-01 | Every provider registry entry declares one or more permitted authentication methods from `none`, `api-key`, `device-code`, `oauth-pkce-loopback`, `cloud-credentials`. |
| FR-02 | The registry stays the single source of truth. Adding a provider or changing its methods is a registry edit, not a code branch. |
| FR-03 | Implement the device authorization grant (RFC 8628): request a code, present the user code and verification URL, poll the token endpoint, honour `interval`, `slow_down`, `expired_token` and `access_denied`. |
| FR-04 | A device grant needs no loopback listener and no browser on the keryx machine. |
| FR-05 | A method's presentation adapts to where the operator is. Remotely, `device-code` proceeds; `api-key` and `oauth-pkce-loopback` explain that they need the machine rather than issuing an unusable link. |
| FR-06 | Obtained credentials — key, token, refresh token, expiry — are stored only in the existing user-global store at mode 0600. |
| FR-07 | Tokens that expire are refreshed where the grant supports it; a refresh failure surfaces as an authorization error, never as a silent downgrade. |
| FR-08 | Wave 1 subscription logins: xAI SuperGrok (`device-code` + `api-key`), OpenAI ChatGPT Plus/Pro (`oauth-pkce-loopback` / headless + `api-key`), GitHub Copilot (`device-code`). Gemini and DeepSeek stay `api-key`. Claude Pro/Max OAuth is not offered. |
| FR-09 | A provider whose terms forbid third-party subscription login declares only the methods it permits. The registry never carries a method the vendor prohibits. |
| FR-10 | Authorization state is inspectable: which providers are authorized, by which method, and when a grant expires — without revealing any secret. |

### Non-functional

| ID | Requirement |
|---|---|
| NFR-01 | No new runtime dependency. The device grant is two HTTP calls and a polling loop. |
| NFR-02 | Offline-safe. Absent credentials never break startup, and local providers stay usable. |
| NFR-03 | Every flow is exercisable offline against a fake authorization server, with no real credential and no live vendor endpoint. |
| NFR-04 | Secrets never appear in logs, evidence, session history, stream events, notifications, or command output. |

## Success criteria

| ID | Criterion |
|---|---|
| SC-01 | A provider supporting the device grant can be authorized end to end from a phone, with no secret in the transport and no loopback. |
| SC-02 | A provider needing an API key, requested remotely, produces a clear explanation instead of an unusable link. |
| SC-03 | The registry declares a method for every entry, and no entry declares a method its vendor forbids. |
| SC-04 | Adding a provider is a registry edit; a test asserts the picker, the remote surface and the transport menu all follow without further change. |
| SC-05 | An expired grant refreshes where supported, and fails visibly where not. |
| SC-06 | No fixture, log, or rendered message contains a real or synthetic credential value. |

## Risks

| Risk | Mitigation |
|---|---|
| A vendor's terms change and the registry silently becomes non-compliant | The method is a reviewable field in one data file, and [decisions.md](decisions.md) records the terms each entry was chosen under, so a review has something to check against. |
| Pressure to add subscription login "because it works today" | D-01 records that the cost lands on the operator's account, not the project. Working is not the same as permitted. |
| Device-grant polling hammers a vendor endpoint | The grant's own `interval` and `slow_down` are honoured, with a bounded overall lifetime. |
| A verification code leaks in a group chat | Codes are short-lived and single-use; rendering follows the transport's existing redaction and delivery rules, and the code authorizes only the pending grant. |
| The provider list becomes a maintenance burden | Entries are data. Model lists are already resolved live, so entries do not go stale in the usual way. |
| An operator assumes their subscription works and finds it does not | The unsupported case is stated at the point of choice, with the reason and the working alternative, rather than failing later. |

## Recommendation

Add the method taxonomy to the registry, implement the device grant first
because it unlocks remote setup, and in the same change wire Wave 1
subscription logins: SuperGrok, ChatGPT Plus/Pro, GitHub Copilot. Claude
Pro/Max, Gemini Google-account OAuth, and DeepSeek stay API-key-only.
