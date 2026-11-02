# Run Keryx in the Herdr app

Herdr is now a desktop app (`herdr-app`) on top of a terminal runtime,
herdr-core, whose CLI is `hc`. Keryx works with it in three ways:

- **Status.** A `keryx shell` running in an herdr-core terminal tells Herdr
  whether it is idle, working, done, failed or waiting for you.
- **The "+" menu and a template.** `keryx herdr install` adds Keryx to the app's
  agent menu and gives herdr-core a `keryx` template.
- **Delegation.** Another agent can start Keryx with a task and get the result
  back, and Keryx can hand work to other agents through `hc`.

Nothing here runs by itself. Status is reported only inside an herdr-core
terminal (`HC_TERMINAL_ID` set), and nothing is written to your Herdr config
until you run `keryx herdr install`.

The output below is from a run against an isolated herdr-core session
(`hc` 0.1.16) on macOS.

## Put Keryx in the "+" menu

Start the Herdr app once first: `install` writes into `~/.config/herdr-app` and
`~/.config/herdr-core`, and skips either one that does not exist rather than
create it.

```console
$ keryx herdr install
keryx herdr install

  programs  created    ~/.config/herdr-app/programs.json
  icon      created    ~/.config/herdr-app/keryx/keryx.svg
  template  created    ~/.config/herdr-core/templates/keryx.md
```

`programs.json` gets one entry, `programs.keryx`, and every other key in it is
kept. When the file already existed, its first change leaves
`programs.json.keryx-backup` beside it. An invalid `programs.json` stops the
command with a non-zero exit and is left byte-identical.

```json
{
  "programs": {
    "keryx": {
      "name": "Keryx",
      "icon": "keryx/keryx.svg",
      "tint": true,
      "run": ["keryx", "shell"]
    }
  }
}
```

A second run changes nothing and says so:

```console
$ keryx herdr install
keryx herdr install

  programs  unchanged  ~/.config/herdr-app/programs.json
  icon      unchanged  ~/.config/herdr-app/keryx/keryx.svg
  template  unchanged  ~/.config/herdr-core/templates/keryx.md

Already installed: nothing to change.
```

`keryx herdr status` reports each target as `installed`, `absent`, `modified` or
`skipped` and writes nothing. `keryx herdr remove` deletes only what still equals
Keryx's own copy. It never deletes `programs.json` itself, and a file you edited
is reported as `kept`:

```console
$ keryx herdr remove --dry-run
keryx herdr remove (dry run, nothing written)

  programs  removed    ~/.config/herdr-app/programs.json
            deleted programs.keryx; programs.json itself is kept
  icon      removed    ~/.config/herdr-app/keryx/keryx.svg
  template  removed    ~/.config/herdr-core/templates/keryx.md
```

