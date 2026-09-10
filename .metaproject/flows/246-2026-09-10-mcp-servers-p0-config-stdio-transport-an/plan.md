# Plan

## Order, and why this order

The plan's eight items, sequenced so each is verifiable when it lands rather
than at the end.

1. **Config** (`src/mcp-servers/config.ts`) — load, merge, disable overlay,
   `${VAR}` expansion, project walk cwd → git root. Pure, no I/O beyond
   reading files, so AC1 is checkable before anything connects.
2. **Generic stdio connection with `listTools`** — generalize
   `src/mcp-client/` WITHOUT touching the Codex specialist. Its function names
   stay; the generic path is new surface beside it. AC11's "Codex still green"
   is checked here, not at the end, because that is when it can still be
   cheaply true.
3. **Connection manager** — start enabled servers in the background, bounded
   concurrency. AC8's partial failure is a property of this step: one bad
   command must not take the session down.
4. **Catalog** — FQN, 64-char regex skip, in-memory map. AC3 needs the skip to
   be VISIBLE in doctor, so the skip reason is carried, not dropped.
5. **`search_tool` / `use_tool`** as `InteractiveTool`s. AC4 is the one to
   watch: the advertised definitions must gain the pair and none of the FQNs.
6. **Approval mapping** — AC7's three arms, with the headless fail-closed arm
   written first, because it is the one that turns a prompt into a bypass.
7. **CLI `list|add|remove|enable|disable`** — native JSON only.
8. **CLI `doctor [name]`** — config problems, connect result, tool count,
   skipped FQNs. HTTP fields wait for P1.

## Risk that decides how this is verified

The failure this package is most exposed to is the one the whole repository
keeps recording: a mechanism that reports what it did not establish. Three
concrete shapes here.

**A tool skipped silently.** A qualified name that fails the regex must appear
in `doctor` as skipped. Absent-and-unexplained is indistinguishable from
never-configured, and the operator debugs the wrong thing.

**An approval that does not ask.** Headless with `requestApproval` undefined
must fail CLOSED. A path that returns "approved" because nobody was there to
ask is not an approval mechanism.

**A stable list that is not stable.** AC4 is asserted against what the agent
ADVERTISES, not against the catalog. Those are different objects and only one
of them reaches the model.

## Verification stance

From source, always. `keryx` on PATH is a released build; this flow has
already been bitten once by that — the first attempt to create it recorded no
base branch because the installed 0.2.86 predated `--base`, and the failure
looked exactly like a bug in the new feature.

Live subprocess tests (AC2) are flag-gated behind
`KERYX_ALLOW_REAL_SUBPROCESS=1` and excluded from CI, matching the
`keryx-mcp-client` precedent. That gating is recorded in the criterion itself
so "not run in CI" cannot later read as "not required".

## Rejected

**Register every MCP tool on the model's tool list.** What OpenCode does, and
what this package explicitly refuses. The advertised surface would grow with
every server the operator adds and the model would pay for all of it every
turn. spec AC5 exists to make the refusal checkable.

**Reuse the Codex client directly rather than generalizing beside it.** The
Codex path carries an elicitation tap and `codex/event` handling that a user
server neither sends nor should receive. Sharing the transport is right;
sharing the specialist is how the specialist stops being verifiable.
