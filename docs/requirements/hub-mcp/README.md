# Shared Team Hub MCP

Status: implementation complete; independent security review APPROVE and release SDK1.32.1 verification PASS. Linux container and standalone validation passed; exact-candidate Hub handoff is being recorded; owner acceptance remains pending.

- [Specification](specification.md)
- [Implementation plan](plan.md)
- [Architecture and worker contracts](architecture.md)
- [Execution journal and resume gate](journal.md)
- [Client configuration](clients.md)
- [Runtime deployment and rollback](deployment.md)
- [geekom activation and read-only Codex trial](activation.md)
- [Verification report](report.md)
- [Distribution and onboarding notes](../team-hub-prototype/distribution-notes.md)

Hub project: `fcb56bb6-6eb6-4c2e-b154-1d682432a778`.
Flow: `0cce9652-6bbe-4ee9-89bc-92e275a8d3e4` — Enable shared Team Hub MCP access and a secure stdio bridge.
Specification: `specs/hub-mcp.md`, document `dcf0ec34-6f81-412a-a2a8-fb848c8e5880`, version 1.
Digest: `ddb89ea0c5aa3dd1c150f00dfcda20c094c6fff4fcb003d9de7d92d62209c855`.
Twelve acceptance criteria. Hub state is canonical; no duplicate local legacy Flow is created.

The intended output is one remote Streamable HTTP endpoint and a local stdio bridge, with named project-scoped agent keys and existing human approval restrictions. This document does not claim public MCP is enabled or installed in any client.

Independent preimplementation review: APPROVE, no blocking inconsistencies. The recorded human freeze and work start were verified before implementation dispatch.

2026-10-27 follow-up: verified runtime activated on geekom with backup/rollback and unchanged project state. Dedicated read-only Codex configuration and actual HTTP/stdio probes passed. Embedded Codex app-server independently discovered all11 allowed read tools; the already-open chat catalogue is not refreshed. The phone-controlled session can test through the verified MCP bridge without laptop UI access; see activation.md. Public Cloudflare machine access remains pending.
