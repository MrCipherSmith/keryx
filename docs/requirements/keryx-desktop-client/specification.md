# Keryx Desktop Client — Specification
Version: 0.3.0

## 1. Identity

| Item | Value |
|---|---|
| Product name | Keryx (desktop) |
| Bundle identifier | `dev.keryx.desktop` |
| Code location | `apps/desktop/` (Tauri v2: `src-tauri/` Rust, `src/` React + Vite + TypeScript) |
| Agent side | `keryx acp --profile shell` (`src/acp/`, `src/commands/acp.ts`) |
| Version | independent semver in `apps/desktop/package.json` and `src-tauri/tauri.conf.json`; release tag `desktop-v<version>` |
| Minimum macOS | 12 |

## 2. Architecture

```text
┌───────────── Keryx.app ─────────────┐
│ Web view (React)                     │
│   ACP client state, rendering        │
│        ▲ events        │ invoke      │
│ Rust core (Tauri)                    │
│   keryx locator · process · framing  │
│   fs/read_text_file handler          │
└────────┬─────────────────────────────┘
         │ stdio, newline-delimited JSON-RPC 2.0 (ACP v1)
┌────────▼─────────────────────────────┐
│ keryx acp --profile shell (sidecar)  │
│   session store · policy · sandbox   │
│   shell tool roster · providers      │
└──────────────────────────────────────┘
```

One `keryx acp` process per open project window. The Rust core does not
interpret ACP beyond framing, request-id bookkeeping and the `fs/*` handler;
protocol state lives in the web view.

## 3. Agent side: `keryx acp --profile shell`

### 3.1 Flag

`keryx acp --profile <editor|shell>`. Default `editor` — today's behaviour,
byte-for-byte. An unknown value is a usage error (exit 2).

### 3.2 `initialize`

- `agentInfo.version` is the keryx package version (today it is `"0"`).
- The result carries `_meta.keryx = { profile, profiles: ["editor","shell"],
  extensions: [<method names>] }`.
- `_keryx/info` (agent method, any profile) returns
  `{ version, profile, profiles, extensions }`.

### 3.3 Roster (M1)

Built by `buildInteractiveAgentTools` (`src/commands/interactive-agent-tools.ts`),
the same factory `keryx shell` uses, with session-scoped inputs:

| Input | M1 binding |
|---|---|
| `cwd`, `metaprojectPort` | session root, `createMetaprojectAdapter(root)` |
| `searchController` | built as `keryx shell` builds it |
| `jobRegistry` | one per ACP session, every task killed on session close and process exit |
| `getSessionDir` | the session's own directory in the keryx session store |
| `askUser` | forwards to the client (§3.6) when the client advertised it; otherwise the tool is denied |
| `mcp` | keryx's configured MCP servers, merged with the client's `mcpServers` |
| `spawnTool` | M2 — denied in M1 |
| `bus`, `schedules`, `operatorConfirm`, `reviewAgents` | M2 — omitted |

`read_file` keeps the existing client-`fs` routing (`acpAwareReadFileTool`).
Tools whose results are `untrusted` (`web_fetch`, `web_search`, MCP) are
offered only together with a test proving the approve-before-announce path
over ACP.

### 3.4 Modes

`session/new`, `session/load` responses carry
`modes: { currentModeId, availableModes: [{id:"ask"},{id:"trust"},{id:"auto"}] }`
with names and descriptions. The initial mode is the stored default the
shell itself resolves — the user-global `permission-mode.json` read by the
shell's mode chain, so a project cannot inject `auto` — else `ask`.

`session/set_mode { sessionId, modeId }` switches the mode and emits
`current_mode_update`. Semantics are the shell's (`.metaproject/wiki/architecture/permission-modes.md`):
`ask` asks every gated call; `trust` auto-approves except destructive,
credential-touching and other escalated calls; `auto` auto-approves all but
credential-touching calls. An auto-approved call's `tool_call` update carries
`_meta.keryx.autoApproved: true`. Escalated calls never get `allow_always`
(unchanged from `src/acp/permission.ts`).

