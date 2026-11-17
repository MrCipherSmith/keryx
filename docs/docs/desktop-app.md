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

The minimum supported keryx is 0.4.32. An older keryx, or one without the
`shell` profile, is reported in the window instead of starting silently.

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
exactly what will run. Inside the dialog, Enter allows once and Esc denies;
when keryx offers it, the dialog also has allow or deny "for the rest of
this session". Keys typed in the
composer, and ⌘K, never answer an approval: only the dialog does.

When the agent asks you a question (`ask_user`), a picker with its options
appears; you can also type your own answer.

### Sessions

The session list holds this project's keryx sessions, the same store
`keryx shell` uses. ⌘N starts a new one (a running turn is stopped first);
picking an old one loads it. A session another `keryx shell` currently holds
cannot be opened at the same time; the app says so.

### Flows board

⌘2 opens the project's flows from `.metaproject/flows/`:

- one lane per status (Initializing, Ready, In progress, Implemented,
  Completing, Done; Done is collapsed); a blocked flow stays in its lane with a
  red badge;
- cards show tasks done/total, confirmed criteria, owner and PR;
- ⌘F searches by title or id; there is a board and a list view;
- a card opens the detail panel: Overview, Criteria, Tasks, Journal, Gates.

Actions in the detail panel run `keryx flow …` in the project: Start,
Block/Unblock, add a task, record a task attempt, mark a task done, freeze the
criteria (asks for confirmation) and show the next task. Commands with their
own gates (`complete`, `confirm`, `recover`, `implemented`, `ac update`,
`ac reseal`) are offered as "copy command" for a terminal.

**Work on this flow** switches to the session and fills the composer with a
prompt to continue that flow. Nothing is sent until you press Enter.

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
- **"this keryx has no shell profile"** — the selected keryx is older than
  0.4.32. Switch the source to Bundled or update the global install.
- **Something else** — the per-window log above holds keryx's stderr.

## Develop the app

Code is in `apps/desktop/` (Rust core in `src-tauri/`, React web view in
`src/`). `apps/desktop/README.md` covers the dev loop, the browser dev mode
(`bun run dev:browser`, no Tauri needed) and the checks.
