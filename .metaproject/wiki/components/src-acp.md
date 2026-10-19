# Module src/acp

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/acp` is keryx's Agent Client Protocol (ACP v1) adapter: it lets an editor drive keryx as an agent over newline-delimited JSON-RPC on stdio. It groups 42 file(s) and depends on `src/harness/tool/builtin`, `src/commands` and `src/mcp-servers`.

## Overview

`src/acp` lets an editor such as Zed run keryx as an ACP agent: one stdio connection per launched `keryx acp` process, carrying initialization, sessions, prompt turns, cancellation and permission questions. It owns the ACP v1 wire surface (protocol version, method names, capability advertisement), the JSON-RPC envelopes and newline framing, and the bridge from those requests into keryx's sessions, turn loop, tool roster and approval gate. The four wire files (`protocol.ts`, `jsonrpc.ts`, `framing.ts`, `permission.ts`) are free of harness imports, while `server.ts` is where they meet keryx.

## How it works

The module is layered by how much each part knows about ACP. At the bottom, `jsonrpc.ts` holds the JSON-RPC 2.0 envelopes, the ACP-reserved error codes (`JSON_RPC_ERROR_CODES`, `AcpError`) and `classifyJsonRpcMessage`, which tells a request from a notification by the presence of the `id` key. `framing.ts` adds `AcpLineFramer`, which turns arbitrary stdio chunks into whole lines (it tolerates split UTF-8 sequences and `\r\n`, and fails once a line passes its size limit), plus `encodeAcpMessage` and the never-throwing `decodeAcpLine`.

`protocol.ts` is the only file a protocol version bump should touch. It holds `ACP_PROTOCOL_VERSION`, the method tables (`ACP_AGENT_METHODS`, `ACP_CLIENT_METHODS`), the wire types, and `KERYX_AGENT_CAPABILITIES`, which states what keryx promises (for example, `loadSession: true`, no image or audio prompts, stdio MCP only). Methods keryx knows but refuses are listed in `ACP_REFUSED_AGENT_METHODS` and answered with `-32601` plus a reason. `negotiateProtocolVersion` returns `exact`, `offer` (a newer client version, answered with keryx's ceiling) or `refuse`.

`permission.ts` is the mapping between ACP's `session/request_permission` outcomes and keryx's `ApprovalResponse`. Only an explicit allow becomes approval: `allow_once` maps to `true`, `allow_always` to a fingerprinted object, and every other answer to `false`. Escalated calls (`permissionIsEscalated`) are never offered an "always" option.

`server.ts` holds `runAcpServer`, which runs one connection. Its state is closure-scoped: `initialized`, `clientCapabilities`, the session registry, `activeTurns`, per-session model bindings, per-session hook runtimes and shared client-MCP sets. Only protocol frames go through `options.write`; diagnostics go through `options.logError`. Notifications that must follow a reply (MCP problems, the command list) are queued with `onReplied`. `roster.ts` (`buildAcpSessionTools`) decides what a turn can call: read-only builtins, project tools, `shell_exec`, `apply_patch`, and the client's `search_tool`/`use_tool` only when the client sent MCP servers. Web tools, subagents, the agent bus and `ask_user` are deliberately left out. The module header lists `dispatch.ts` as the method router; the imports also show `agent-io.ts`, `client-requests.ts`, `session.ts`, `session-mcp.ts`, `models.ts` and `commands.ts`, which I did not read in this pass.

## Key concepts

- **ACP protocol version**: a single `uint16` integer, not a semver string, bumped only for breaking changes. Non-breaking additions arrive as capabilities.
- **Capability advertisement**: `KERYX_AGENT_CAPABILITIES` and `KERYX_AUTH_METHODS`. Each `false` or omission is a promise to clients, so a client that calls an unadvertised method has a bug.
- **Session** (`AcpSessionState`, `AcpSessionRegistry`): a durable, project-rooted conversation. ACP gives it no end, because keryx advertises no `session/close` or `session/delete`. `session/load` replays one.
- **Turn** (`AcpActiveTurn`): one in-flight `session/prompt` per session. It holds an `AbortController`, a `cancelled` flag and the set of its open permission request ids. A second prompt is refused while a turn runs, not queued.
- **Permission request**: `session/request_permission` carries a full `ToolCallUpdate`, so a `tool_call` announcement must go out before the ask. `clientAnswersPermissions` latches false after the client refuses the method, and every later gated call is then denied.
- **Session config option**: the `model` select option returned by `session/new` and `session/load`. Each session keeps its own model binding, read once at the start of each turn.
- **Slash command**: text beginning with `/` that keryx answers itself (`/help`, `/model`, `/reasoning`, `/status`), without a model call.
- **Shared client MCP set** (`SharedMcpSet`): the client's stdio MCP servers, keyed by a hash of their list and shared across sessions that send the same list.
- **Stop reason** (`AcpStopReason`): `cancelled` is mandatory after `session/cancel`. `finishReasonToStopReason` maps keryx's budget and interruption finishes onto the ACP stop reasons.

## Main flows

1. **Handshake and session creation.** `initialize` goes through `requireObjectParams` and `negotiateProtocolVersion`, which returns the version and capabilities above and sets `initialized`. `session/new` (`handleSessionNew`) checks initialization, shutdown and provider availability, then calls `parseAcpMcpServers` before creating the session, so a malformed list creates nothing. It then runs `ensureShellHooksAndFireStart`, binds the session's client MCP servers with `bindSessionMcp`, queues the command list through `announceCommands`, and waits for the model list through `configOptionsFor`. That wait is bounded by `modelListTimeoutMs`, after which the session gets only the launch model.

2. **A prompt turn.** `handleSessionPrompt` checks that the connection is initialized, that the session exists and that no turn is running (`refuseIfBusy`). A slash command takes the slow path: keryx answers it and the model is never called. Otherwise `renderAcpPromptContent` renders the blocks, `sessionTools` builds the roster, and the session's model binding and hook runtime are assembled into `AgentDeps`. Model-side work runs under the turn's `AbortController`. The finish reason is mapped to an ACP stop reason, and `cancelled` is returned when the turn was cancelled.

3. **A permission question.** `askPermissionFor` denies at once when the turn is already cancelled or the client has refused the method. Otherwise it sends `session/request_permission` through `AcpClientRequests`, with the turn's id added to `permissionRequestIds` while the question is open. An error latches `clientAnswersPermissions` off. A closed or malformed answer is a denial. The response is returned unchanged, and `approvalFromPermissionResponse` in `permission.ts` decides whether it is an allow.

---

<!-- keryx:reference:begin v=1 hash=c0b5bebb2816a07e61df248ef95b0c7ef8c9fabc42eb8c4d03d33b3e88e08ffd -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `src/acp/protocol.ts` - imported by 32, imports 1
- `src/acp/server.ts` - imported by 2, imports 19
- `src/acp/jsonrpc.ts` - imported by 15, imports 0
- `src/acp/permission.ts` - imported by 9, imports 2
- `src/acp/roster.ts` - imported by 3, imports 8
- `src/acp/framing.ts` - imported by 8, imports 1

### Depends on

- `src/harness/tool/builtin` - 7 import(s)
- `src/commands` - 6 import(s)
- `src/mcp-servers` - 6 import(s)
- `src/harness/provider` - 4 import(s)
- `src/harness/tool` - 2 import(s)
- `src/session` - 2 import(s)

### Depended on by

- `src/harness/external` - 10 import(s)
- `src/commands` - 3 import(s)

### Dependency basis

- Production imports only: 28 import(s) from test file(s) (e.g. `src/acp/cancel-list-load.process.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/acp/index.ts`

### Graph signals

- Files: 42
- Cross-module imports: 28
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
- [Module src/commands](src-commands.md)
- [Module src/mcp-servers](src-mcp-servers.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/tool](src-harness-tool.md)
- [Module src/session](src-session.md)
- [Module src/harness/external](src-harness-external.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