### 3.5 Session updates added in the `shell` profile

| Update | When |
|---|---|
| `plan` | the execution-plan tools change the session plan; entries map `{content, priority, status}` |
| `usage_update` | after every model call; input/output tokens for the turn and the session |
| `session_info_update` | the session title is set or changes |
| `current_mode_update` | after `session/set_mode` |

### 3.6 `_keryx/ask_user` (agent → client request)

Sent only when `initialize.clientCapabilities._meta.keryx.askUser === true`.

```json
{ "sessionId": "…", "question": "…", "options": [{"label":"…","description":"…"}], "multiSelect": false }
```

Result `{ "outcome": "answered", "answers": ["<label or free text>"] }` or
`{ "outcome": "cancelled" }`. A transport error or cancel is reported to
the model as a declined question.

### 3.7 Slash commands

M1 keeps `/help`, `/model`, `/reasoning`, `/status` and adds `/mode
<ask|trust|auto>` (same effect as `session/set_mode`). The full shell set is M2.

### 3.8 Amendments from the M1 implementation

Wire details the sections above left open, as built (`src/acp/server.ts`,
`src/acp/profile.ts`, `src/acp/ask-user.ts`, `src/acp/shell-roster.ts`):

- `initialize._meta.keryx` is sent in the `shell` profile only, so the
  `editor` answer stays byte-for-byte unchanged; `_keryx/info` answers in both.
- The auto-approval mark is a `tool_call_update` (status `in_progress`) on the
  call's own `toolCallId`, sent after the `tool_call` announcement and before
  the result: the gate runs after the call is announced.
- `usage_update` keeps ACP's required `used`/`size` (`used` = the model call's
  input + output tokens, `size` = the context window, `0` when unknown); the
  §3.5 totals ride in `_meta.keryx = { call, turn, session }`, each
  `{ inputTokens, outputTokens }`.
- `session_info_update` is sent after `session/new`/`session/load` with the
  stored title, and after a turn whose persistence changed it.
- `plan` entries carry keryx's own item id and status in `_meta.keryx`
  (`proposed`/`blocked` map to `pending`, `skipped` to `completed`); the plan is
  re-sent after `session/load`.
- `_keryx/ask_user` sends the recommended label, `allowFreeform`,
  `irreversible` and `untrustedContent` in `_meta.keryx`. An answer equal to an
  option label (or id) picks it; any other text is the person's own answer.
- `session/set_mode` answers `{}` and sends `current_mode_update` after the
  reply. The mode is not written back as the project default.
- Untrusted tools are offered: `shell-profile.test.ts` (AC7) drives an
  untrusted MCP `use_tool` result and the gated `shell_exec` after it over the
  real pipe — the same `untrusted` result flag `web_fetch`/`web_search` set.
- MCP: keryx's configured servers (one runtime per project root per
  connection) and the client's are merged into one `search_tool`/`use_tool`
  pair; a client server whose name keryx also configures is dropped as a
  whole and reported to the session as an MCP problem.
- Tasks: the shell-task tools (`shell_task_output`/`wait`/`kill`) are offered
  in M1 because `shell_exec` is supervised; the task *panel* is M2. Workspace,
  Slate and working-memory tools are offered through the shell factory with
  the session directory bound.
- In auto mode an `ask_user` the model answers itself is reported to the
  client as an `agent_message_chunk` with `_meta.keryx.selfAnsweredQuestion: true`.
- The `shell` profile holds live sessions (owner decision 2026-11-17, see
  D-09): every session a `session/new` or `session/load` opens stays held by
  the connection beside the others, and opening one releases none. Each keeps
  its own turn, mode, model, usage, client MCP servers, plan and shell tasks;
  a turn in a session the client is not showing keeps running, and its
  updates, permission requests and `_keryx/ask_user` questions carry its
  `sessionId`. At most 8 sessions are held (`MAX_HELD_SESSIONS`,
  `enforceIdleCap`): past that, the least recently used session with no
  running turn, no running shell task and no request in flight is released
  (lease, client MCP binding, hooks with `SessionEnd`) and keryx sends
  `_keryx/session_released {sessionId, reason: "idle-cap"}`; a later load
  restores its mode, model and usage. When every held session is busy none is
  released. The client reads `initialize._meta.keryx.liveSessions` and treats
  a keryx without it as too old. The `editor` profile keeps every session
  until the connection ends.

