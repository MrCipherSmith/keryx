# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx acp` started with no `--provider`/`--model` uses the same provider and model that `keryx shell` would use in that project, resolved by the same code path rather than a copy of it; explicit flags still override. A test proves the default path never constructs the fake or fixture provider — that provider is reachable only through the explicit test-only `--fixture` flag.
- AC2: When no provider is configured and none is passed, `keryx acp` still answers `initialize`, and `session/new` and `session/load` are refused with a JSON-RPC error whose message names what to configure and how; no turn ever runs against a fake provider. The same condition is written once to stderr at startup.
- AC3: `session/new` and `session/load` accept a non-empty `mcpServers` list of stdio servers: each is started with its `command`, `args` and `env` through keryx's existing MCP client, its tools are offered to that session's turns, and every server process keryx started is stopped when the connection closes — shown by a test that checks the processes are gone.
- AC4: A call to a tool that comes from a client-supplied MCP server goes through the same `session/request_permission` ask as any other gated call and never runs without an explicit allow; a denial ends the call exactly as a local denial does.
- AC5: A server that fails to start does not fail the session: the session is created, the other servers still work, and the failure is reported to the client with the server's name and the reason. An `http` or `sse` entry — transports keryx does not advertise — is refused per entry with the reason rather than silently dropped.
- AC6: The `env` values and header values from `mcpServers` never reach transcripts, session records, logs, stdout or stderr: a test plants a sentinel secret in an entry's `env`, drives a full turn that calls the server's tool, and asserts the sentinel appears in none of them.
- AC7: A process test drives the built CLI over a real stdio pipe with a real stdio MCP server fixture from the repository: `session/new` with that server succeeds, its tool is offered, the permission ask arrives, the call runs on allow and returns its result, and the server process is gone after the connection closes. No network.
- AC8: The CLI reference and README describe how `keryx acp` resolves its provider and model when no flag is given, what happens when nothing is configured, which `mcpServers` transports are accepted, and how a failed server is reported; the claim that the flags work "the same way `keryx shell` does" is true.
- AC9: CI is green on the PR and `keryx health run` gate is pass.
