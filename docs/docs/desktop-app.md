# Keryx for macOS (desktop app)

Keryx for macOS is a native window for the same agent session `keryx shell`
runs. It starts `keryx acp --profile shell` in the project folder you open and
draws the conversation, tool calls, approvals, the plan and token usage. The
agent, its policy, sandbox and session store stay inside keryx: the app is a
client.

Status: **preview (M1).** Apple silicon only, ad-hoc signed, not notarized,
no auto-update. Images, subagents, background tasks, rewind/compact and the
full slash-command set are not in the app yet; use `keryx shell` for those.
The design and its acceptance criteria are in
`docs/requirements/keryx-desktop-client/`.

## Install

### From a built `.dmg`

1. Open `Keryx_<version>_aarch64.dmg` and drag **Keryx** to **Applications**.
2. Start it from Applications or Spotlight.

The app is ad-hoc signed, not signed with a Developer ID. A `.dmg` you built
on the same Mac opens normally. One downloaded from the internet is
quarantined, and macOS refuses to open it ("Keryx is damaged" or "cannot be
verified"). Remove the quarantine flag once after copying it to Applications:

```bash
xattr -dr com.apple.quarantine /Applications/Keryx.app
```

### Build it yourself

Needs Bun, Rust (`rustup`, stable) and the Xcode command-line tools.

```bash
git clone https://github.com/MrCipherSmith/keryx.git && cd keryx
bun install
bun run desktop:build
```

`desktop:build` compiles keryx into a single binary, puts it inside the app
and runs `tauri build`. The results:

- `apps/desktop/src-tauri/target/release/bundle/macos/Keryx.app`
- `apps/desktop/src-tauri/target/release/bundle/dmg/Keryx_<version>_aarch64.dmg`

Releases tagged `desktop-v*` are built by `.github/workflows/desktop-release.yml`
into a universal `.dmg`; Developer ID signing and notarization switch on once
the `APPLE_*` secrets exist.

### Which keryx the app runs

**Settings → keryx** has three sources:

| Source | What runs |
|---|---|
| Bundled (default) | The keryx built into `Keryx.app/Contents/MacOS/keryx`. |
| PATH | The `keryx` on your login-shell `PATH`, for example a global npm install. |
| Custom path | Any executable, for example a wrapper that runs a development checkout. |

The app needs a keryx whose `initialize` answer reports the `shell` profile
with live sessions. 0.4.32 is only the protocol floor the app checks; the
released 0.4.32 to 0.4.35 have no shell profile, so they do not qualify. With
a keryx that does not qualify the start fails with a "This keryx is too old
for the app" dialog (use the bundled keryx or update) instead of starting
silently. The bundled keryx, the default source, always qualifies.

The app reads your login-shell environment once at startup, so `PATH` and the
provider API keys you export in `~/.zshrc` reach keryx even when the app is
started from Finder. Provider logins (`keryx auth login <provider>`) are the
same ones the CLI uses.

## Use

### Open a project

The welcome screen lists recent projects. **Open Folder…** (⌘O) picks
another one. The app starts keryx with that folder as the working directory,
so the project's `.metaproject/`, policy and session history apply exactly as
they do in `keryx shell`.

### Talk to the agent

- Type in the composer and press Enter to send (Shift+Enter for a new line).
  Settings can switch sending to ⌘Enter.
- `/` opens the list of commands the session offers.
- Esc while a turn runs stops it.
- The answer streams in. Reasoning is folded; tool calls show as compact rows
  you can expand for arguments and output.
- The toolbar above the composer switches the model and the permission mode.
- The plan the agent keeps and the session's token usage are shown alongside
  the conversation.

### Permission modes

The same three modes as `keryx shell`:

| Mode | Behaviour |
|---|---|
| ask | Asks before every shell command, file write and other gated call. |
| trust | Runs gated calls without asking, except destructive, credential-touching and other escalated ones. |
| auto | Runs every gated call without asking, except credential-touching ones; questions the agent would ask you are answered by the model, and the transcript says so. |

### Approvals

When the agent wants to run something that needs approval, a dialog shows
exactly what will run and why keryx asks (content from an untrusted source,
credentials, a destructive call, a publish lease, an agent launch, a hook, or
an always-ask rule; a routine ask shows no reason). Inside the dialog, Enter allows once and Esc denies;
when keryx offers it, the dialog also has allow or deny "for the rest of
this session". Keys typed in the
composer, and ⌘K, never answer an approval: only the dialog does.

When the agent asks you a question (`ask_user`), a picker with its options
appears; you can also type your own answer.

### Sessions

The session list holds this project's keryx sessions, the same store
`keryx shell` uses. ⌘N starts a new one; picking an old one loads it. A
session another `keryx shell` currently holds cannot be opened at the same
time; the app says so.

Sessions are live. One connection holds several at once, and opening or
creating a session releases nothing: turns, shell tasks (a dev server or
watcher) and MCP servers of the other sessions keep running. The app keeps
every held session's transcript and switches between them locally. Stop (Esc)
cancels only the turn of the session you are showing. A permission or
`ask_user` dialog from a session you are not showing queues on that session
and appears when you show it. The sidebar marks sessions that are busy or
waiting for your input.

keryx holds up to 8 sessions. Past that it releases the least recently used
idle one (no turn, no running shell task, no request in flight), which frees
it for `keryx shell --resume`, and tells the app. The app keeps that
session's last transcript read-only with a Reopen banner and reloads it,
with its permission mode and model, when you go back to it.

The list groups sessions by the day they were last active, newest first,
with a Pinned group on top. Click a group's name to fold it; the app
remembers folded groups. Each session's ⋯ menu pins or unpins it, archives
it, or moves it to the Trash. The Active / Archived switch above the list
shows one or the other. Pins and archives are stored by keryx next to the
session (`flags.json`), so they survive a reinstall. Move to Trash asks
first and moves the session's folder to the macOS Trash, where you can
restore it until the Trash is emptied; it is refused while the session has
a running turn or is open in another keryx. The ⋯ menu needs a keryx whose
shell profile lists `_keryx/session_flags` and `_keryx/session_trash` (the
bundled one does); with an older keryx the list has no menu and no Archived
view.

### Session info

The ⓘ button in the title bar opens a panel on the right with the shown
session's project and git branch (ahead/behind its upstream, changed
files), model, permission mode, keryx version, context use, and tokens for
the whole session, the latest turn and the last model call.