### 3.9 M2 part 1 — commands, subagents, tasks (proposed 2026-11-17)

Status: scope and order confirmed by the owner on 2026-11-17: every shell
command including the picker/modal ones; `/connect` as an in-app dialog;
order commands → tasks → subagents; the Subagents tab keeps a session's
subagents until `/new`. Decisions D-10..D-12.

#### 3.9.1 `_keryx/command` (client → agent request, `shell` profile)

```json
{ "sessionId": "…", "name": "tasks", "args": "kill t3" }
```

Result `{ "text": "<what the shell would print>", "_meta": { "keryx": { "effects": [...] } } }`.
`effects` names state the command changed so the client can refresh without
parsing text: `mode`, `model`, `config`, `plan`, `transcript` (after
`/compact`, `/rewind`), `tasks`. A command keryx does not serve is a JSON-RPC
error `-32602` naming it; a known command refused in the current state
(busy, lease lost, `KERYX_REWIND=off`) answers `{ text }` with the reason and
`_meta.keryx.refused: true`.

The request is not a turn: it does not take the session's prompt slot, its
text is not added to the model's history, and it can run while a turn is
running. During a turn it follows `src/tui/busy-dispatch.ts`: commands the
shell runs while busy run; commands the shell refuses while busy
(`BUSY_REFUSED_COMMANDS`: `/new`, `/clear`, `/resume`, `/sessions`,
`/rewind`) and commands the shell would queue are refused with the shell's
own wording. Text-only `session/prompt` slash handling (§3.7) stays for
editors; the desktop sends commands only through `_keryx/command` (D-10).

Implementation: one served table in `src/acp/commands.ts`
(`ACP_SHELL_SLASH_COMMANDS`) built from `AGENT_SLASH_COMMANDS`, each row
naming its runner. Runners reuse the readline/text functions the inventory
found (`runTasksCommand`, `compactSession`, `createRewindReadlineCommand`,
`buildDoctorReport`, `formatFlowListText`, `conversationHistoryText`,
`runTrailCommand`, `runNotesCommand`, `runDiagCommand`, `runGoalCommand`,
`executePlanCommand`, `parseDemoteCommand`/`demoteTask`,
`permissionsSlashText`, `approvalsSlashText`, `remotePolicyText`,
`runMcpTrustCommand`, `externalDiffSlashText` (list only), the `run*ForShell`
Jev one-shots, `renderReviewsText`, `renderSetupSlash`, `formatSettingsTable`
and the readline status texts of `/channels`, `/intake`, `/remote-control`,
`/rendering`). No TUI module is imported for its renderer; where a runner
lives in `src/tui/` and pulls OpenTUI, it moves to a neutral module first.
`ACP_TUI_ONLY_COMMANDS` shrinks to the D rows of §3.9.2.

**Views.** A command whose shell surface is a picker, list/detail modal or
form answers with a structured view instead of (or beside) text, in
`_meta.keryx.view`:

```json
{ "title": "Schedules",
  "rows": [ { "id": "s1", "label": "nightly review", "detail": "…", "status": "paused",
              "actions": [ { "label": "Resume", "command": "/schedules resume s1" },
                           { "label": "Delete", "command": "/schedules delete s1", "confirm": "Delete nightly review?" } ] } ],
  "body": "optional detail text",
  "form": { "fields": [ { "id": "text", "label": "Task", "kind": "text|secret|choice|toggle", "options": [] } ],
            "submit": "/task {text}" } }
```

