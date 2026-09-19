# Agent bus P1: clone-wide bus store and keryx bus CLI

Status: formalized
Source: docs/requirements/keryx-agent-bus/ (phase P1), operator request 2026-09-19

## Problem

P0 (flow 271) stops two shells from sharing one session. The shells still have
no shared place to find each other or exchange messages. The agent bus
specification defines that place: a store in the git common directory holding
presence records, an append-only event log and pause leases, together with a
`keryx bus` CLI. None of it exists yet, and phases P2–P4 (shell integration,
agent delivery, pause leases) all depend on it.

## Expected Outcome

This phase implements P1 of `docs/requirements/keryx-agent-bus/`: the
specification (§2.1, §3.2, §4, §5.2 steps 1–3, §7.3, §7.4, §9), decisions D-02,
D-06, D-09, D-12 and D-13, and `artifact-lifecycle.md`.

- **Clone-scoped bus root.** The bus root is
  `<git-common-dir>/keryx/bus/<project-key>/`. The key comes from the resolved
  project root, so a subdirectory and a linked worktree both land on the same
  bus. Outside git, the root falls back to the user's data dir.
- **Store library (`src/bus/`).** It covers:
  - schema-validated records with UUID-checked ids;
  - presence read and write, with D-09 liveness and D-06 names;
  - an append-only log with crash-safe `seq` under a lock, redacted and bounded
    bodies, rotation, and a cursor reader that survives rotation;
  - a pause-lease reader using the active rule;
  - prune.
- **CLI.** `keryx bus list|log|send|prune`. It includes:
  - the D-13 refusal inside a tool call, via a new `KERYX_TOOL_CALL=1` marker
    set only on `shell_exec` children;
  - a clone-wide CLI rate limit;
  - a `bus-disabled` refusal that names its reason.

  All four commands are registered, documented and covered.

## Out of Scope

- Shell join, heartbeat, poller, fleet peers and `/bus` (P2).
- Delivery to the agent and the `bus_*` tools (P3).
- Writing pause leases, and `keryx bus pause|resume` (P4). P1 only reads lease
  files.
- MCP participation (v2).
