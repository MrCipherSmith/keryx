# Speak the Agent Client Protocol, so any ACP client can drive the keryx harness

## Why now

JetBrains announced Air on 2026-09-22 and made the Agent Client Protocol the seam
between an IDE and an agent's full harness, with a registry of compatible agents, on
the stated assumption that agentic development will be multi-vendor. Zed already ships
ACP clients. An agent that speaks ACP is reachable from those editors without either
side writing a bespoke integration — the same argument LSP won.

keryx has the half that is hard to copy: a project brain in the repository and a
harness with policy, sandboxing, sessions, subagents and evidence-gated completion. It
has no way for an editor to drive that harness. Today the only entry points are
`keryx shell`, `keryx harness run` and the MCP servers, none of which an ACP client can
talk to.

## What this flow builds

`keryx acp` — the keryx harness as an ACP **agent** over JSON-RPC on stdio, so an ACP
client (a JetBrains IDE, Zed, anything else in the registry) runs it as a subprocess and
drives it.

Protocol surface, from the ACP schema (https://agentclientprotocol.com/protocol/schema):

- agent methods keryx must answer: `initialize` (protocol version + capability
  negotiation), `session/new`, `session/prompt`, `session/cancel` (notification),
  `session/load`, `session/list`, and `authenticate` only if it advertises auth methods;
- client methods keryx may call: `session/update` (streaming notifications — the turn's
  text, reasoning, tool calls and their results), `session/request_permission` (the
  policy engine's ask path), `fs/read_text_file` / `fs/write_text_file` and the
  `terminal/*` family when the client advertises those capabilities.

The mapping that makes this worth doing: keryx sessions are already durable per project,
so `session/load` and `session/list` are a surface over what `keryx sessions` already
holds; the allow/ask/deny policy already exists, so `session/request_permission` is the
ask path exposed over the wire; reasoning already streams, so `session/update` carries
it.

## Out of scope

- The client side (keryx driving someone else's ACP agent). That is the mirror image and
  belongs in its own flow; the external-agent codecs (`src/harness/external/codec/`)
  already do this shape for claude-cli and codex-cli.
- HTTP/WebSocket transport. The spec marks it work in progress; stdio is what clients
  use today.
- Publishing to any registry. That is a release decision, not a code change.

## Risks

- The spec is young and will move. Keep the wire shape in one adapter module with its
  own types, so a version bump is one file, not a sweep.
- Capability negotiation is the whole compatibility story: a client that does not
  advertise `terminal` must never see keryx try to use it, and a client that does not
  advertise `fs` must not stall a turn that wants to read a file — the harness has its
  own file tools and must fall back to them.
- Permission semantics must not soften: an ACP client answering `session/request_permission`
  stands in for the operator, so a denied call stays denied and the sandbox still applies.