Every action and form submit is itself a command line, sent back with
`_keryx/command`; so each view needs a text subcommand for each action. Where
the TUI modal acts through a closure and the shell has no such subcommand
(`/routing` model pick, `/ci` triage, `/conform`, `/task`, `/review` accept,
`/product`, `/governance`, `/triggers` run-now, `/schedule` confirm,
`/autoreview`, `/jevprofile` toggles, `/ac` re-check, `/settings` buttons,
`/guard`/`/editguard`/`/projectctx` bare inspectors, bare `/bus`,
`/search-connect`, `/workspace`), the subcommand is added to the shell's
command module so both surfaces share it. A confirmation the TUI shows as a
card (`/schedule`, `/mode auto`, `/external-diff apply` hash) is the action's
`confirm`; destructive actions always carry one.

`/queue` and `/delegate`: while a turn runs the desktop holds the composer's
queued prompts itself (one queue per session, sent in order when the turn
ends); `/queue` is a `client` command over that queue (list, remove, edit,
force = cancel and send next). `/delegate` is a `text` command whose external
run appears in the Subagents tab (§3.9.4, `runtime: "external"`).

#### 3.9.2 `available_commands_update` in the `shell` profile

Lists every served command plus the client-handled ones, each with
`_meta.keryx = { group, surface, busy }`:

- `group`: the `HELP_GROUPS` group, for a grouped palette.
- `surface`: `text` (run with `_keryx/command`), `dialog` (the client opens
  its own dialog: `/connect`, `/search-provider`), `client` (the client acts
  alone: `/new`, `/clear` → `session/new`; `/resume`, `/sessions` → session
  list; `/interrupt` → `session/cancel`; `/mode` → mode picker; `/model` →
  model picker).
- `busy`: `run` or `refuse`, from `busy-dispatch.ts`.

- `surface` adds `view` for commands answering with §3.9.1 views.

Not advertised (meaningless outside a terminal): `/think`, `/expand`,
`/copy`, `/theme`, `/game`, `/exit`, `/quit`, `/integrate` (wires an editor
to keryx; the desktop is already wired).

#### 3.9.3 Provider connection — `_keryx/providers/*` (D-11)

`/connect` opens the client's Providers dialog. It needs no terminal: every
step already exists outside the TUI (`detectProviders`,
`PROVIDER_AUTH_CATALOG`, `testProviderConnection`, `disconnectProvider`,
`saveApiKey`, `loginDeviceCode`, `saveCustomCompatProvider`,
`resolveModelsForPicker`); `runProviderConnectSequence` is re-expressed as
these requests.

| Method | Params | Result |
|---|---|---|
| `_keryx/providers/list` | `{}` | `{ providers: [{ id, label, connected, authMethods: ["api-key"\|"device-code"\|"none"], needsBaseUrl, baseUrl?, refusal? }] }` |
| `_keryx/providers/test` | `{ providerId }` | `{ ok, models?: number, error? }` |
| `_keryx/providers/disconnect` | `{ providerId }` | `{ sharedEnvWith: [id] }` |
| `_keryx/providers/connect` | `{ providerId, method: "api-key", apiKey, baseUrl? }` or custom `{ custom: { name, baseUrl, apiKey? } }` | `{ ok, error?, retry?: "credential"\|"base-url" }` |
| `_keryx/providers/login` | `{ providerId }` (device code) | answered when the login ends: `{ outcome: "connected"\|"cancelled"\|"failed", error? }` |
| `_keryx/providers/login_cancel` | `{ loginId }` | `{}` |

During a login keryx sends the notification
`_keryx/providers/login_challenge { loginId, providerId, userCode,
verificationUri, verificationUriComplete?, instructions? }`; the client shows
the code, offers Copy and opens the URL in the system browser. keryx polls and
writes the grant exactly as the shell does (`auth.json`, 0600). The API key
travels only inside the `connect` params over the private stdio pipe; it is
never echoed, logged or added to the transcript, and keryx's stderr log
redacts it. After any connect or disconnect keryx sends
`config_option_update` to every held session so the model list reflects the
new providers; switching the session's provider stays the client's
`session/set_config_option model` choice — Connect alone never switches.
A provider whose `authMethods` is `["none"]` (Ollama, rapid-mlx, a base-URL
only endpoint) is connected with `{ providerId, method: "none", baseUrl? }`.
The `login` request is answered only when the login ends, so the client
learns `loginId` from the first `login_challenge` (matched by `providerId`).

