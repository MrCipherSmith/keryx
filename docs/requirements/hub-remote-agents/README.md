# Remote agents through Team Hub
Version: 0.1.1

Status: specification prepared for owner review; remote-control runtime not implemented. This package specifies the next Hub Flow, not a deployment or an authorization to execute work on a machine.

A human selects an enrolled machine, explicitly registered checkout, locally allowed Keryx agent profile and in-progress Flow in the web UI. The local keryx serve receives a typed command over an outbound WebSocket, executes under its local policy, streams bounded progress, asks for single-action approvals, accepts cancellation and uploads a review-only result.

## Documents

- [Product requirements](prd.md)
- [Normative specification and acceptance criteria](specification.md)
- [Transport, API and recovery protocol](protocol.md)
- [Security and local execution policy](security.md)
- [Implementation and verification plan](plan.md)
- [Existing source and reuse assessment](reuse.md)
- [Readable schema copies](schemas.md)
- [Machine protocol schema](schemas/machine-protocol.schema.json)
- [HTTP and local policy schemas](schemas/control-api.schema.json)
- [Verification and review record](review.md)
- [Headless session and future web chat extension](session-runtime.md)

Scope: macOS/Linux, one Hub process, multiple paired machines and explicit checkouts; native Keryx executor as the first coding adapter. The currently empty-tool serve assembly must be completed as part of implementation. Codex/Claude execution adapters, OpenCode, arbitrary terminals, attaching existing desktop sessions, automatic Git delivery and hosted multi-tenant service are future work.

Related: [existing Hub](../team-hub-prototype/README.md), [MCP](../hub-mcp/README.md), [context watch](../hub-context-watch/README.md), [distribution](../team-hub-prototype/distribution-notes.md).
