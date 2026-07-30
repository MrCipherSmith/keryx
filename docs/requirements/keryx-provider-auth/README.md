# Keryx Provider Auth
Version: 1.0.0

## Purpose

This package specifies how keryx expands its provider list and how each provider
is authorized, including from a phone. It defines a small taxonomy of
authentication methods, makes the provider registry declare which one it uses,
and adds the **device authorization grant** so a provider can be authorized by
opening a link on any device — which is what makes remote setup work at all.

It serves both the local TUI and [keryx-remote-entry](../keryx-remote-entry/README.md),
so a provider is authorized the same way whether the operator is at the keyboard
or in [Telegram](../keryx-telegram-transport/README.md).

## Status

**Specification ready (future).** The provider registry it extends *is*
implemented (`src/commands/providers.ts`, eight OpenAI-compatible entries plus
native Anthropic and Ollama adapters). No new authentication method is
implemented today: every current provider is a Bearer API key or a local
endpoint.

## The finding that shapes this package

The obvious model — "authorize Claude with a Max subscription by opening a
link", the way Claude Code does — **is not available to keryx**, and building it
would harm the operator rather than help them.

Anthropic's Consumer Terms now state that OAuth tokens from Free, Pro and Max
plans may not be used in any other product, tool or service, and that
third-party developers may not offer Claude.ai login or route requests through
consumer-plan credentials. Enforcement began in January 2026 and the policy took
effect in April 2026. keryx is a third-party tool. Implementing subscription
OAuth would put **the operator's own account** at risk of disruption, not just
ours. OpenAI draws the same line: ChatGPT sign-in serves Codex, its own client,
while third-party tools use platform API keys.

Subscription-based login is therefore adopted **only where the vendor sanctions
third-party clients**. GitHub Copilot is the clear case: GitHub documents the
device flow for CLI clients and shipped support for a third-party agent in
January 2026.

The mechanism the user wanted is still the right one — it is simply pointed at
providers that permit it. See [decisions.md](decisions.md).

## Scope

- An authentication-method taxonomy the provider registry declares per entry.
- The **device authorization grant** (RFC 8628): keryx requests a code, the
  operator opens a verification URL on any device and approves, keryx polls for
  the token. No secret ever transits the transport, and no loopback is required.
- An expanded provider list covering the notable absences — OpenAI itself, and
  Google, Mistral and the major inference hosts — plus GitHub Copilot as the
  first sanctioned subscription provider.
- How each method is presented and completed over a remote transport.

## Non-goals

- Subscription login for providers whose terms forbid third-party clients. This
  is a compliance boundary, not a technical gap, and no workaround belongs here.
- Reselling, proxying, or pooling anyone's credentials.
- A credential store of its own — credentials continue to live in the existing
  user-global store at mode 0600.
- Provider-specific model catalogues, which the registry already resolves live.

## Document index

| Document | Purpose |
|---|---|
| [PRD](prd.md) | Problem, users, the compliance constraint, requirements, success criteria, risks. |
| [Specification](specification.md) | Method taxonomy, device-grant lifecycle, registry shape, expanded provider list, acceptance criteria. |
| [Decisions](decisions.md) | What was rejected and why, including the subscription-OAuth finding and its sources. |
| [Security policy](security-policy.md) | Token handling, polling discipline, remote rendering, revocation, compliance rules. |
| [Metrics and validation](metrics-and-validation.md) | Success metrics, offline fixtures, release evidence, explicit non-claims. |
| [Provider entry schema](schemas/provider-entry.schema.json) | Registry entry, including its declared authentication method. |
| [Device authorization schema](schemas/device-authorization.schema.json) | Device-grant request, verification material, and polling state. |
| [Credential grant schema](schemas/credential-grant.schema.json) | Stored result of any method, with refresh and expiry. |

## Related modules

- `src/commands/providers.ts`: the implemented registry this extends. It stays
  the single source of truth for providers, as it already is for base URLs,
  model lists and env vars.
- `src/harness/provider`: native adapters (`anthropic`, `ollama`) and
  `makeProvider`.
- `src/lib/shell-config.ts`: the user-global credential store (`auth.json`,
  mode 0600) that continues to hold every credential.
- [keryx-remote-entry](../keryx-remote-entry/README.md): exposes authorization
  remotely; its credential handoff covers API keys, and the device grant covers
  the rest.
- [keryx-telegram-transport](../keryx-telegram-transport/README.md): renders
  verification codes and links.

## Sources

Provider capabilities and terms were checked against vendor documentation and
contemporaneous reporting; the specific claims and their sources are recorded in
[decisions.md](decisions.md) rather than repeated here.
