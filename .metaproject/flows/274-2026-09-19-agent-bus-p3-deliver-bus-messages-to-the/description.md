# Agent bus P3: deliver bus messages to the agent — drains, wake, bus_list and bus_send tools

Status: formalized
Source: docs/requirements/keryx-agent-bus/ (phase P3), operator request 2026-09-19

## Problem

After P2 (flow 273), shells join the bus and show inbound messages to the
operator. The agent itself sees none of them: a peer's question never enters
the agent's context, nothing wakes an idle agent, and the agent has no way to
see its peers or send them anything.

## Expected Outcome

This implements P3 of the spec: §5.3, §7.1 (`bus_list`, `bus_send`; `bus_pause`
is P4), §9 items 1–3, D-04, D-05, D-10, D-12 and `agent-protocol.md`.

- **Delivery into history.** Inbound events go into an in-memory `busInbox` and
  are drained into agent history at three points:
  - turn start, when the origin is `bus-message`;
  - the round boundary;
  - after a plain-text answer.

  Each non-empty drain adds one `role: "user"`, `provenance: "tool"` message
  with a banner and `<peer-message …>` blocks. Bodies are quarantined and
  escaped. An `ack` is written only after the message is in history.
- **Waking an idle agent.**
  - The TUI wakes an idle agent for wake-eligible kinds: `question`, `reply`,
    `handoff`, and `notice` addressed by name. Broadcast notices never wake.
  - The wake shares the auto-wake cap with task notifications and also fires
    on turn settle.
  - Readline does not wake. Messages are announced and delivered with the next
    turn.
- **Agent tools.** `bus_list` and `bus_send`, both risk `read`, are available
  to the main interactive agent only, never to subagents or external children.
  The `agent-protocol.md` conduct text goes into the system prompt, and only
  when the bus is joined.

## Out of Scope

- Pause leases, `bus_pause`, the `publishLease` floor and held turns (P4).
- MCP participation (v2).
