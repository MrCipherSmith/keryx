# Specification: Keryx Provider Auth
Version: 1.1.0

## Identity and status

`keryx-provider-auth` extends the implemented provider registry
(`src/commands/providers.ts`) with declared authentication methods per entry,
and adds the OAuth 2.0 device authorization grant as a new method. It introduces
no credential store, no provider adapter, and no runtime dependency. Subscription
OAuth is not Grok-only: every vendor-sanctioned grant is in scope; every
forbidden one is an explicit refusal. See [decisions.md](decisions.md) §D-01.

## Method taxonomy

Every registry entry declares at least one permitted method. A provider that
has both a sanctioned subscription login and a platform key declares both
(for example `grok`: `device-code` and `api-key`). No entry declares a method
its vendor prohibits.

| Method | Meaning | Remote-capable | Secret via transport |
|---|---|---|---|
| `none` | Local endpoint, no credential. | Yes | — |
| `api-key` | Bearer key the operator already holds. | No — entry needs the machine | No |
| `device-code` | RFC 8628 device authorization grant. | **Yes** | No |
| `oauth-pkce-loopback` | Authorization code + PKCE with a loopback redirect. | No — the redirect must reach the machine | No |
| `cloud-credentials` | Delegated to a cloud provider's own credential chain. | Depends on the chain | No |

"Remote-capable" means the method can be completed by an operator holding only a
phone. It is the property that decides what a transport may offer.

## Device authorization grant

The mechanism that makes remote setup work. It requires no loopback listener and
no browser on the keryx machine, which is exactly the gap the credential handoff
link in [keryx-remote-entry](../keryx-remote-entry/README.md) cannot close.

```text
keryx                          provider                    operator's phone
  |-- POST device endpoint ------->|
  |<-- device_code, user_code, ----|
  |    verification_uri, interval  |
  |                                |
  |-- render code + URL ---------------------------------->| opens URL,
  |                                |                        | enters code,
  |                                |<-----------------------| approves
  |-- POST token endpoint (poll) ->|
  |<-- access_token (+ refresh) ---|
```

### Lifecycle rules

| Rule | Requirement |
|---|---|
| Polling interval | Honour the `interval` the provider returned. Never poll faster. |
| Backoff | On `slow_down`, increase the interval as the grant specifies and continue. |
| Pending | `authorization_pending` is the normal case and is not an error. |
| Denial | `access_denied` is terminal. No retry, and the pending grant is discarded. |
| Expiry | `expired_token`, or the grant's own lifetime elapsing, is terminal. A new grant must be requested. |
| Overall bound | Polling has a bounded total lifetime independent of the provider's, so a stalled grant cannot poll indefinitely. |
| Single flight | One pending grant per provider. A second request supersedes the first, which is discarded rather than left polling. |
| Cancellation | The operator can abandon a pending grant, and abandoning stops the polling. |

### What keryx never sees

The operator's browser talks to the provider directly. keryx never receives the
password, the subscription session, or any credential other than the token the
grant returns. The transport carries only the short user code and a public
verification URL.

## Registry shape

The methods are declared alongside the fields the registry already carries —
base URL, endpoint paths, model fallbacks, env var — per
[provider-entry.schema.json](schemas/provider-entry.schema.json).
The picker offers every declared method for the chosen provider.

The registry remains the single source of truth. The picker, the remote surface
and a transport's command menu all derive their behaviour from it, so adding a
provider or changing how one authenticates is a registry edit.

This also keeps the compliance boundary in D-01 reviewable: which providers may
use subscription login is a property of a data file, not a condition buried in a
flow.

## Provider list

Wave 1 is the device-grant runtime plus every sanctioned subscription that
keryx already has (or will add) an inference path for. Wave 2 is extra
OAuth that needs a new adapter. Cloud credential chains stay deferred.

### Implemented today (all `api-key` or `none`)

| Provider | Method today |
|---|---|
| Ollama, Rapid-MLX | `none` |
| Anthropic (native) | `api-key` |
| OpenAI (native) | `api-key` |
| Gemini (native) | `api-key` |
| OpenRouter, DeepSeek, Z.AI, Z.AI Coding Plan, Cerebras, Groq, Moonshot, xAI Grok | `api-key` |

### Wave 1 — ship with this package

| Provider | Methods | Subscription? | Note |
|---|---|---|---|
| **xAI Grok** | `device-code`, `api-key` | SuperGrok / X Premium | RFC 8628 against `auth.x.ai`. TUI: `/provider` → xAI → SuperGrok, not API key. |
| **GitHub Copilot** | `device-code` | Copilot | GitHub's documented CLI device flow. New provider; no keryx adapter yet, added with this package. |
| **OpenAI** | `oauth-pkce-loopback`, device-style headless, `api-key` | ChatGPT Plus/Pro (Codex) | Browser PKCE locally; Codex device-auth headless for remote/SSH. Platform key remains. |
| Google Gemini | `api-key` | No | Native adapter already. Google-account OAuth is Gemini CLI only — refused, see D-01. |
| DeepSeek | `api-key` | No | No consumer OAuth. Keep the existing key path. |
| Anthropic | `api-key` | No | Claude Pro/Max OAuth is forbidden. Keep the native key path. |
| Mistral, Together, Fireworks, DeepInfra, Perplexity, Nebius | `api-key` | No | Inference hosts. |
| LM Studio, llama.cpp | `none` | — | Local, matching Ollama. |

### Wave 2 — sanctioned, after an adapter exists

