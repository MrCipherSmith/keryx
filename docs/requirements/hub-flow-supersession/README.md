# Human Flow supersession and closure
Version: 0.1.1

Status: future; specification prepared for review. No closure runtime, API or UI is claimed implemented. Existing Hub freeze/start/submit/accept behavior does not supply supersession.

This package specifies a human action that closes an obsolete draft as superseded by another Flow in the same project, preserving its evidence and history. It is separate future work from the ongoing full headless sessions implementation. Creating this package does not close any Flow or modify the current twenty-four-criterion Flow.

## Documents

- [Product requirements](prd.md)
- [Normative specification and eight acceptance criteria](specification.md)
- [Implementation and mandatory real validation plan](plan.md)
- [Documentation review](review.md)

## Scope

The first feature permits closure only from `initializing` or `ready`; it requires a reason, replacement link, authenticated human identity, optimistic concurrency, idempotency and an audit event. The UI exposes closed history and board filters in Russian and English. Historical criteria, context pins and artifacts remain readable.

Active cancellation, closing work in progress, reopening, automatic supersession, deletion and treating closure as completion or acceptance are out of scope. Agent tokens cannot execute the human action.

## Required real validation

After implementation, an authenticated human operator must use the new product UI or human API workflow to close old draft `53751ed0-ea9d-45d3-9bea-b5d0c3877f10` as superseded by `98a3b05b-9d24-493f-b9bf-a9cfdd276ab9`, with the reason that scope expanded to full headless Keryx sessions. This is mandatory release validation, not an optional demonstration. The operator must verify the recorded facts and eligibility first. The user's instruction authorizes that future workflow; it does not authorize an agent token to impersonate the operator. Do not close the old draft now or edit database rows. See [the full procedure](plan.md#mandatory-real-acceptance-check).

Related packages: [Team Hub prototype](../team-hub-prototype/README.md), [full headless sessions](../hub-remote-sessions/README.md), [Hub MCP](../hub-mcp/README.md). The main session owns the [roadmap](../roadmap.md) integration and creation of a separate future implementation Flow.
