# Decisions: Keryx Provider Auth
Version: 1.0.0

## Status

Decision record. It exists because the most important decision here is a
*refusal*, and a later reader deserves the reasoning and the sources rather than
an unexplained gap in the provider list.

## D-01: Subscription OAuth only where the vendor sanctions third-party clients

**Question.** Codex, Claude Code and opencode let a user authorize by opening a
link and confirming a subscription. Should keryx offer the same for Anthropic
Claude Pro/Max and for ChatGPT Plus/Pro?

**Decision: no, not for those two.** The mechanism is adopted; those particular
providers are not.

**Reasoning.** Anthropic's Consumer Terms state that OAuth tokens obtained
through Claude Free, Pro or Max accounts may not be used in any other product,
tool or service, and that third-party developers may not offer Claude.ai login
or route requests through consumer-plan credentials on behalf of their users.
Third-party products are directed to API-key authentication through the Console
or a supported cloud provider. Enforcement began in January 2026; the policy
took effect in April 2026, with reports of OAuth failures and account
disruption for third-party tools.

keryx is a third-party tool. The consequence of ignoring this does not land on
the project — it lands on the operator, whose own subscription is the thing that
gets disrupted. Shipping a feature whose predictable outcome is the user's
account being restricted is not a trade-off worth making, and no amount of
"it currently works" changes what the terms say.

OpenAI draws the same line by a different route: ChatGPT sign-in exists to serve
Codex, OpenAI's own client, while developers building tools and automations are
directed to platform API keys. Treat it as the same class until OpenAI states
otherwise.

**Where it *is* sanctioned.** GitHub Copilot: GitHub documents the OAuth device
flow for its CLI and shipped support for a third-party agent authenticating with
Copilot subscriptions in January 2026. That is an explicit invitation, and it is
implemented here.

**Consequence for the provider list.** Anthropic stays API-key-only. OpenAI is
added API-key-only. GitHub Copilot is added with the device flow. If a vendor
later publishes terms permitting third-party subscription clients, adding it is
a registry entry and a method — no re-architecture — which is precisely why the
method is a declared property rather than a hard-coded branch.

**Sources.**
- [Anthropic bans subscription OAuth in third-party apps](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
- [The Register: Anthropic clarifies ban on third-party tool access to Claude](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [GitHub: authenticating Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
- [GitHub Changelog: Copilot now supports opencode](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/)
- [opencode providers](https://opencode.ai/docs/providers/)

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

**Decision.** Each provider entry declares its method. Adding a provider, or
changing how an existing one authenticates, is a registry edit.

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
