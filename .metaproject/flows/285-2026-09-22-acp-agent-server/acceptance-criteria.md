# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx acp` speaks JSON-RPC 2.0 over stdio and answers `initialize` with its protocol version, `agentCapabilities` and `agentInfo`; a request naming an unsupported protocol version is refused with a JSON-RPC error rather than a crash or a silent downgrade.
- AC2: `session/new` creates a keryx session bound to the requested working directory, and `session/prompt` runs a real harness turn in it; the driving client receives the answer as `session/update` notifications while the turn runs, not only at the end.
- AC3: A tool call that the policy engine would ask about produces a `session/request_permission` request; a denial from the client leaves the call unexecuted and the turn continues or ends exactly as a local denial does. A policy that denies outright never reaches the client at all.
- AC4: `session/cancel` stops the running turn, the turn ends with the same cancelled outcome a local abort produces, and no further `session/update` for that turn is sent afterwards.
- AC5: `session/list` and `session/load` expose the project's existing durable sessions: a session created through `keryx shell` is listed and can be loaded by an ACP client, and its history is replayed in the shape the spec defines.
- AC6: Client capabilities are honoured: with `fs` advertised, file reads and writes requested by the harness go through `fs/read_text_file` / `fs/write_text_file`; without it, the harness uses its own tools and the turn still completes. The same for `terminal`: absent capability means keryx never calls `terminal/*`.
- AC7: The wire types and the JSON-RPC framing live in one adapter module, and a protocol-version bump touches only that module plus its tests (shown by the test that pins the version constant and the shape).
- AC8: A conformance test drives the whole surface over a real stdio pipe against the built CLI — initialize, new, prompt with streaming updates, permission request and denial, cancel, list, load — with a fake provider, no network.
- AC9: README and the CLI reference document `keryx acp`, what a client must advertise, and what keryx does when a capability is absent.
- AC10: CI is green on the PR and `keryx health run` gate is pass.