| Provider | Methods | Note |
|---|---|---|
| GitLab Duo | `oauth-pkce-loopback`, Personal Access Token | OpenCode lists it with ChatGPT and Copilot as a permitted subscription. keryx has no GitLab adapter today. |
| DigitalOcean Inference | `oauth-pkce-loopback`, model access key | Account OAuth, not a consumer LLM sub. |
| Snowflake Cortex | `oauth-pkce-loopback`, PAT | Same class. |

### Deferred

Amazon Bedrock, Google Vertex AI, Azure OpenAI: `cloud-credentials`. See
[decisions.md](decisions.md).

### Deliberately absent (stated at the point of choice)

- **Claude Free/Pro/Max subscription OAuth.** Anthropic forbids third-party use.
  Community plugins exist; keryx will not ship them.
- **Gemini "Sign in with Google".** Official Gemini CLI path, not a third-party
  grant. Vertex ADC is the enterprise alternative (deferred).
- **DeepSeek subscription OAuth.** The product has none.

The reasoning and sources are in [decisions.md](decisions.md) §D-01.

## Presentation by location

A method's `remoteCapable` property decides what happens when authorization is
requested from a transport:

| Situation | Behaviour |
|---|---|
| `device-code`, requested remotely | Proceeds. The code and verification URL are rendered; the operator approves on their phone. |
| `api-key`, requested remotely | Explains that this provider needs a key and that entry requires the machine, and offers the local handoff link for when the operator is there. It does **not** issue a link that cannot open. |
| `oauth-pkce-loopback`, requested remotely | Same treatment: the redirect must reach the machine. |
| Any method, requested locally | Proceeds through the TUI as today. |
| Unsupported subscription requested | States that the vendor does not permit third-party subscription login, and offers the API-key path. Stating this at the point of choice is the requirement; failing later is not acceptable. |

## Credential storage

Results of every method — API key, access token, refresh token, expiry, scope —
are stored per [credential-grant.schema.json](schemas/credential-grant.schema.json)
in the existing user-global store at mode 0600. This package introduces no store
of its own.

Refresh happens where the grant supports it. A refresh failure surfaces as an
authorization error; it is never a silent downgrade to an unauthenticated or
differently-authenticated state.

## CLI surface

```text
keryx auth list                       # providers, methods, authorization state
keryx auth login <provider>           # runs the provider's declared method(s); prompts when more than one
keryx auth logout <provider>          # discards the stored grant
keryx auth status <provider>          # method, expiry, refreshability — never the secret
```

`keryx auth list` shows which providers are authorized and when a grant expires.
It never prints a secret.

## Acceptance criteria

| ID | Given / when / then |
|---|---|
| AC-01 | Given the provider registry, when it is validated, then every entry declares at least one permitted authentication method, and none declares a method its vendor prohibits. |
| AC-02 | Given a provider added to the registry, when the picker, the remote surface and a transport menu are enumerated, then it appears in all three with no change outside the registry. |
| AC-03 | Given a `device-code` provider and an operator with only a phone, when authorization runs, then it completes with no loopback listener, no browser on the keryx machine, and no secret in the transport. |
| AC-04 | Given a device grant returning `interval`, when polling runs, then it never polls faster than that interval. |
| AC-05 | Given `slow_down`, when it is received, then the interval increases and polling continues. |
| AC-06 | Given `authorization_pending`, when it is received, then it is treated as normal progress and not as an error. |
| AC-07 | Given `access_denied`, when it is received, then polling stops, the grant is discarded, and no retry occurs. |
| AC-08 | Given `expired_token` or an elapsed grant lifetime, when polling runs, then it stops and a new grant is required. |
| AC-09 | Given a grant that stalls, when the bounded overall lifetime elapses, then polling stops regardless of what the provider reported. |
| AC-10 | Given a pending grant and a second request for the same provider, when the second is made, then the first is discarded and only one grant polls. |
| AC-11 | Given an abandoned grant, when the operator cancels, then polling stops. |
| AC-12 | Given an `api-key` provider requested remotely, when the request is made, then the response explains that entry requires the machine, and no loopback link is issued. |
| AC-13 | Given a request to authorize a vendor subscription the terms forbid, when it is made, then it is declined with the reason and the API-key alternative, at the point of choice. |
| AC-14 | Given the registry, when it is validated, then no entry declares a method its vendor prohibits. |
| AC-15 | Given any completed method, when the credential is stored, then it is written to the user-global store at mode 0600 and appears in no log, evidence record, session, stream event, notification, or command output. |
| AC-16 | Given an expired refreshable grant, when it is used, then it refreshes transparently; and given refresh fails, then an authorization error surfaces rather than a silent downgrade. |
| AC-17 | Given `keryx auth list` or `status`, when run, then authorization state and expiry are shown and no secret is printed. |
| AC-18 | Given a local `none` provider, when no credential exists anywhere, then it remains fully usable and startup is unaffected. |
| AC-19 | Given the whole suite, when it runs, then every flow is exercised against a fake authorization server with no live vendor endpoint and no real credential. |
| AC-20 | Given the `grok` entry, when the picker lists auth methods, then SuperGrok `device-code` and `api-key` are both offered. |
| AC-21 | Given the `openai` entry, when the picker lists auth methods, then ChatGPT Plus/Pro OAuth and `api-key` are both offered. |
| AC-22 | Given Anthropic, Gemini, or DeepSeek, when the picker lists auth methods, then only `api-key` is offered, and a Claude Pro / Google-account / DeepSeek-subscription choice is not present. |
