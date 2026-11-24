# Keryx for macOS (desktop app)

Keryx for macOS is a native window for the same agent session `keryx shell`
runs. It starts `keryx acp --profile shell` in the project folder you open and
draws the conversation, tool calls, approvals, the plan and token usage. The
agent, its policy, sandbox and session store stay inside keryx: the app is a
client.

Status: **preview.** Ad-hoc signed, not notarized. Updates come
through the keryx CLI (`keryx app update`, or the app's update banner), not a
built-in updater. The app runs the shell's slash commands, subagents and
background tasks; anything it does not draw yet still works in `keryx shell`.
The design and its acceptance criteria are in
`docs/requirements/keryx-desktop-client/`.

## Use Desktop from Telegram

In the Desktop Telegram preview, **Settings → Integrations → Telegram** starts
the local service and connects a bot. Share individual sessions from the
**Telegram session** button in their header. See the
[illustrated setup guide](guides/desktop-telegram.md) and
[Desktop Telegram module](desktop-telegram-module.md).

## Configure model routing

In **Sessions**, run `/routing` to open the model routing dialog. Use **Add
model** to choose a connected provider and a model for **Strong**, **Middle**,
or **Light**. Each tier can contain multiple models, listed in preference
order. Turn on **Use model tiers for tasks without an explicit routing rule**
to apply the pools. Turn it off to keep the lists for later. Save to
apply your defaults across projects. Approved project
settings take precedence. An empty tier uses the session model unless the
project has its own routing settings for that operation. Use `/routing status`
to inspect project routing and review any pending approval.

Subagents use the requested tier and default to Middle. Review orchestrator
launches use the saved tier lists when the run does not supply its own
models. The coordinator still follows the selected session model or a
trusted project override. Existing personal model assignments are offered
in the dialog as starting values when no class is configured. Existing personal
routing overrides keep their priority unless you select **Replace previous
personal routing overrides with these tiers** when saving.
If an earlier Keryx release activated your routing settings for this project
only, the dialog shows the migration command. Global saving becomes available
after you explicitly adopt or replace those settings.

## Set up GitHub for a project

1. Open **Settings → Integrations**, then select **Connect account** under
   **GitHub**. Follow the GitHub sign-in prompt. Repeat for each account you
   want to use. **Refresh accounts** reloads the list from GitHub CLI.
2. Open a project with a GitHub.com remote. Choose an account with access to
   its repository when prompted. You can change the selection or disconnect
   in **Project Settings** from the project menu.
3. In **Sessions**, the main header displays the project account as
   **GitHub · @login**. Select it to open **Project Settings**. The
   **Activity** icon in the same header opens the side panel with subagents
   and background tasks. The badge on the icon shows how many are running.

The selection is local to the project and shared by its Git worktrees. Use
different accounts for different projects without switching the active
GitHub CLI account. Review and the PR watcher use the project selection.
On a project with no saved selection, Review can still use the active
`gh` account. Choosing **Disconnect from project** turns off that fallback.
A GitHub login does not change the model provider or Git commit author.

If Desktop reports that the selected CLI does not support GitHub accounts,
choose **Settings → Desktop → Bundled keryx**, then retry.

## Find a pull request

Select a project in the left sidebar, then choose **Pull requests** in its navigation (**Sessions**, **Flows**, **Reviews**, **Pull requests**, **Issues**, **Metaproject**). Switching sections preserves the session draft. **Settings** at the bottom of the sidebar opens app-wide preferences. Pull requests starts
with all open pull requests, including drafts and contributions from forks.
When the project has several GitHub.com remotes, select the base repository
whose pull requests you want to see.

Search by number or title and combine author, assignee, requested reviewer
(person or team), review decision, PR state and CI. For example, select your
team under requested reviewers and **CI passed** to find PRs ready for your
team to inspect. Board and list use the same filters. Use the state filter
to include merged or closed PRs.

Open a card to read discussion, submitted reviews, inline replies and checks
for its head commit. Follow a link to continue the conversation on GitHub.
Use **Refresh** to read the latest data. The view identifies partial results
and shows the time of the last successful read when an update fails.

The board's columns follow the GitHub state of the pull request only. Keryx
work is shown on each card, list row and PR panel in a work row:

- **Flow.** **Flow #N · stage** opens the Flow linked to the pull request.
  Without one, the slot reads **Create Flow**: it opens the PR's session with
  an unsent prompt to create a Flow for this pull request. When a new Flow
  package appears within 15 minutes, the work row asks **Link Flow #N** or
  **Dismiss**; only **Link** records the Flow on the session.
- **Session.** **Session** or **N sessions** opens the session bound to the
  pull request. Without one, the slot reads **Open in session**, which binds a
  new session to the pull request and names it after it.
- **Review.** Once the pull request has a Review, the row links to it with its
  round and how far the pull request has moved past the reviewed commit.

A review started with `/review` in the PR's session appears on the card as
soon as the session finishes or publishes its review package.

### Run a review from a card

Open a PR and choose **Start review** to review the base and head commits recorded when
the card was fetched. **Review orchestrator** is on by default. Turn it off to run
one source reviewer with single-reviewer coverage. Once a PR has a Review, its panel offers **Open in Reviews**: the
Review's panel in the **Reviews** tab holds the review interface and shows the current phase, the revision and
the reason the run stopped. You can return to the card later, cancel an
active review or retry an interrupted one. Windows and worktrees share an active
run when the verified GitHub account, PR, and base and head commits match.
Manual reviews have a 30-minute time limit and
unlimited tokens by default.

The review uses committed controls from the GitHub repository's default branch. The installed review skills supply defaults when the selected branch has no review controls. The PR's base and head still determine the code comparison.

During a run, the wave badge and progress line show how many reviewer assignments have finished. Before the plan is available, the indicator shows that the run is active. Open a reviewer to see its status, model when available and recorded activity. The session includes wave, timing and token usage. Older runs show the evidence saved with their review package.

Open a past run to inspect its coverage, findings and formatted report. **Token usage**
shows input, output and total tokens for the orchestrator, each reviewer and
the whole run. Providers can also report cache tokens and cost. A cost calculated
from configured rates appears under **Estimated cost**. Partial totals
cover only the available measurements. A dash means the value was unreported. After the PR
changes, its earlier report remains attached to the revision it covered.
The GitHub review decision still comes from GitHub. A manual Keryx review
records its result locally.

### Publish a review to GitHub

A finished review awaiting a publication decision has an orange **Action required**
tag. Open **Review publication** to preview and publish the review or choose
**Skip publication** to keep it local. The dialog shows the project GitHub account and a
formatted preview of the general comment and a separate preview of each inline
comment with its file and line. Choose whether to include inline
comments and findings in the general comment. GitHub reviews are written in
English using the Keryx template and the applicable project overlay. Desktop
supports an imported orchestration skill with a `templates/report-overlay.md`
file, such as Vantage Review. It also supports a project wrapper in
`.metaproject/review-publish-template.md` with one `{{review}}` placeholder.

Enable **Publish to GitHub automatically** in **Run review** to post one
review comment after full coverage. If the project overlay requires approval,
the review waits for you to confirm its final draft.

The review suggests a verdict based on its findings and coverage. You can
change it or choose **Use recommendation** to keep updating the verdict as the
findings change. **Approve with suggestions** sends a GitHub approval with the
selected review text. An incomplete review can be sent as a comment or request
changes. When the report gives you options for a finding, select the answer you
want to include with that finding. Other questions let you keep or dismiss the
finding and highlight the recommended action.

**Save locally** preserves the draft and its selected answers for the next time
you open this review.
Choose **Submit review** and confirm in the Desktop prompt to write to GitHub.
Keryx rechecks the GitHub account,
repository, and reviewed revision before submitting.

If new commits were pushed on top of the reviewed commit, the dialog names both
commits and offers **Publish as is for** the reviewed commit instead. That
review is a comment only, without inline comments, and its first line says
which commit was reviewed and that the PR has moved on. If more commits arrive
before you submit, refresh the preview. If the PR was closed, its base changed,
or its history was rewritten, you can still save the draft locally.
If a newer round of the same review exists, this round offers neither **Publish
as is** nor **Update review to**: publish from the newer round once it finishes,
or, if that round ended without a result, start a new round or save this draft
locally.

In the Review panel, the same dialog also offers **Update review to** the new
commit. It starts the next round of the same Review on the PR's current head,
with the previous round's settings except automatic publication, which you
decide again for the new round. Your answers to findings carry over by finding
id. If the current head already has a review attempt, Desktop shows that
attempt instead of starting another.

### Follow Reviews and their rounds

Open **Reviews** (**⌘3**) to see one Review per pull request. Every run on
that pull request is a round of the same Review: the first review, each
**Update review** and each scheduled re-review. A round keeps its attempts,
such as a retry after an interruption. Reviews started from Desktop, by a
review rule, or by an agent session with `keryx review complete` or
`keryx review publish` all appear here; the panel names the source as
**Manual**, **Scheduled**, **Existing review** or **Session**. A review a
session finished can be published from Desktop, and a review published by
one path is refused by the other, so the same review is never posted twice.

The board groups Reviews in **Running**, **Waiting on you**, **Behind**,
**Published** and **Closed**. **Behind** means new commits were pushed after
the reviewed commit; the card shows how many, or that the history was
rewritten. The list shows the same Reviews with their state, freshness,
latest findings and total tokens. Filter by state or freshness (**Current**,
**Behind**, **Unknown** when the PR head could not be read). Reviews of closed
pull requests and archived reviews are hidden until you select **Show
closed**. The panel lists the rounds newest first, with the report, findings
and publication of the selected round.

The command line reads the same Reviews: `keryx review reviews --json` lists
them, and `keryx review advance --json` opens an update round, as
[CLI reference](cli-reference.md) describes.

### When the pull request moves during a review

A round reviews the commit it started on and is never interrupted when new
commits arrive; its result stays true for that commit. After the round, the
Review shows as **Behind**, and the publication dialog offers **Update review
to** the new commit or **Publish as is for** the reviewed commit, as described
above.

Each Review stores an `on_head_move` choice that tells an agent session what
to do when the head moves during a round: `ask` (the default), `follow`
(finish the round, then open an update round) or `ignore` (finish the round
and leave the Review behind). The review-orchestrator skill reads it in its
**Head moved** procedure: with `ask` it offers **Update after this round
finishes** or **Stop and start on the new head**. Desktop has no control to
change the value yet, so every Review uses `ask`, and a round Desktop runs
keeps its range; start the update from the publication dialog.

### Fix findings

On your own open pull request, a Review whose reviewed round has blocker,
major or minor findings offers **Fix findings** in its panel, unless a round
is still running or the Review is closed or archived. It opens the PR's
session with an unsent prompt that names the reviewed round and commits, the
number of open blocker, major and minor findings, and the command that reads
them. Info findings are left out. Read and edit the prompt, then send it.

- Without a linked Flow, the prompt asks the agent to create a fix Flow, and
  the work row then offers **Link Flow #N**, as with **Create Flow**.
- With a linked Flow, the prompt asks for a fix round in that Flow, and no
  new Flow is linked.

### Watch PRs while Desktop is closed

From **Review**, open **PR watcher**, choose a polling interval and select **Enable watcher**. The default is five minutes. The first successful poll records which PRs are open, their revisions, requested reviewers and CI. The history shows the 50 latest changes with the time Keryx observed them.

Connect your account in **Settings → Integrations** so the background process can read the repository after your shell exits. macOS runs the schedule while you are logged in and the Mac is awake. You can quit Keryx Desktop. If the timer needs repair after an upgrade or a local tool moves, open **PR watcher** and select **Restore timer**. After sleep or a failed poll, the watcher compares the next complete result with the last successful one. Open **PR watcher** to check the timer, last attempt and last success, or select **Pause watcher**. **Resume watcher** starts with a fresh baseline so changes that occurred during an explicit pause do not appear as new events.

Keeping the same GitHub account preserves an existing schedule. Changing
accounts or disconnecting pauses the previous watcher and clears its pending
automatic reviews. Enable the watcher under the new account when ready.

### Set up automatic PR reviews

Open **Reviews → Review rules → New rule** and choose **Review requested or re-requested** or **New head commit**. You can restrict a rule to a PR author, assignee or requested reviewer. For a team, enter its GitHub slug, such as `my-org/frontend`. **Wait for passing CI** holds the request until checks pass on the current revision. Read the preview and set a time limit. Leave **Token limit (optional)** blank for unlimited tokens, or enter a positive whole number to cap each review. Save the rule.

Enable **PR watcher** to run the rules on its local schedule. Use a Keryx model provider signed in for noninteractive use by the local CLI. The timer can use stored credentials after Desktop exits. Credentials available only in an interactive terminal are outside its environment. The next complete poll establishes a baseline when you enable or edit a rule. Changes already present at that poll are skipped. A temporary connection error leaves pending work in place until the watcher can verify the repository again.

On a PR card, open **Automation**, select a mode and choose **Save mode**.

| Mode | What happens |
|---|---|
| Use project rules | Apply enabled rules that match this PR. This is the default. |
| Auto · rule name | Use just this rule. Its trigger, reviewer and CI conditions still apply. |
| Manual only | Skip scheduled reviews for this PR. You can start a review from the card at any time. |

The Automation tab of the PR panel shows why a rule is waiting, started or skipped. In the Review's panel in the **Reviews** tab, a scheduled attempt records the rule and revision alongside its report. Matching triggers can share an attempt with another rule or with a manual start. The rule or manual action that starts an attempt sets its time and token limits. Later matches keep those limits. Keryx uses the token usage reported by the provider to decide when to stop. The watcher reserves up to four scheduled workers per local Keryx data directory and rechecks eligible rules on its next poll when all four are occupied.

## Install

Requirements: macOS 12 or newer (the release is a universal build for Apple
silicon and Intel) and Node.js with npm for the keryx CLI. Keep keryx and the
app on matching releases: Keryx 0.2.0 needs keryx 0.4.37 or newer, and
`keryx app status` says whether the installed pair fits.

### With the keryx CLI (recommended)

```bash
npm i -g @mrciphersmith/keryx@latest
keryx app install --relaunch
```

1. The first command installs or updates the keryx CLI the app runs.
2. The second downloads the newest app release, installs
   `/Applications/Keryx.app` and opens it (drop `--relaunch` to open it
   yourself).
3. In the app, open a project folder; sign in to a model provider with
   `/connect` if you have not run `keryx auth login` before.

To update later: `npm i -g @mrciphersmith/keryx@latest` for the agent, then
`keryx app update` (or **Update and relaunch** in the app's banner) for the
app. Releases are listed at
<https://github.com/MrCipherSmith/keryx/releases> under `desktop-v*` tags.

To remove the app: quit it, delete `/Applications/Keryx.app`, and optionally
the `dev.keryx.desktop` folders in `~/Library/Application Support`,
`~/Library/Caches`, `~/Library/WebKit` and `~/Library/Logs` (window settings
and the web view's storage). Sessions belong to keryx, not the app, and stay.

`keryx app install` downloads the newest `desktop-v*` release from GitHub,
checks its SHA-256 against the release's `SHA256SUMS`, and installs
`/Applications/Keryx.app` (`--dir <folder>` for another place). A file the CLI
downloads is not quarantined, so the ad-hoc signed app opens without the
`xattr` step below. `keryx app status` shows what is installed and what is
released; `keryx app update` installs a newer release when there is one. The
[CLI reference](./cli-reference.md#app) has every flag.

### From a downloaded `.dmg`

1. Open `Keryx_<version>_universal.dmg` (from a release) or the
   `_aarch64.dmg` you built, and drag **Keryx** to **Applications**.
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

`keryx app build` does the same from anywhere inside the checkout and refuses
outside one.

`desktop:build` compiles keryx into a single binary, puts it inside the app
and runs `tauri build`. The results:

- `apps/desktop/src-tauri/target/release/bundle/macos/Keryx.app`
- `apps/desktop/src-tauri/target/release/bundle/dmg/Keryx_<version>_aarch64.dmg`

Releases tagged `desktop-v*` are built by `.github/workflows/desktop-release.yml`
into a universal `.dmg`, the `Keryx_<version>_universal.app.tar.gz` that
`keryx app install` downloads, and `SHA256SUMS` over both; Developer ID
signing and notarization switch on once the `APPLE_*` secrets exist.

### Which keryx the app runs

**Settings → Desktop → Which keryx to run** has four sources:

| Source | What runs |
|---|---|
| Automatic (default) | The `keryx` on your login-shell `PATH` — the npm install, so `npm i -g @mrciphersmith/keryx` updates the agent without a new app — and the bundled keryx when there is none. |
| Bundled | The keryx built into `Keryx.app/Contents/MacOS/keryx`; it changes only with the app. |
| PATH | Only the `keryx` on your login-shell `PATH`. |
| Custom path | Any executable, for example a wrapper that runs a development checkout. |

An app that stored **Bundled** before the Automatic source existed is moved to
Automatic once, because it saved that default on every change; choosing
Bundled again afterwards sticks.

The app needs a keryx whose `initialize` answer reports the `shell` profile
with live sessions. 0.4.32 is only the protocol floor the app checks; the
released 0.4.32 to 0.4.35 have no shell profile, so they do not qualify. With
a keryx that does not qualify the start fails with a "This keryx is too old
for the app" dialog (update keryx with npm, or use the bundled keryx) instead
of starting silently. The bundled keryx always qualifies.

### Updates

A few seconds after it starts, and every 6 hours while it is open, the app
asks the keryx it runs (`keryx app status --json`) for the newest release and
for the oldest app that keryx works with. A card in the bottom-left corner
then offers **Update and relaunch** when:

- a newer `desktop-v*` release exists (**Skip this version** hides it until
  the next one), or
- the keryx needs a newer app than this one (`minDesktopVersion`); this card
  comes back on every start until the app is updated.

**Update and relaunch** starts `keryx app update --wait-pid <the app> --relaunch`
and quits the app; the CLI waits for it to exit, swaps the bundle in place and
opens the new app. If the update fails the old app is kept and reopened; the
CLI's output is in `~/Library/Logs/dev.keryx.desktop/app-update.log`. No card
appears offline, with a keryx older than `keryx app`, or in a development
build that does not run from `Keryx.app`.

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

Open **Settings** from the sidebar and use the **Appearance**, **Sessions**,
**Integrations** and **Desktop** tabs. Close Settings with the top-right
button or Escape to return to the project view you were using.

Settings → Appearance sets the theme, the interface font (System, Rounded,
Serif, Mono), the code font, the text size and the conversation width
(Narrow, Wide, Full).

Choose a light palette and a dark or black palette independently. **System**
follows macOS appearance and applies the palette saved for the current mode.

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

### Explore Metaproject

Open **Metaproject** in a project window or press **⌘6**. Search wiki text and
indexed names or paths, read a page in **Wiki**, and use **Graph** to trace
its connections. The [Desktop Metaproject guide](guides/desktop-metaproject.md)
walks through setup, optional symbol indexing, graph filters, keyboard
navigation, and recovery when an index is stale or missing.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘K | Command palette: commands, sessions, views |
| ⌘1 / ⌘2 / ⌘3 | Sessions / Flows / Reviews in the current project |
| ⌘4 / ⌘5 / ⌘6 | Pull requests / Issues / Metaproject in the current project |
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
