# ACP live-client fixes: real provider by default, accept client MCP servers

## Why

The first real ACP client to drive `keryx acp` — Zed, on the operator's machine, minutes after
0.2.154 shipped — hit two defects that the flow-285 test suite could not see, because that suite
starts the server with a scripted fixture and an empty `mcpServers` list.

1. **The default provider is a test double.** `src/commands/acp.ts` initialises
   `provider = "fake"` and `model = "fake-model"`. Without `--provider`/`--model` the server runs
   `FakeProvider`, which answers only pre-recorded request hashes; the operator's first real
   message failed with `FakeProvider: no transcript matches request hash …`. The CLI reference
   meanwhile says the flags "select the model backend the same way `keryx shell` does", which
   promises a fallback to the configured backend that does not exist.
2. **Every `session/new` from Zed is refused.** Zed forwards the MCP servers configured in its own
   settings on every `session/new`. keryx refuses any non-empty `mcpServers` with `-32602`
   (`src/acp/server.ts`, the F-8 refusal) because it had no way to register a server for one
   session. That refusal was honest, but it makes keryx unusable in Zed for anyone with a single
   MCP server configured — which is most users.

## What this flow does

- Resolve the provider and model for `keryx acp` the way `keryx shell` resolves them when no flag
  is given; make the fixture provider reachable only through the explicit test-only `--fixture`
  flag; and when nothing is configured, refuse session creation with a message that says what to
  configure — never run a fake silently.
- Accept client-supplied stdio MCP servers on `session/new` and `session/load`: start them with
  keryx's existing MCP client, offer their tools to that session's turns behind the same permission
  ask as any gated call, and stop them when the connection ends. Refuse, per entry and with the
  reason, the transports keryx does not advertise (`http`, `sse`).
- Keep the secrets those server entries carry (the operator's own Zed config held a GitHub token
  and an API key in exactly this position) out of transcripts, logs, session records and stdout.

## Out of scope (flow B, next)

Advertising slash commands to the client, switching model from the editor, and exposing keryx's
own graph/wiki/memory/flow tools inside an ACP session.