`/search-provider` uses the same pattern:

| Method | Params | Result |
|---|---|---|
| `_keryx/search_providers/list` | `{}` | `{ providers: [{ id, label, connected, selected?, needsKey?, refusal? }] }` |
| `_keryx/search_providers/connect` | `{ providerId, apiKey? }` | `{ ok, error? }` |
| `_keryx/search_providers/select` | `{ providerId }` | `{ ok, error? }` |

Task wire as the client reads it (§3.9.5): `jobId` is the id; `startedAt` /
`endedAt` are ISO-8601 strings, as `BackgroundJobInfo` keeps them; `status`
is `running` while running; `nextCursor` is a number passed back as `since`
(omitted on the first read = 0); `missed` is the number of dropped bytes
(0 when none).

#### 3.9.4 Subagents (D-12)

`spawn_subagent` is offered in the `shell` profile with native children only
(`nativeOnly: true`; an external runtime chosen by the model is M2b). Runs
started by `/delegate` use the shell's external path and send the same
events with `runtime: "external"`. Its own call
goes through the session's gate (risk `delegate`) like any gated tool;
children never ask the user (unchanged invariant). The ACP host builds the
spawn deps the way `keryx shell` does (`makeAgentDeps`, shell.ts), from a
shared factory extracted from that code rather than a copy.

Each session gets its own `onFleetEvent` closure (never the TUI's
module-global bridge) that sends
`_keryx/subagent { sessionId, event }`, where `event` is the shell's
`SpawnSubagentFleetEvent` unchanged:

- `{ kind: "upsert", id, label, status: "running"|"done"|"failed", detail?, model?, task?, parentToolCallId? }`
- `{ kind: "log", id, entry: { kind: "task"|"text"|"reasoning"|"tool"|"result"|"system", text } }`

`parentToolCallId` links a subagent to the `spawn_subagent` tool call: the ACP
host passes the call's `toolCallId` in `InteractiveToolContext` (new optional
field) and the tool copies it into its upserts. A `log` `text` entry carries the
whole assistant text so far: the client replaces the subagent's last `text`
entry when the previous entry is also `text`, else appends. Client limits
mirror `src/tui/subagent-session.ts` (200 entries, 2,000 characters each).
Cancelling the turn (`session/cancel`) cancels its subagents; there is no
per-subagent cancel in M2a. Subagents are not persisted: after `session/load`
the panel is empty.

#### 3.9.5 Background tasks — `_keryx/tasks/*`

The session's job registry is created with `onEvent`, which sends
`_keryx/tasks/event { sessionId, event }` for `start`, `phase` and `exit`
(never `output` chunks). Requests:

| Method | Params | Result |
|---|---|---|
| `_keryx/tasks/list` | `{ sessionId }` | `{ tasks: [BackgroundJobInfo minus private] }` |
| `_keryx/tasks/output` | `{ sessionId, taskId, since? }` | `{ output, nextCursor, missed, status }` (`readOutputSince`, no shared cursor) |
| `_keryx/tasks/kill` | `{ sessionId, taskId }` | `{ status }` (`kill(id, "operator")`) |

Private tasks are never listed. A released session's tasks are gone (they are
killed on release, §3.8).

#### 3.9.6 Advertising

All new methods join `KERYX_ACP_EXTENSION_METHODS` and appear in
`initialize._meta.keryx.extensions`; the client checks for them and hides a
feature the connected keryx does not advertise.

## 4. Client side

