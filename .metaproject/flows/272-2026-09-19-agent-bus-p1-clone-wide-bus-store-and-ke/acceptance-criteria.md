# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `gitCommonDir` and `gitToplevel` are exported from src/lib/clone-scope.ts and src/flow/allocation.ts imports them; every pre-existing test in src/flow/allocation.test.ts passes unmodified.
- AC2: `resolveBusRoot(cwd)` returns `<git-common-dir>/keryx/bus/<key>` with the key derived from `resolveProjectRoot(cwd)` relative to the git toplevel; a subdirectory cwd and a linked worktree of the same clone resolve to the same root, and a non-git directory resolves to the data-dir fallback; proven by tests with a real temp repo and `git worktree add`.
- AC3: Presence, event and pause-lease records are schema-validated on write and on read; a non-UUID instanceId or leaseId is refused before any filesystem path is built; a torn line, an invalid record or an unknown schemaVersion is skipped by readers without throwing; the names all, cli and system are refused; proven by tests.
- AC4: Eight concurrent processes appending 100 events each produce 800 events with unique, gap-free seq and no torn lines, and a writer killed between the line append and the head.json update causes no duplicate seq; proven by a multi-process test.
- AC5: The log rotates at 1 MiB, keeps at most two rotated segments, deletes rotated segments older than 7 days, and a cursor whose offset is beyond the new segment's size at rotation reads every event exactly once; proven by tests.
- AC6: Presence records are written atomically with mode 0600 in 0700 directories and classified live, stale or gone per D-09 with an injected clock, pid probe and host; name allocation yields agent-<n> by default and <name>-2 when a live instance holds the name; proven by tests.
- AC7: `keryx bus send` accepts notice, question, handoff and reply (reply requires --reply-to), resolves @name only to live instances (refusing unknown-recipient and recipient-not-live), writes @all as ["*"], writes from.name cli with origin cli and a fresh instanceId, stores the body redacted, refuses body-too-large above 2048 bytes and refuses rate-limited beyond 30 CLI messages per minute per clone; proven by tests.
- AC8: `KERYX_TOOL_CALL=1` is present in the environment built by `resolveShellEnv` and absent from external-agent and MCP child environments; `keryx bus send` refuses with use-agent-tool when it is set, `keryx bus list`, `log` and `prune` still work, and a caller with `KERYX_SESSION_PROVIDER`/`KERYX_SESSION_MODEL` but no marker is not refused; proven by tests.
- AC9: `keryx bus list` shows live and stale peers with name, status, activity, checkout and branch plus active pause leases, `keryx bus log` supports --since, --limit and --json, and two linked worktrees of one clone list each other's presence; proven by tests.
- AC10: The enablement resolver reports disabled with a named reason for KERYX_BUS=off, shell config bus.enabled false and a CI environment; `keryx bus send` and `prune` refuse bus-disabled with that reason while `list` and `log` still read; KERYX_BUS_POLL_MS is clamped to 250-10000; proven by tests.
- AC11: `keryx bus prune` removes presence records gone for more than 24 hours, inactive pause leases and rotated segments beyond the retention bound, and leaves live and stale records alone; proven by tests.
- AC12: Nothing in src/bus or src/commands/bus.ts writes under .metaproject/flows or imports a flow-state writer; proven by a test or source audit.
- AC13: bus list, log, send and prune are registered in src/cli.ts, the help text and src/standard/command-registry.ts, documented in a `## bus` section and the top-level table of docs/docs/cli-reference.md, and the registry and cli-reference coverage tests pass.
- AC14: typecheck, lint and the full test suite are green in CI on the PR head.
- AC15: The keryx-agent-bus package README, implementation-plan.md and the roadmap row state P0 and P1 as implemented with flow and PR references, and P2 to P5 as not implemented.
