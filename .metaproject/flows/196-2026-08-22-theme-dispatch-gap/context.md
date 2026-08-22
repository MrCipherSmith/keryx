# Context

Collected deterministically by `keryx flow init` at 2026-08-22T11:00:45.636Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Source Issue

https://github.com/MrCipherSmith/keryx/issues/393

### agent-mode readline: /help advertises /theme but it has no dispatch branch — self-contradicting "Unknown command" (correction: /status and /flows are NOT affected, see comments)

## Summary

In `keryx shell --no-tui` (agent mode), `/help` advertises `/status`, `/flows`,
and `/theme` as available commands — but typing any of them produces
`Unknown command: /status. Type /help.` (or `/flows`, `/theme`), a
self-contradicting message: `/help` just claimed the command exists.

## Root cause (traced by code, not guessed)

`READLINE_AGENT_COMMANDS` (`src/commands/shell.ts:143-157`) — the array that
gates what `/help` *advertises* via `renderCommandHelp("agent",
READLINE_AGENT_COMMANDS)` — lists 13 names:

```ts
const READLINE_AGENT_COMMANDS: readonly string[] = [
  "/help", "/expand", "/search-provider", "/search-connect", "/new", "/goal",
  "/clear", "/compact", "/status", "/flows", "/theme", "/mode", "/exit",
];
```

But the actual agent-mode dispatch chain in `runAgentRepl` (the `else if
(command === "/…")` sequence, `shell.ts` offsets ~49149–58219) only handles
nine of them: `/exit`/`/quit`, `/help`, `/expand`, `/new`/`/clear`,
`/compact`, `/mode`, `/search-provider`, `/search-connect`, `/goal`. There is
no `command === "/status"` or `command === "/flows"` branch anywhere in that
chain, and the only `command === "/theme"` branch in the whole file
(`shell.ts:12517`) lives in the **separate chat-mode** dispatch chain, not
the agent-mode one.

Any command that reaches neither an explicit branch nor
`describeUnavailableCommand`'s wrong-*mode* fallback (which can't fire here —
`/status`/`/flows`/`/theme` are all registered `agent`-mode in
`src/commands/agent-commands.ts`, same as readline itself; that helper only
explains a chat-vs-agent mismatch, not a TUI-vs-readline one) falls to the
generic catch-all:

```ts
} else {
  agentIo.onSystem?.(
    describeUnavailableCommand(command, "agent") ??
      `Unknown command: ${command}. Type /help.\n`,
  );
}
```

## Repro

```console
$ keryx shell --no-tui --provider deepseek
❯ /help
Commands:
  /help             Show available commands
  ...
  /status           Show session identity, context, workspaces, and flows
  /flows            Browse project flows and inspect one
  /theme            Open the theme picker — /theme [name] applies immediately
  ...
❯ /status
Unknown command: /status. Type /help.
❯ /flows
Unknown command: /flows. Type /help.
❯ /theme
Unknown command: /theme. Type /help.
```

`/status` and `/flows` are genuinely useful, non-TUI-dependent information
(session identity/context/workspaces/flows, and a flow browser) — nothing
about either obviously requires a mouse or a modal the way `/workspace`,
`/review`, or `/mcp` legitimately do. `/theme` may be intentionally
TUI-only (readline has no color/box surface to theme), in which case the fix
is removing it from `READLINE_AGENT_COMMANDS` rather than implementing it —
but either way the current state is a broken promise from `/help`.

## Suggested direction (not prescriptive)

- For `/status` and `/flows`: add the missing `else if (command === "/status")`
  / `"/flows"` branches to the agent-mode chain, presumably reusing whatever
  the TUI's own `/status` and `/flows` handlers already call.
- For `/theme`: either give agent-mode readline a plain-text equivalent, or
  remove it from `READLINE_AGENT_COMMANDS` so `/help` stops promising it.
- Longer term: `READLINE_AGENT_COMMANDS` and the real dispatch chain are two
  hand-maintained lists that can silently drift (this is presumably how this
  happened) — a test asserting every name in `READLINE_AGENT_COMMANDS` has a
  live dispatch branch would catch a future regression of the same shape.

## Found via

A documentation-vs-code cross-reference pass building a formalized test
catalog for `keryx shell`/TUI — see
`docs/verification/keryx-shell-tui-test-catalog.md` on branch
`real-test-keryx`, rows SLASH-15/16/21.

## Environment

- `keryx 0.2.55` (npm `@mrciphersmith/keryx`)
- Surface: `keryx shell --no-tui` (readline), agent mode

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

_(flow-init skill appends here)_
