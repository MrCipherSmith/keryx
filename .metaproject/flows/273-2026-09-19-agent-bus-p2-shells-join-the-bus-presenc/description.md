# Agent bus P2: shells join the bus — presence, heartbeat, poller, /bus, peers

Status: formalized
Source: docs/requirements/keryx-agent-bus/ (phase P2), operator request 2026-09-19

## Problem

P1 (flow 272) gave the clone a bus store and a `keryx bus` CLI. No running
`keryx shell` uses them yet: a shell writes no presence, reads no events, and
shows the operator nothing. Two shells in the same clone still cannot see each
other.

## Expected Outcome

This implements P2 of the spec: §4.1, §5.1, §5.2 (render, peers, lease view),
§5.4, §6.2 step 3, §7.2 (non-pause subcommands) and §7.4.

- Every interactive shell (TUI agent, TUI chat, readline chat, readline agent)
  joins the bus right after its session lease is taken. On join it:
  - picks a name from `--name`, the `bus.name` config, or `agent-<n>`,
    following D-06;
  - writes presence;
  - starts an unref'd 5 s heartbeat that refreshes presence and patches the
    session lease `name`;
  - starts an unref'd poller at `busPollMs`;
  - prints `bus: joined as @<name> · <n> peers`.
- Inbound events addressed to this instance are rendered to the operator as
  one line each, even while the agent is busy. They are not yet delivered to
  the agent; that is P3.
- `/bus` is available in the TUI (a modal with Peers, Leases and Log, plus
  `send`, `ask`, `reply` and `name`) and in readline. It works while the agent
  is busy.
- The fleet sidebar shows a Peers group.
- Presence is removed on every clean exit, becomes `gone` within 15 s of a
  crash, and follows session switches.
- A disabled bus (`KERYX_BUS=off`, `bus.enabled: false`, or CI) skips joining
  with a one-line reason and changes nothing else.

## Out of Scope

- Delivery to the agent, wakes, and the `bus_*` tools: P3.
- Pause leases (`held`, `git-publish`, `/bus pause|resume|override`): P4.
- MCP participation.