### Appearance

Settings → Appearance sets the theme, the interface font (System, Rounded,
Serif, Mono), the code font, the text size and the conversation width
(Narrow, Wide, Full).

### Flows board

⌘2 opens the project's flows from `.metaproject/flows/`:

- one lane per status (Initializing, Ready, In progress, Implemented,
  Completing, Done; Done is collapsed); a blocked flow stays in its lane with a
  red badge;
- cards show tasks done/total, confirmed criteria, owner and PR;
- ⌘F searches by title or id; there is a board and a list view;
- a card opens the detail panel: Overview, Criteria, Tasks, Journal, Gates.

Actions in the detail panel run `keryx flow …` in the project. The state
buttons sit together under the title in lifecycle order — Freeze criteria
(asks for confirmation), Start, Block/Unblock, Next task — and a button keryx
would refuse in the flow's current state is greyed out with a tooltip saying
why (Start stays off until the criteria are frozen); a line under them names
the next step. Adding a task, recording an attempt and marking a task done
are in the Tasks tab. Commands with their own gates (`complete`, `confirm`,
`recover`, `implemented`, `ac update`, `ac reseal`) are offered as "copy
command" for a terminal.

**Work on this flow** opens a new session linked to the flow and fills its
composer with a prompt to continue it; nothing is sent until you press
Enter. Once a flow has linked sessions, the button asks whether to continue
in one of them or start another new one, so you can create several flows in
one session and work on each in its own. The link is kept by keryx with the
session (`flags.json`).

The board refreshes when a `flow.json` changes (checked every 2 seconds) and
when the window gets focus.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘K | Command palette: commands, sessions, views |
| ⌘1 / ⌘2 | Session / Flows |
| ⌘, | Settings |
| ⌘N | New session |
| ⌘O | Open folder |
| ⌘F | Search flows (on the board) |
| Esc | Stop the running turn (in the composer) |

While a dialog is open the shortcuts are off.

## Where things are

| What | Path |
|---|---|
| App settings | `~/Library/Application Support/dev.keryx.desktop/settings.json` |
| keryx output per window | `~/Library/Logs/dev.keryx.desktop/keryx-acp-<window>.log` |
| Sessions | the keryx session store, shared with `keryx shell` |

## Troubleshooting

- **"cannot be opened" / "damaged"** — the app is quarantined; run the `xattr`
  command from [Install](#from-a-built-dmg).
- **The model call fails with an auth error** — the provider login expired or
  the key is missing. Run `keryx auth login <provider>` in a terminal, or
  export the key in your shell rc file and restart the app.
- **"This keryx is too old for the app"** — the selected keryx does not report
  the shell profile with live sessions (released 0.4.32 to 0.4.35 do not).
  Switch the source to Bundled or update the global install.
- **Something else** — the per-window log above holds keryx's stderr.

## Develop the app

Code is in `apps/desktop/` (Rust core in `src-tauri/`, React web view in
`src/`). `apps/desktop/README.md` covers the dev loop, the browser dev mode
(`bun run dev:browser`, no Tauri needed) and the checks.
