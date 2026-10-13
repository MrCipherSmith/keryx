# Choose an approval mode: ask, trust, auto

`keryx shell` (both the OpenTUI surface and the `--no-tui` readline fallback)
has three permission modes that decide whether a mutating tool call
(`shell_exec`, `spawn_subagent`, or any tool declaring risk `destructive`)
stops to ask you first. This page is the full reference: what each mode does,
how to set it, and exactly where every piece of state lives on disk. It also
covers the separate, orthogonal read-only `/plan` toggle, further down, for
when nothing should be reachable at all.

!!! note "Not the same thing as the policy engine"
    This is a session-level convenience layer for the interactive shell. It is
    a **different mechanism** from [the policy engine](../harness.md#the-policy-engine-three-answers-not-two)
    that governs `keryx harness run`/`keryx harness exec`/`keryx serve` —
    those keep their existing `allow`/`ask`/`deny` behavior untouched,
    including "headless never silently allows." Permission modes never
    weaken that. See [Scope](#scope) below.

## The three modes

| Mode | What happens |
|---|---|
| `ask` (default) | Every `shell_exec`, `spawn_subagent`, and destructive-risk tool call asks first — today's behavior, unchanged if you never touch this feature. |
| `trust` | Safe calls run without asking. A call still asks when it is destructive — either the tool's own static risk, or a command keryx's classifier recognizes as destructive (`rm -rf`, force-push, and similar). |
| `auto` | Commands do not ask, **including destructive ones**, apart from the hard floors below (credentials, SAC review confirmation, publish lease) and the question floors in [Who answers a question](#who-answers-a-question) — the same shape as Claude Code's `--dangerously-skip-permissions` or the informal "yolo mode" other CLIs offer. Entering it always requires an explicit one-time confirmation first. |

One thing no mode ever changes: a command that touches keryx's own
credential/permission files (`auth.json`, `permissions.json`,
`.local/share/keryx`, `.config/keryx` appearing anywhere in the command) is
**never** auto-approved, in any mode, including `auto`. That floor exists so
a compromised or confused turn cannot use `auto` mode to grant itself new
authority.

## Round limit per turn

The mode also decides how many model rounds one turn may run before it stops.
A round is one request to the model and may carry several tool calls.

| Mode | Rounds per turn | At the limit |
|---|---|---|
| `ask` | 40 | Asks "Increase limit and continue / Cancel"; a yes grants 40 more. |
| `trust` | 200 | Asks the same question; a yes grants 200 more. |
| `auto` | 200 | Never asks to extend the limit. Below 200 the turn extends itself and prints a `[budget]` line; at 200 it stops with a `[budget]` message. |
| automatic review (any mode) | 200 | Same as `auto`; see [Automatic review](#automatic-review). |

`KERYX_AGENT_MAX_ROUNDS` wins in every mode, and 200 is the ceiling: a larger
value is clamped to 200. In `auto` the variable can lower the limit, not raise
it; a turn then extends itself in steps of that value up to 200. The mode is
read at the start of each turn, so `/mode auto`, `/mode trust` and `/mode ask`
change the limit of the next turn without a restart. `/mode` and the `/mode`
picker show the limit of each mode.

Subagents keep their own limit (10 by default, at most 24 for a `max_rounds`
request) in every mode. They never ask a person at their limit, so there is no
question to remove.

## Who answers a question

The mode also decides who answers an `ask_user` question the model raises.
`trust` is a statement about actions ("do not interrupt me for a command I would
have approved"), not about judgement, so it does not change this.

| Mode | Who answers |
|---|---|
| `ask` | You. |
| `trust` | You. |
| `auto` | The model picks the recommended option, or the first one, and says so. |

In `auto` the model is told `[auto mode] chose this without asking the user`, so
it cannot present the choice as yours, and the shell prints a
`◇ answered without asking (auto):` line with the question and the chosen
label. Such a question uses no tool-call budget and is not remembered as an answer
of yours. It is not an invocation, so the tool-call budget is untouched and no hook is
consulted for it; the default cap of 3 identical calls still applies. It is not written to the
recommendation journal either, because no person answered it. An automatic review does
not use this path: its own rules decide what is answered and what goes to a person.

The question still goes to you when it decides an irreversible action
(`irreversible` or `action`), when the turn holds untrusted external content, when
the turn started in Telegram, including a `/goal` sent from there (the buttons appear in
the topic, as before), when review-auto is on, `KERYX_REVIEW_AUTO_ANSWER=1` is set or an
autonomous answers file is set and the question carries a `policy` tag, or when it asks for
permission after you refused an action in any mode since the last mode change, `/new`,
`/clear` or resume. "Asks for permission" is decided
by the question's wording, so this is a floor for questions phrased that way, not a
guarantee against a differently worded one. An unattended run stops at a question as
before.

A session with no way to show a question (no dock, no host) tells the model
"No one was asked" instead of "User cancelled the question (Esc)", so it does not
report a cancellation nobody made.

## Automatic review

An automatic review is a **run mode of one turn**, separate from the permission
mode: it works the same in `ask`, `trust` and `auto`. It starts when the
operator asks for one in the request ("run an automatic review of PR 12",
"автоматическое ревью") and creates its package with `--automatic`
(`keryx review start|attach|ingest --automatic`, recorded as
`manifest.automatic: true`). A line that did not come from the operator (a
task notification, a bus message, a trigger run) never starts one, and an
unattended trigger runner keeps the 40-round limit.

While a turn belongs to an automatic review:

- **Round limit 200, no question.** Reaching the limit extends the turn
  without asking; at 200 it stops with the same `[budget]` message as `auto`.
  The mark does not carry over to a turn that does not mention an automatic
  review.
- **The review's own commands run without a prompt, for that package only.**
  These `keryx review` commands, written as plain words with no pipe, `;`,
  `&&`, redirect or substitution, are approved:
  `start`, `attach` and `ingest` with `--automatic` (once per run);
  `status <this review>` and `complete <this review>`;
  `ledger build <dir> --package <this review>`, `severity-audit`,
  `context-collect`, `compare-reference` and `mutate --test "bun test …"`, each
  with `--package <this review>`; `retry-plan --manifest <this review>/…`;
  and `scope` and `blast-radius`, which write only inside the package. An
  `apply_patch` is approved when every target is inside the package directory
  (`.metaproject/reviews/<id>/`). A command that names another review or path,
  or any other `keryx review` subcommand, is asked as usual. The hard floors
  (destructive commands, credential files, content from an untrusted origin,
  a hook that asked, a publish lease, read-only mode) are never lowered.
- **Questions are answered with their default.** An `ask_user` call gets its
  recommended option, or the first one, and the answer is counted. A question
  that decides an irreversible action (`irreversible`/`action`) or carries a
  review `policy` tag is not defaulted: it goes on to the host (the review
  arbiter or the operator), and is counted as manual.
- **It stops to ask only in an emergency**, a closed list:
  1. a command outside the review's package or outside the review commands;
  2. a destructive action;
  3. a provider authentication failure;
  4. a gate refusal that needs the operator's quote (a waiver);
  5. a decision on a reduced reviewer set;
  6. a provider error after the retries.

  Cases 3 and 6 end the turn with the error instead of a question. Cases 4 and
  5 reach the operator only after `review complete` has actually refused: an
  earlier claim is answered with the default.
- **No gate bypass.** `review complete` and its refusals are unchanged. This
  mode removes prompts, not checks.
- **A disclosure counter.** The turn ends with a count of inputs the operator
  gave by hand against inputs the shell answered itself, in
  `automatic-run-inputs.json` inside the package and as one line in the
  session. Flow 419 reads it.

The sidebar Mode row shows `· automatic review` while such a turn runs, and
`/mode` prints the same rule and the emergency list.

## Trusting one MCP tool for the session

An MCP tool called through `use_tool` always counts as destructive, so it asks
even under `trust`. In `trust` mode the prompt therefore also offers `T` (the
TUI dock: "Trust this tool (this session)") next to approve and deny. It skips
future prompts for that **exact** tool name, for this interactive session only —
never a wildcard, never a whole server, and never written to disk. The model
cannot add to it, and `/new`, `/clear` and resuming a session clear it.

Three rules keep the grant from becoming a way around the approval gate:

- **Bound to the tool's definition.** The grant remembers a fingerprint of the
  tool's name, description and input schema as the server reported them when you
  said yes. If a later call finds a different definition (or the tool is gone),
  the grant is dropped and the call asks again.
- **Not offered, and not honoured, next to untrusted content.** When the turn
  already holds external content (a web result or any MCP tool result, including
  one from the trusted tool itself), the call asks even for a trusted tool, and
  the prompt does not offer `T` — it says why instead. The grant applies again
  from the next turn.
- **Never offered for a tool its server marks destructive.** If the tool's
  catalog entry says `destructiveHint: true`, `T` is not offered (dock and
  prompt alike) and the prompt says why. The check reads the live catalog on
  every call, so a grant made while the tool looked harmless is dropped, and the
  call asks again, once the server starts reporting `destructiveHint: true`. A
  tool with **no** annotation, or `destructiveHint: false`, is treated as it
  always was and is still offered `T`. The hint is advisory and comes from the
  server, and the MCP default for a missing hint is "destructive", which would
  withhold trust from nearly every server; keryx only acts on an explicit `true`.

### Seeing and revoking grants

A tool that holds a grant carries a `[trusted]` marker: on its approval lines
(when it still has to ask, for example next to untrusted content), on the line
printed when it runs without asking, in the `/mcp` server view (a per-server
count), and in the list below.

```text
/mcp trust list                    # every trusted tool, by full name and server
/mcp trust revoke <server__tool>   # revoke one; it asks again on its next call
/mcp trust revoke all              # revoke everything
```

`list` shows `(will ask again: changed | destructive | gone)` instead of `[trusted]`
for a grant the next call would not honour: the definition changed, the tool now
reports `destructiveHint: true`, or it left the catalog.

Revoke takes the full `server__tool` name exactly as `list` prints it. An
unknown name is reported and changes nothing. These work while the agent is
busy, and in the readline shell as well as the TUI.

## Setting the mode

**One-shot, from the command line:**

```bash
keryx shell --trust                       # or --ask / --auto
keryx shell --permission-mode trust       # equivalent, explicit form
```

**Inside a running session**, the `/mode` command works the same way in both
the TUI and `--no-tui`:

```text
/mode                 # show the current mode (TUI: opens a picker)
/mode trust            # switch for this session only
/mode trust save       # switch AND remember it as this project's default
/mode clear             # forget the stored project default
```

Switching to `auto` always stops for an explicit confirmation first —
typing `yes` in the readline shell, or a Confirm/Cancel choice in the TUI.
There is no flag or setting that skips that confirmation; the mode can only
ever be changed by you, directly, in the running session. Nothing a tool or
the model outputs can set it — that is a deliberate boundary, not an
oversight.

## Review system

The review system decides who answers the approval questions of a review run. By
default it **inherits** the permission mode: in `trust` it asks you only now and then,
for example when a reviewer is about to be spawned after the agent has read external
content (the page the agent read cannot approve that call; you do).

Switch it to `review-auto` and the shell answers those questions itself:

```bash
keryx shell --trust --review-system review-auto
```

or say it in the session: "сделай автоматическое ревью", "run an automatic review" or
mention `review-auto`. Only your own line counts; a subagent's task text and a message
from a peer or a tool result never switch it on. `KERYX_REVIEW_SYSTEM=review-auto` does
the same for an unattended shell, and `ask_user` menus take their recommended option.

What `review-auto` still asks you about: destructive commands, credential access,
publish leases, calls a hook tightened to "ask", and any call other than a reviewer
spawn or a routine command (below) that follows untrusted external content. Each
automatic answer is recorded in the transcript like any other auto-approval.

A refusal sticks. When you deny a call, `review-auto` remembers it for the rest of the
shell. The same call, in any spelling that normalizes to the same fingerprint
(`keryx  harness wave --spec x` and `keryx harness wave --spec=x`), is not shown again:
the agent gets "refused earlier: choose another path" and no modal opens. An `ask_user`
menu that asks for permission (allow, deny, consent, access, "разрешить", "запретить")
is no longer answered with its recommended option. It reaches you instead, and the
transcript says so. An irreversible question was never auto-answered. `/clear`, `/new`,
resuming a session and changing the permission mode clear the memory. The per-call memory
is scoped to `review-auto`; under `inherit` a denied call is asked again. Only the
permission-question floor above is kept after a refusal in every mode (until the next mode
change, `/new`, `/clear` or resume), and only a person's "no" counts: an unattended run, a
superseded turn or an interrupted one does not.

### Routine commands: no prompt after untrusted content

In `trust` and in `review-auto`, the commands below run without a prompt even after a
web or MCP result entered the turn. They are read-only or local and write nothing
outside the working tree. This table is the single list; the code reads it from
`src/lib/trust-routine-command.ts`.

| Command | Notes |
|---|---|
| `keryx help` | |
| `keryx <command> --help` | up to four words, no other flags |
| `keryx harness list`, `status`, `--help` | |
| `keryx agents external list --no-probe` | only with `--no-probe` |
| `keryx review attach`, `start`, `scope`, `slice`, `dispatch-check`, `retry-plan`, `ledger`, `floor`, `blast-radius`, `budget`, `tier`, `status`, `reviewers`, `required`, `ingest`, `complete` | |
| `keryx flow status`, `list`, `check`, `next` | |
| `keryx gdgraph find`, `context`, `affected`, `cycles`, `orphans` | |
| `keryx ctx rg`, `read`, `diff` | |
| `slate_note`, `slate_trail` (tools) | the session's own notes |

`bun test` is routine only while all of these hold, because a test run executes project
code: no untrusted content has entered the turn; the command runs in the project root,
judged after following the chain's `cd`s (a `cd` whose target cannot be known makes it
ask: an option, `-`, a target the shell may expand, a relative name while `CDPATH` is set,
or a directory reached through a symlink); its arguments are only `--bail`, `--only`, `--todo`, `--rerun-each N`
and `--timeout N` with a plain non-negative integer; and the project's `bunfig.toml` is
byte-for-byte the file the process saw at its first turn for that project, with no
`preload` anywhere in it. The baseline is per process and first-wins: a later session in
the same process, on the same project, is judged against the file as the first one saw
it, not as it is now. A `bunfig.toml` that appears, changes, cannot be read (it is not a
regular file, or is over 256 KiB) or does not parse makes `bun test` ask again.

The path flags of `keryx review slice` (`--diff`, `--out`), `retry-plan` (`--manifest`,
`--result`, `--state`) and `dispatch-check` (`--manifest`, `--payload`) are routine only
when they land inside the project root by their real path, symlinks resolved. `-` is
standard input for `--diff`, `--payload` and `--result` only. The command refuses an
outside path itself, too, and opens the path it judged.

A command outside the table still asks. So does a command that chains with `;`, pipes
to a command that is not listed, redirects outside the working tree, or uses a
subshell, `$(…)` or backticks: every segment has to be in the table. The hard floors
are not lifted by the table: destructive commands, credential access, human
confirmation (`flow confirm`, SAC review, scheduler control), publish leases and a
hook that says "ask".

### Why am I being asked?

Every approval modal, the readline prompt and the Telegram relay carry one line that
names the cause, from a closed set:

| Cause | Line |
|---|---|
| `destructive` | why: destructive command — no mode lifts this |
| `credentials` | why: touches credentials or needs your confirmation — no mode lifts this |
| `publish` | why: a git-publish lease applies — no mode lifts this |
| `hook-ask` | why: a policy hook asked about this call |
| `untrusted-content` | why: this turn holds untrusted external content |
| `not-in-routine-list` | why: untrusted external content in this turn, and the command is not in the routine list |
| `mode-ask` | why: the permission mode asks before this call |

## Long runs in the shell

A review of a large pull request is hundreds of tool calls. The shell is built to
carry one to the end without you typing anything after the task.

- **Round limit.** A turn may use 40 tool rounds in `ask` and `auto`, and **200 in
  `trust`**. The limit follows the mode in force when the turn starts, so `/mode
  trust` takes effect on the next turn. `KERYX_AGENT_MAX_ROUNDS` still overrides
  both. When the limit is hit, the "reset" choice adds the limit of the current mode.
- **No prompt for routine commands.** In `trust` and `review-auto`, a short `&&` chain
  of `cd`, the commands in the [routine table](#routine-commands-no-prompt-after-untrusted-content),
  `keryx ctx run --`, read-only `git` subcommands and `bun test` runs without asking,
  even after the turn has read untrusted content (web or MCP results), except `bun test`,
  which is routine only under the conditions in the
  [routine table](#routine-commands-no-prompt-after-untrusted-content). Destructive
  commands, credential access, SAC and publish gates, and every other command still ask.
- **Open plans do not end the turn.** In `trust`, a turn that would end with open
  plan items continues on its own, at most 8 times in a row, and stops earlier when
  the model makes no progress.
- **Answers are kept.** What you answer to a question the agent asks (counterpart,
  model plan, budget, scope) is stored in the session slate, so it is not asked again
  after compaction or in a later turn. Questions marked irreversible are always asked.
- **Waves of 10.** Up to 10 subagents run at once, each with a round budget of 40
  (at most 200 per subagent).
- **Slash commands are queued, not dropped.** A command typed while a turn runs is
  shown as `queued as qN` and runs when the turn ends; `/queue` lists, edits and
  removes. Each queued message shows its state and why it waits — "waits for the
  current turn", or "waits for approval of: <call>" when an approval modal is open —
  in the panel and in `/queue`, and one line explains `[Force]`: it interrupts the
  current turn and runs the message now. `/new`, `/clear` and `/resume` are refused while busy, because running
  them later would swap the session under the questions queued behind them.
- **Ctrl+C cancels the turn.** During a turn, one Ctrl+C cancels it and returns to the
  prompt. At an idle prompt, the first Ctrl+C shows a hint and a second one within 2
  seconds exits; `/exit` always exits. Exiting a shell started with
  `/remote-control` ends its Telegram topic.

For the review side (`keryx review slice`, `dispatch-check`, `retry-plan`,
`ledger`, `keryx ctx run --raw`) see the [CLI reference](../cli-reference.md).

## Read-only mode: `/plan`

`readOnly` is a separate, **orthogonal** toggle — not a fourth mode. Where
`ask`/`trust`/`auto` decide *how much confirmation* a mutating call needs,
`readOnly` decides *whether mutating tools are reachable at all*. The two
combine freely: `trust` + `readOnly` still confirms nothing extra, but every
non-read action is refused outright regardless.

```text
/plan                  # show the current state (TUI: opens a picker)
/plan on               # deny every non-read tool call for this session
/plan off              # back to whatever the current mode allows
```

When `readOnly` is on, a denied call gets an immediate refusal — never a
confirmation prompt, and never auto-approved, even under `auto`. It is a hard
floor: no mode lifts it.

**Scope of what "read" means today.** `shell_exec` is denied entirely under
`readOnly` — there is no per-command allowlist (`git diff`/`git log`/`git
status` are unavailable through the agent while it is on). The agent still
has `read_file`, `list_dir`, `get_cwd`, and `search_code`. This is a
deliberate v1 scope, not an oversight — a read-only git surface may follow if
it proves painful in practice.

**Not persisted.** Unlike the mode's `save` flag, `readOnly` is always
in-memory, always starts `false` on a new session. There is no
`/plan on save` and no config file for it.

## Where it's stored

| What | Where | Notes |
|---|---|---|
| The mode for the *current* session | In memory only | Set from the CLI flag, or the project default below, or `ask` if neither is set. `/mode` changes it live; nothing is written to disk unless you use `save`. |
| Your project's remembered default | `permission-mode.json`, in the shared keryx config directory (see below) | Written only by `/mode <mode> save` or `/mode clear` — never automatically. |
| The shared keryx config directory | macOS/Linux: `~/.local/share/keryx/` (or `$XDG_DATA_HOME/keryx` if set) · Windows: `%APPDATA%\keryx\` | The same directory that already holds `auth.json` (provider credentials) and `projects.json` (the project registry). One file per machine, keyed internally by each project's resolved path — not one file per project. |

`permission-mode.json` looks like this (path examples shortened):

```json
{
  "schemaVersion": 1,
  "projects": {
    "/Users/you/code/api-server": "trust",
    "/Users/you/code/scratch-experiments": "auto"
  }
}
```

The key is the project's *resolved* real path (symlinks followed), so the
same project reached through two different symlinked paths still shares one
entry. You will not normally edit this file by hand — use `/mode <mode> save`
and `/mode clear` — but it is plain JSON if you ever need to check or fix it
directly.

## What you'll see when something is auto-approved

Whenever `trust` or `auto` lets a call through without asking, the shell
prints a line for it anyway — never silently:

```text
◇ auto-approved (trust) git status
◇ auto-approved (auto) [destructive] rm -rf ./build
```

That line is intentionally **not** dimmed, unlike the ordinary "remembered
shell pattern" auto-approve line you may already know from answering
`[y/N/A=always]` — this one was never approved action-by-action, only the
mode itself was chosen once, so it stays visible enough that you would
actually notice it scroll by.

## Scope

Permission modes apply to the interactive `keryx shell` session only:

- **`keryx harness run` / `keryx harness exec` / `keryx serve`** keep using
  the formal policy-profile engine described in
  [the harness page](../harness.md#the-policy-engine-three-answers-not-two)
  — completely unaffected by this feature.
- **The MCP server** (`keryx mcp`) does not consult permission modes at all;
  an inbound MCP tool call from another agent is a separate code path.
- **No remote or headless caller can set `trust`/`auto` for you.** The mode
  is local, in-session, human-set state.

## See also

- [The agent harness](../harness.md) — the policy engine these modes sit above.
- [Run an agent without giving it your machine](contain-an-agent.md) — the OS
  sandbox, an independent containment layer: it bounds *what* a command can
  touch regardless of whether it was asked about.
- [Review a pull request with nobody at the keyboard](autonomous-review.md) — the
  `review-autonomous` profile: `trust` mode under `review-auto`, with every question answered
  by a recorded safe default.
