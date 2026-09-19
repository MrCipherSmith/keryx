# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: After its session lease is taken, every interactive surface (TUI agent, TUI chat, readline chat, readline agent) calls joinBus, which allocates a name from --name, then bus.name, then agent-<n> per D-06, writes a presence record with every spec §4.1 field, sets the log cursor to the current end, and prints one "bus: joined as @<name> · <n> peers" line; proven by tests.
- AC2: An unref'd heartbeat every 5 s rewrites presence (status, activity, branch, heartbeatAt) and patches the session lease owner name, and an unref'd poller at busPollMs reads new events; both stop on leave; proven by tests with injected timers and clock.
- AC3: Each event addressed to this instance (its instanceId, or * when not sent by itself) produces exactly one operator line "⇄ @from kind: preview" with the preview passed through displaySafe, including while the agent is busy; events are not pushed into agent history in this phase; proven by tests.
- AC4: /bus works in the TUI (modal with Peers, Leases and Log tabs) and readline, supports send (and the @name shorthand), ask, reply <id> and name <new> with D-06 uniqueness, sends with origin operator and from set to this instance, and is dispatched while busy via a bus target in classifyBusyDispatch; proven by tests.
- AC5: The fleet sidebar shows a Peers group below the local workers listing live and stale peers with name, status and activity, refreshed on every poll; proven by tests.
- AC6: Presence is removed on TUI /exit, the menu exit, Ctrl+C (onDestroy) and the outer finally, and on readline /exit, SIGINT and SIGTERM; after SIGKILL the record reads gone once the stale window passes, and after SIGSTOP it reads stale; proven by tests including a subprocess test.
- AC7: Two readline shells started in two linked worktrees of one clone each list the other in `keryx bus list --json`, and a `/bus send @<other>` from one produces the operator line in the other; proven by a subprocess test.
- AC8: presence.sessionId follows every in-process session switch (/new, /resume and the TUI startup picker); proven by tests.
- AC9: With KERYX_BUS=off, shell config bus.enabled false, or a CI environment, the shell prints one line with the reason, writes no presence, starts no bus timers and otherwise behaves exactly as before; proven by tests.
- AC10: No child process environment (shell_exec, MCP server, external agent) contains the bus instance id or name; proven by a test.
- AC11: `keryx shell --name <name>` is validated (reserved names all, cli, system and names outside the D-06 pattern are refused with exit 2) and documented in `keryx shell --help` and docs/docs/cli-reference.md; proven by tests.
- AC12: typecheck, lint and the full test suite are green in CI on the PR head.
- AC13: The keryx-agent-bus package README, implementation-plan.md and the roadmap row state P0–P2 implemented with flow and PR references and P3–P5 not implemented.
