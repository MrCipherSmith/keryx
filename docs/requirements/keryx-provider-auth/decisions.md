# Decisions: Keryx Provider Auth
Version: 1.1.0

## Status

Decision record. It exists because the most important decision here is a
*refusal*, and a later reader deserves the reasoning and the sources rather than
an unexplained gap in the provider list.

## D-01: Subscription OAuth only where the vendor sanctions third-party clients

**Question.** Codex, Claude Code, Gemini CLI and OpenCode let a user authorize
by opening a link and confirming a subscription. Which of those logins may
keryx offer?

**Decision.** The mechanism is adopted. The providers are not interchangeable.
A subscription login ships only when the vendor has invited third-party
clients. "It works in another CLI" is not enough.

### Sanctioned (ship)

| Provider | Method in keryx | Why it is permitted |
|---|---|---|
| **xAI SuperGrok / X Premium** | `device-code` (RFC 8628), plus `api-key` | xAI published [Use Grok in OpenCode](https://x.ai/news/grok-opencode) and exposes `device_authorization_endpoint` on `auth.x.ai`. Same public Grok-CLI client OpenCode and Grok Build use. |
| **GitHub Copilot** | `device-code` | GitHub documents the device flow for CLI clients and shipped third-party agent support (OpenCode, Crush). |
| **OpenAI ChatGPT Plus/Pro (Codex)** | `oauth-pkce-loopback` locally, device-style headless remotely, plus `api-key` | OpenAI publicly worked with OpenCode in January 2026 so Codex/ChatGPT subscriptions can be used in third-party agents. Platform API keys remain the non-subscription path. |
| **GitLab Duo** | `oauth-pkce-loopback` or Personal Access Token | OpenCode ships it as a built-in sanctioned subscription. Second wave: keryx has no GitLab adapter yet. |

### Forbidden (never ship as subscription login)

| Provider | Why | What keryx offers instead |
|---|---|---|
| **Anthropic Claude Free/Pro/Max** | Consumer Terms forbid using those OAuth tokens in any other product. Anthropic blocked third-party tools in January 2026, removed the path from OpenCode after legal requests, and the cost of ignoring it is the operator's account. Community plugins still exist; keryx will not. | Native Anthropic adapter, `api-key` only. |
| **Google Gemini "Sign in with Google"** | That OAuth is for Gemini CLI / Code Assist. Third-party reuse of the consumer Google login is the same class as Claude: not a published invitation, and account disruption is reported. | Gemini adapter, `api-key` (`GEMINI_API_KEY`). Vertex stays `cloud-credentials` (deferred). |
| **DeepSeek** | No consumer OAuth / device grant. The product is a Bearer key at `api.deepseek.com`. | Already in the registry as `api-key`. |

### Other API-key-only inference hosts

OpenRouter, Z.AI (including GLM Coding Plan), Cerebras, Groq, Moonshot, Mistral,
Together, Fireworks, DeepInfra, Perplexity, Nebius: they sell keys, not a
third-party-sanctioned subscription OAuth. Coding-plan keys (Z.AI) are still
`api-key`.

**Consequence for the registry.** A provider may declare every *permitted*
method (SuperGrok and an xAI API key on the same `grok` entry). It may never
declare a method the vendor prohibits. Adding or removing a subscription login
is a registry edit plus a recorded source, not a TUI special case.

**Sources.**
- [xAI: Use Grok in OpenCode](https://x.ai/news/grok-opencode)
- [OpenAI Codex authentication](https://developers.openai.com/codex/auth/) — ChatGPT sign-in is the subscription path for Codex; OpenCode ships the same ChatGPT Plus/Pro OAuth as a built-in provider
- OpenAI Codex (Tibo, Jan 2026): public statement that Codex subscriptions would be usable in OpenCode directly
- [GitHub: authenticating Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
- [GitHub Changelog: Copilot now supports opencode](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/)
- [OpenCode providers](https://opencode.ai/docs/providers/) — ChatGPT Plus, GitHub Copilot, GitLab Duo listed as zero-setup subscriptions; Claude Pro/Max explicitly prohibited
- [The Register: Anthropic clarifies ban on third-party tool access to Claude](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/) — Google-account sign-in is the official CLI path, not a third-party grant

## D-02: The device authorization grant is the primary remote method

**Question.** How is a provider authorized when the operator is holding a phone
and keryx is on a machine somewhere else?

**Decision.** Implement the OAuth 2.0 device authorization grant (RFC 8628) as a
first-class authentication method.

**Reasoning.** It was designed for exactly this shape: a client that cannot host
a browser obtains a short user code and a verification URL, the human approves
on whatever device they have, and the client polls for the token. Applied here:

- the secret never travels through Telegram — only a short code and a public
  verification URL do;
- **no loopback is required**, which closes the gap left open by the credential
  handoff link in [keryx-remote-entry](../keryx-remote-entry/README.md), where
  a link to `127.0.0.1` is useless from a phone;
- the operator's browser talks to the provider directly, so keryx never sees the
  password or the subscription session.

The credential handoff link is not replaced: it remains the method for plain API
keys, which have no grant to negotiate. The two are complementary — handoff for
a key the operator already holds, device grant for a token keryx must obtain.

Comparison of the alternatives considered:

| Option | Remote-capable | Secret via transport | Verdict |
|---|---|---|---|
| Paste the API key into the chat | Yes | **Yes** | Rejected in [telegram 2.2.0](../keryx-telegram-transport/brainstorm.md). |
| One-time loopback handoff link | No — needs a browser on the machine | No | **Kept** for API keys, local use. |
| Authorization code + PKCE, loopback redirect | No — the redirect must reach the machine | No | Kept as the local browser flow where a provider offers OAuth but no device grant. |
| **Device authorization grant** | **Yes** | **No** | **Selected** as the primary remote method. |

## D-03: The authentication method is registry data, not a code branch

**Decision.** Each provider entry declares its permitted methods. Adding a
provider, or changing how an existing one authenticates, is a registry edit.

**Reasoning.** `src/commands/providers.ts` is already the single source of truth
for base URLs, model lists, endpoint paths and env vars, and its header says so.
Authentication is the same kind of fact. Keeping it there means the picker, the
remote surface and the Telegram menu all derive behaviour from one place, and a
provider whose terms change is a one-line edit rather than a hunt through
branches.

It also keeps D-01 enforceable: "which providers may use subscription login" is
a reviewable property of a data file, not a condition buried in a flow.

## D-04: Local providers stay first-class

**Decision.** Providers requiring no credential — Ollama, LM Studio, llama.cpp —
declare method `none` and remain fully supported.

**Reasoning.** keryx's core is deterministic, local and offline-first, and its
model assets are optional by design. An authentication feature must not quietly
make a cloud account feel mandatory.

## Deferred

- Whether to support enterprise cloud credential chains (Bedrock, Vertex, Azure)
  directly or leave them to environment configuration.
- Token refresh scheduling policy for grants that expire while a long run is in
  flight.
- Whether the verification code should ever be delivered by voice, given that
  speaking a one-time code aloud is a poor idea in most rooms.
