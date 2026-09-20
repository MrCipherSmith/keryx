# Shell god-files P2b: the remaining seams — bus wiring, splash lifecycle, side-worker predicate, and the two audits that need deciding

Status: formalized
Source: user description, 2026-09-20

## Problem

P2 (flow 277, PR #625) converted the audits its seams reached and stopped,
leaving 42 read sites across 13 files and a written list of the seams each
remaining audit waits on. This flow works that list.

One item on it was not like the others. `mcp-servers/invariants.test.ts` bans
`process.once` for teardown handlers — a `once` handler unregisters itself, so
a second Ctrl-C mid-teardown falls through to Node's default disposition and
kills the process. It enforced that ban across a **hardcoded two-file list**.
P2's inventory recorded it as a future hazard: "P4 moves the handler and it
silently stops covering it."

That was too optimistic. It had already stopped covering everything outside
those two files.

## Expected Outcome

The named seams extracted, the audits they unlock converted and deleted, and
the structural ones left structural. The `process.once` ban scans directories
rather than a list, so it cannot quietly lose coverage again.

**Unlike flow 277, this flow is not "zero production behaviour change."** It
contains exactly one deliberate behaviour fix, stated plainly rather than
folded into the counts: `src/commands/serve.ts:275` registered the banned
`process.once` pattern, so a second Ctrl-C while `keryx serve` was draining
killed it before `stopped` printed. It is now `process.on`, which the existing
idempotent `draining` guard already makes safe.

Everything else is behaviour-neutral: an `export`, an optional injected
dependency whose default reproduces the old behaviour, or code moved unchanged
behind a new function.

## Out of Scope

- The splits themselves: `src/tui/shell/` (P3) and `src/commands/shell/` (P4).
- An injection point for `launchTuiAgentShell`'s ~4,700-line closure. Most of
  what remains waits on it, and it is a flow of its own.
- `approval-wiring.test.ts`. Its seam has to reach into both god-files at
  once, which needs one owner rather than two working in parallel.