Flags and the JSON shape are in the [CLI reference](../cli-reference.md#herdr).

## What Herdr sees

herdr-core reads a program's status only from an OSC 7501 sequence that the
program prints to its own terminal. `keryx shell` prints one each time its
state changes:

| In the shell | herdr-core status |
|---|---|
| The composer is ready to accept typed input. Never while a provider, model or resume picker is on screen. | `idle` |
| A turn is running. | `working` |
| A turn finished. | `done` |
| A turn failed. | `error` |
| An approval is waiting: a shell command, a patch, an MCP tool, a subagent or an external agent. | `blocked`, `kind=permission` |
| `ask_user` is waiting for an answer. | `blocked`, `kind=question` |
| The shell exited. | the status is removed |

A blocked status carries one line of text: the command, the task or the
question. It is collapsed to one line and passed through Keryx's secret
redaction, then cut to 200 characters. This is what `hc get` showed while a
shell command waited for approval:

```json
"status": {
  "app": "keryx",
  "kind": "permission",
  "msg": "hc get \"$HC_TERMINAL_ID\" --json 2>&1 | head -50",
  "state": "blocked"
}
```

`hc wait` and `hc send --wait` treat a turn as over when the status leaves
`working`. A parent waiting on a Keryx child therefore wakes up both when the
child finishes and when it needs a person.

The sequence goes through the full-screen renderer's own output, so it cannot
split a frame and leaves no stray text on screen. The line-based readline
shell (`--no-tui`) reports no status. Outside an herdr-core terminal the shell
prints nothing extra.

## Start Keryx with a task

The template is the usual way. herdr-core starts `keryx shell` and waits for
its first `idle`. It then types the template's text and the task as the first
message:

```console
$ hc run --bg --name k2 keryx "Reply with the single word READY and nothing else."
{"address":"t4","first_message":{"sent":true,"started":true,"turn":0},"name":"k2","state":"live","template":"keryx","turn":0}
$ hc wait k2
{"ended":true,"reason":"status","status":"done","terminal":"t4","turn":1}
```

The template's text tells Keryx to stay inside the task's scope, and to report
the result or a blocker with `hc send` when another agent assigned the task.

`keryx shell` also takes the task itself as one positional argument. It is
submitted as the first turn, and the session stays open afterwards:

```console
$ keryx shell "Fix the failing test in src/parser.test.ts"
```

!!! warning "The template shadows the program"
    Once the `keryx` template is installed, `hc run keryx …` always means the
    template, and the words after `keryx` become its task. `hc run keryx shell`
    ran the template with the task `shell`. To start the program itself with a
    prompt, give `hc` its path:
    `hc run --bg --name fix "$(command -v keryx)" shell "<task>"`.

## Messages from other agents

`hc` delivers a message between agents by typing it into the receiver's input:

- a child's report arrives as `<hc from="t7 review">…</hc>`;
- a parent's task arrives as `<hc from="t3 lead" reach="hc send t3 when done or stuck">…</hc>`.

When a submitted line is exactly one such block, Keryx does not treat it as
your words. The transcript labels it with the sender:

```text
│ ◂ t7 review ❯ All 12 tests pass. …
```

The model receives it with a header that names the sender and says the text is
another agent's output. With a `reach` attribute, the header says it is a task
from the parent and keeps the reply instruction verbatim. The session history
stores what the model received. Any other line, including one with text around
an `<hc>` block, reaches the model unchanged.

## Let Keryx delegate through hc

Inside an herdr-core terminal, the agent's instructions gain a short herdr-core
section, at most 1,500 characters and the same on every turn. It covers:

- the agent's own address (`HC_TERMINAL_ID`, for example `t7`);
- delegating with `hc run --bg --name <name> <agent> "<task>"`;
- collecting results with `hc wait --children` and `hc read`, never sleeping;
- reporting to a parent with `hc send`;
- `hc --skill` for the full manual.

Outside an herdr-core terminal the section is absent and the instructions are
byte-identical.

There is no dedicated `hc` tool. The agent runs `hc` through `shell_exec`, so
every call goes through your [approval mode](permission-modes.md) like any
other shell command.

## The sandbox caveat

With the interactive shell sandbox on (`KERYX_SANDBOX_SHELL`), a sandboxed
`shell_exec` has no network and cannot reach the herdr-core socket, so `hc`
fails there. The herdr-core section says so. Delegating through `hc` needs the
sandbox off for that session.

Keryx will not open the socket from inside the sandbox. Anyone who can connect
to the herdr-core socket can make it run any command with your rights, outside
any sandbox, so allowing it would be a complete escape.
[Run an agent without giving it my machine](contain-an-agent.md) covers the
containment model.

## Next to the old Herdr TUI

The terminal Herdr and the Herdr app are separate. They do not share agents,
and Keryx keeps both integrations:

- in an old Herdr pane (`HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`), the
  shell reports to the pane socket as before;
- in an herdr-core terminal (`HC_TERMINAL_ID`), it reports over OSC 7501.

Each reporter is inert in the other's environment.

## For an upstream Herdr app pull request

The Herdr app ships its built-in program table in `defaults/programs.json`, and
its icons in `icons/`. This entry and icon would make Keryx a built-in agent
without `keryx herdr install`. The `app=keryx` that Keryx reports already
matches the id, so no `match` is needed.

```json
"keryx": { "name": "Keryx", "icon": "icons/keryx.svg", "tint": true, "run": ["keryx", "shell"] }
```

`icons/keryx.svg` is a one-color glyph (`tint: true`):

```xml
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <line x1="7" y1="6" x2="17" y2="6" stroke="currentColor" stroke-width="1.6"/>
  <line x1="7" y1="6" x2="12" y2="18" stroke="currentColor" stroke-width="1.6"/>
  <line x1="17" y1="6" x2="12" y2="18" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="7" cy="6" r="2.1" fill="currentColor"/>
  <circle cx="17" cy="6" r="2.1" fill="currentColor"/>
  <circle cx="12" cy="18" r="2.1" fill="currentColor"/>
</svg>
```

Keryx does not send that pull request itself.
