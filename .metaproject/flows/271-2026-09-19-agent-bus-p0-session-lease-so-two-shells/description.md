# Agent bus P0: session lease so two shells never share one session

Status: formalized
Source: docs/requirements/keryx-agent-bus/ (phase P0), operator request 2026-09-19

## Problem

Two `keryx shell` processes can open the same session and silently overwrite
each other's turns:

- `openSession` (`src/session/store.ts:888`) takes no lock.
- `persistHistory` (`:699`) rewrites `context.jsonl`, `archive.jsonl` and
  `summary.json` in full from the in-memory history.
- `-c` resolves to `latestSession`, which is the most recently updated session.

So a second `keryx shell -c` attaches to whatever the first shell is writing
right now, and whichever process saves last wins.

## Expected Outcome

This implements phase P0 of `docs/requirements/keryx-agent-bus/`: specification
§3.1 and §6, decisions D-07 and D-09, and `schemas/session-lease.schema.json`.

- **The lease.** A shell holds an exclusive, heartbeated session lease on the
  session it has open. The lease is released on exit and moved on every
  in-process session switch.
- **`-c`.** Skips sessions that another live or stale instance holds.
- **`-r <id>` on a held session.** Never opens it for writing.
  - Interactive: offers fork, view and cancel, plus take over when the holder is
    stale.
  - Non-interactive: exits non-zero with a `--fork` hint.
- **Bare `-r`.** Marks held sessions and never silently picks one.
- **`keryx sessions list`.** Shows which sessions are live.
- **Dead or hung holders.**
  - A crashed holder's lease becomes reclaimable after 15 s.
  - A hung holder (stale: same host, pid alive) keeps its lease until an
    explicit `--take-over`.

## Out of Scope

- Every other part of the bus: presence, the event log, delivery, tools,
  `/bus`, `keryx bus` and pause leases (phases P1–P5).
- The lease owner's `name` is written as `null` in P0; P2 fills it in.
- Coordination across hosts, beyond recording `host`.
