# Hub context watch
Version: 0.1.2

Status: implementation verified; owner acceptance pending. Canonical lifecycle: Team Hub project keryx; no duplicate legacy local Flow. The frozen specification retains its original pre-implementation wording as historical contract; current results are in the report.

Keep shared wiki/OpenSpec context current while an explicitly started local watch process is running. This is the first slice toward serve-to-Hub background synchronization.

## Documents

- [Product requirements](prd.md)
- [Specification](specification.md)
- [Implementation and verification plan](plan.md)
- [Execution journal](journal.md)
- [Documentation review](review.md)
- [Watch event schema](schemas/watch-event.schema.json)
- [Usage and recovery](usage.md)
- [Implementation report](report.md)

Related: [connector](../team-hub-prototype/connector.md), [MCP](../hub-mcp/README.md), [distribution direction](../team-hub-prototype/distribution-notes.md).

Scope: opt-in polling, incremental shared context cache, safe concurrent writers, retry and shutdown. No code synchronization, Git changes, document approval, system daemon, automatic startup, or Telegram serve integration.
