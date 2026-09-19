# Agent bus P4: pause leases — held turns, git-publish floor, bus_pause, override

Status: formalized
Source: docs/requirements/keryx-agent-bus/ (phase P4), operator request 2026-09-19

## Problem

After P3 (flow 274), agents can message each other, but there is still no way
to say "hold off while I cut a release". That was the operator's motivating
case. A pause request today is only text. Nothing holds a peer's turns, and
nothing stops a peer's `git push`, even in `auto` mode.

## Expected Outcome

P4 of the spec is implemented: §4.3, §4.4, §5.2 step 5, §5.4 step 2, §7.1
`bus_pause`, §7.2 and §7.3 pause/resume/override, D-03, D-05, D-09, D-12 and
D-13, and `agent-protocol.md` §2.

**Leases**
- A pause lease is created together with its `pause-request` event under one
  `append.lock` hold. It carries a TTL (default 30 minutes, maximum 4 hours), a
  reason, and targets that never include the holder.
- It has one of three scopes: `turns`, `git-publish` or `advisory`.
- A holder may hold only one active lease. At most one CLI lease is active in a
  clone.
- A lease ends in one of these ways:
  - `resume` from the holder, or from an operator outside a tool call;
  - expiry;
  - the holder becoming gone. A stale holder keeps its lease.
- A target's operator can `override` a lease for their own instance.

**Enforcement**
- `turns` holds new main-agent turns from every source and shows a banner.
  `/bus` still works while turns are held.
- `git-publish` adds a `publishLease` approval floor. Publishing commands then
  prompt in every mode, including `auto`, and a saved allowlist cannot
  auto-approve them.

**Surfaces**
- The agent tool `bus_pause`, with risk `write`.
- `/bus pause|resume|override` in the shells.
- `keryx bus pause|resume` on the CLI.
- On clean exit, a holder resumes every lease it holds.

## Out of Scope

- MCP participation (v2).
- Wiki pages and the scenario write-up (P5).