### 4.1 Rust core (`apps/desktop/src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `locator.rs` | resolve the keryx binary: bundled sidecar (`<dir of current_exe>/keryx`, i.e. `Keryx.app/Contents/MacOS/keryx`), `keryx` on the login-shell `PATH`, or an explicit path, per settings |
| `shellenv.rs` | capture the login-shell environment once (`$SHELL -ilc 'env -0'`, 5 s timeout) so GUI-launched keryx sees `PATH` and provider keys from shell rc files |
| `process.rs` | spawn `keryx acp --profile shell` in its own process group with the project folder as cwd; stop = close stdin, SIGTERM, wait 9.5 s, SIGKILL the group |
| `framing.rs` | newline-delimited JSON framing; oversized-line guard (16 MiB) |
| `bridge.rs` | Tauri commands `acp_start(cwd)`, `acp_send(message)`, `acp_stop()`; per-window start lock; emits `acp://message` and `acp://exit` events per window; stops run off the UI thread |
| `fs.rs` | answers `fs/read_text_file` on a worker thread inside the git toplevel of the opened folder (the same root keryx binds); 8 MiB cap; one error for every outside path. Defence in depth only — keryx's own tools never pass through it |
| `settings.rs` | settings |
| `version.rs` | semver compare against `MIN_KERYX_VERSION` (0.4.32, the protocol floor; the app also requires the shell profile with live sessions) |
| `flows/` | the Flows board backend ([flows-board.md](flows-board.md)) |

`cargo test` covers framing, locator, fs confinement, process-group stop,
version checks and the flows parsers and argv builder.

### 4.1.1 Storage and config

| Item | Location |
|---|---|
| Settings | `settings.json` in the Tauri app config dir (`~/Library/Application Support/dev.keryx.desktop/`): `keryxSource` (`bundled`, `path`, `custom`), `customPath`, `recentProjects`, `theme` |
| keryx stderr log | the Tauri app log dir (`~/Library/Logs/dev.keryx.desktop/`), one file per window process |
| Sessions, flows | keryx's own stores; the app keeps no copy |

### 4.2 Web view (`apps/desktop/src/`)

- `acp/` — typed JSON-RPC client: request ids, pending map, notifications,
  agent→client requests (`session/request_permission`, `_keryx/ask_user`).
- Screens: Welcome (open folder, recent projects), Session (transcript,
  composer, side panel), Settings.
- Transcript: streaming markdown; collapsible reasoning; tool-call cards with
  kind, status, collapsible output; auto-approved marker.
- Composer: multi-line, Enter sends, Shift+Enter newline, `/` command
  completion from `available_commands_update`, Cancel during a turn.
- Side panel: sessions (list, load, new), mode selector, model selector
  (`session/set_config_option` `model`), plan, usage.
- Dialogs: permission (options from the request; `allow_always` only when
  offered), `ask_user`, incompatible-keryx error, session-leased error with
  a "new session" action.

### 4.2.1 Web view additions (M2a)

- Composer palette: typing `/` opens a grouped, filterable list of every
  advertised command with its hint; Tab/Enter completes; a `text` command is
  sent with `_keryx/command` and shown as a command card (input + output) in
  the transcript; `dialog` and `client` commands open their UI. A command
  refused while busy shows the reason inline and keeps the draft.
- Providers dialog (`/connect`, also from the model picker): Connected and
  Add tabs, Test, Disconnect, API-key field (password input), base URL,
  custom provider form, device-code panel (code, Copy, Open browser, Cancel).
- Activity panel (right side, collapsible) with two tabs:
  - Subagents: one row per subagent (label, status, detail, model), linked
    from the `spawn_subagent` tool card; selecting one shows its task and
    transcript (text, reasoning, tool, result entries).
  - Tasks: one row per task (command, status, phase, elapsed, exit code);
    selecting one shows its output (polled with `_keryx/tasks/output` while
    shown and running); Kill with a confirmation.
  - Badges for running subagents and tasks per session in the sidebar.

### 4.3 Client capabilities sent at `initialize`

`{ fs: { readTextFile: true, writeTextFile: false }, terminal: false,
  _meta: { keryx: { askUser: true } } }`

## 5. Packaging and distribution

- `scripts/desktop/build-sidecar.sh` runs `bun install --os='*' --cpu='*'`
  and compiles keryx with `bun build --compile` (same entry and flags as
  `.github/workflows/release.yml`) into
  `apps/desktop/src-tauri/binaries/keryx-<target-triple>`. The compiled binary
  keeps the gaps recorded in
  [keryx-native-distribution](../keryx-native-distribution/README.md): three
  optional-dependency imports (embedding, PII NER, injection detector) fall
  back as in the released standalone binary.
- `bun run desktop:build` (root script) builds the sidecar for the host arch,
  then `tauri build`, producing `Keryx.app` and `Keryx_<version>_<arch>.dmg`.
  The `.app` is ad-hoc signed.
- `.github/workflows/desktop-release.yml` on `desktop-v*`: macOS runner,
  both sidecar targets, `tauri build --target universal-apple-darwin`,
  Developer ID signing and notarization when `APPLE_*` secrets exist, `.dmg`
  attached to the release. Homebrew cask and updater manifest are M3.

## 6. Integration points

- `src/acp/server.ts` — profile switch, modes, new updates, `_keryx/*`.
- `src/acp/profile.ts`, `src/acp/shell-roster.ts`, `src/acp/ask-user.ts` — new.
- `src/acp/protocol.ts`, `src/acp/agent-io.ts`, `src/acp/session-mcp.ts` — extended.
- `src/acp/permission.ts` — unchanged gate; the mode is supplied to the shell's own gate.
- `src/commands/acp.ts` — `--profile` flag and help.
- `src/commands/interactive-agent-tools.ts` — reused, not forked.
- root `package.json` — `desktop:build` script.

## 7. Acceptance criteria (M1)

| # | Criterion | Verification |
|---|---|---|
| AC1 | `--profile shell` roster equals `buildInteractiveAgentTools` output minus the M2 denials | exec `bun test src/acp/shell-profile.test.ts` |
| AC2 | `editor` profile unchanged | invariant `bun test src/acp/editor-profile-golden.test.ts` |
| AC3 | modes advertised; `set_mode` changes gate behaviour per §3.4 | exec `bun test src/acp/shell-profile-modes.test.ts` |
| AC4 | `plan`, `usage_update`, `session_info_update`, `current_mode_update` emitted | exec `bun test src/acp/shell-profile.test.ts` |
| AC5 | `_keryx/ask_user` round trip; omitted without client capability | exec `bun test src/acp/shell-profile.test.ts` |
| AC6 | `initialize` returns real version and profiles; `_keryx/info` answers | exec `bun test src/acp/shell-profile.test.ts` |
| AC7 | untrusted-result path tested over ACP before web tools are offered | exec `bun test src/acp/shell-profile.test.ts` |
| AC8 | Rust core tests pass | exec `cd apps/desktop/src-tauri && cargo test` |
| AC9 | web view type-checks and builds | exec `cd apps/desktop && bun run build` |
| AC10 | `.dmg` builds locally on arm64 | exec `bun run desktop:build` |
| AC11 | installed app completes a real turn with an approved `shell_exec` | judged |
| AC12 | release workflow present and reviewed | judged |

## 8. Acceptance criteria (M2a)

| # | Criterion | Verification |
|---|---|---|
| AC13 | `_keryx/command` runs every `text` row, refuses per busy rules, never touches model history; `available_commands_update` carries `_meta.keryx` | exec `bun test src/acp/shell-commands.test.ts` |
| AC14 | `_keryx/providers/*`: list, api-key connect (key never in any outbound message or log), device-code login with challenge and cancel against a fake OAuth server, disconnect, `config_option_update` after | exec `bun test src/acp/shell-providers.test.ts` |
| AC15 | `spawn_subagent` offered; `_keryx/subagent` events carry `sessionId` and `parentToolCallId`; cancel reaches children; children never request permission | exec `bun test src/acp/shell-subagents.test.ts` |
| AC16 | `_keryx/tasks/list/output/kill` and `_keryx/tasks/event`; private tasks hidden | exec `bun test src/acp/shell-tasks.test.ts` |
| AC17 | `editor` profile unchanged | invariant `bun test src/acp/editor-profile-golden.test.ts` |
| AC18 | palette, Providers dialog, Activity panel wiring | exec `cd apps/desktop && bun test src` (happy-dom `*.dom.test.tsx`) |
| AC19 | `.dmg` builds; `/connect` (api key), `/tasks`, `/compact`, a subagent run and a task kill clicked through in the installed app | judged |
