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
<ask|trust|auto>` (same effect as `session/set_mode`). The full shell set is
M2a (§3.9), served through `_keryx/command`; prompt-text slash handling keeps
the M1 set.

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
  "form": { "fields": [ { "id": "text", "label": "Task", "kind": "text|secret|choice|toggle|number|time", "options": [] } ],
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

*Form fields.* Besides `id`, `label`, `kind`, `options` (strings or
`{ value, label }`), `value` (prefill), `placeholder` and `required`, a field
may carry: `showWhen: { field, equals: [...] }` (shown only while another field
holds one of those values; a hidden field is not required, not validated and
not sent: its `{placeholder}` is dropped from the submit line together with the
`--flag` before it); `min` and `step` (kind `number`: inclusive lower bound,
input step); `pattern` (kind `text`: the whole value must match; kind `time` is
always `HH:MM`); `error` (the text shown under the field when `min` or
`pattern` fails). The form may carry `disabled` (a reason: Submit stays
disabled and the reason is shown). The client validates before submit (required,
number, `min`, `time`, `pattern`) and shows the message under the field; this is
convenience only, keryx still validates the command and a refusal still shows
inline. `/schedule` is the model: its cadence is a `Repeat` choice (minutes /
hours / daily / weekdays / cron) with dependent fields whose values come from
the shell's own cadence rule, its provider choice lists every connected
provider (a provider that reports no token usage is allowed: its runs report
"cost unknown"), its **Permission mode** is a required `choice` (ask / trust /
auto, default trust) whose option labels carry a one-line hint each (an
unattended `ask` denies every command that needs approval, because nobody
answers), and its rates and ceiling are optional number fields (rates stay
prefilled from the model's known price; both only feed the run's report).
*Owner decision 2026-11-18: a schedule's cost is reported, never a gate. No
reservation, ceiling or usage rule refuses a draft, refuses a tick or aborts a
running tick; a ceiling is informational ("over the ceiling" in the report).*
The form submits form-only flags (`--repeat --minutes --hours --at --cron
--rate-in --rate-out`) that `keryx acp` converts to the shell's `--every
"<cadence>"` and `--rates in,out` before the shell's parser runs; an empty
optional field is dropped, never sent.

*Submit label and draft confirmation.* A form may carry `submitLabel` (the
submit button's text; the client says "Submit" when absent; `/schedule` says
"Create"). A result may carry `_meta.keryx.confirmAction = { label, confirm,
command }`: a draft the user must confirm, meaning "ask now, then run
`command`". The client opens one confirmation dialog at once, showing `confirm`
with `label` on its button, instead of rendering a Create button; Confirm sends
`command` (the exact `/schedule confirmed ...` line, in place of the form's
card), Cancel sends nothing and leaves the form as it was. The result's `text`
carries the same card plus the line to run, so an editor or a client without
the dialog reads a complete answer. `/schedule <flags>` drafts this way and
writes nothing; the two user steps are Create (the form) and Confirm.

`/queue` and `/delegate`: while a turn runs the desktop holds the composer's
queued prompts itself (one queue per session, sent in order when the turn
ends); `/queue` is a `client` command over that queue (list, remove, edit,
force = cancel and send next). `/delegate` is a `text` command whose external
run appears in the Subagents tab (§3.9.4, `runtime: "external"`); in the
desktop it runs interactively in the built-in terminal (D-14, §3.9.5a, §4.4).

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
(`nativeOnly: true` unless the client runs terminals; an external runtime
chosen by the model is allowed in trust or auto mode only, see §3.9.5a). Runs
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
per-subagent cancel in M2a. Native subagents are not persisted: after
`session/load` they are gone. A `/delegate` terminal run is rebuilt from the
notes it left in the history (§3.9.5a, "Delegate results in the history").

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

#### 3.9.5a As built (2026-11-17)

Where the implementation differs from the text above
(`src/acp/shell-commands.ts`, `shell-command-runners.ts`, `shell-views*.ts`,
`providers.ts`, `shell-tasks.ts`, `src/commands/spawn-deps.ts`):

- Busy: while a turn runs every command the shell would queue (including
  `/tasks`, `/status`, `/model`, `/compact`) is refused with "main is busy:
  command deferred"; the Tasks tab (`_keryx/tasks/kill`) is the way to stop a
  task mid-turn.
- `/goal` (owner, 2026-11-18): the command does the shell's deterministic
  part (slate, seed) and answers `_meta.keryx.effects: ["startTurn"]` with
  `_meta.keryx.prompt`, the exact turn text the shell would send. The client
  sends that text as `session/prompt` on the same session; a busy session
  refuses `/goal` as the shell does. The command itself still never enters
  model history; the turn it starts does.
  As built: `prepareGoalRun` (`goal-command.ts`) is the shell's own part of
  `runGoalCommand` before its first turn; the session keeps one slate ref,
  and later turns run with it. `/goal --auto` is refused (its continuation
  rounds and verifier are turns the shell drives itself), as is a goal with a
  rejected `--workspace`.
- `/delegate` (owner, 2026-11-18): the ACP host gets the shell's external-run
  port (`createLazyRunExternal`). Starting a run needs approval: keryx sends
  `session/request_permission` (kind `execute`, the vendor CLI and task in
  `rawInput`) in place of the TUI's `approveExternalSpawn` card; a rejection
  answers the command refused. The run's events go out as `_keryx/subagent`
  with `runtime: "external"` and no `parentToolCallId`. As built: the approval is
  asked first and offers only allow once / reject once; the capability gate
  runs after it, so a disabled agent answers refused after an approval.
  `session/cancel`, a release of the session and the connection's end stop
  the run (and withdraw an approval still being asked).
- Delegate results in the history (owner bug 2026-11-18): a terminal run's turn
  note stays in the parent's history as an injected, harness-provenance,
  enveloped user message (model-facing, unchanged, still untrusted). Three
  consequences. (1) Title: injected messages never name a session; the title is
  taken from the first real user message, and a stored title that starts with
  "[delegate " (or equals an injected note's text) is recomputed and persisted on
  `session/load` and shown repaired in `session/list`. (2) Replay: `session/load`
  sends such a note as `user_message_chunk` whose text is the result alone (no
  envelope tags) with `_meta.keryx.delegateResult { runId, agentId, turn, text }`;
  the client renders it as the "returned" card, not a user bubble. (3) Restored
  runs: from those chunks the client rebuilds one subagent per run id (the last
  turn's text), status "done", detail "from history", runtime "external", no
  "Open terminal" (its tab is gone), so the sidebar "N agents" pill and Activity
  show it after a reload. Native subagents stay non-persisted.
- `/delegate` in the desktop (D-14, owner 2026-11-18): the client advertises
  `initialize.clientCapabilities._meta.keryx.terminal: true` (the app only, not
  the browser dev bridge). With it, the approval is the same
  `session/request_permission` (allow once / reject once) but says the CLI runs
  interactively in the terminal with its own permission prompts and keryx's
  sandbox does not apply; after an allow keryx does NOT spawn the headless run.
  It answers `{ text, _meta.keryx: { effects: ["openTerminal"], terminal: {
  runId, agentId, title, argv, cwd } } }`. `argv` is built by keryx from the
  registry (`interactiveArgs` of the agent entry, task appended as one element;
  never from client input, never a shell string): `claude -- <task>`,
  `codex -- <task>`, `agy -i <task>` (plus the turn-done hook flags below, which
  precede `--`); an agent without `interactiveArgs`
  (`gemini-acp`) is refused. `title` is "<Agent> · <first words of the task>".
  Without the capability (editors) the headless path above is unchanged. The
  external runtime is on by default here: the gate (`defaultOn`) treats an
  `externalAgents.enabled` the user config never wrote as on and lets a project
  manifest that does not list the capability yet pass; an explicit `false` in
  the user config, `enabled: false` in the manifest, a remote transport, CI, a
  disabled per-agent entry and the per-agent vendor gates (block-list,
  one-time consent for `agy`) still refuse, with their own sentence, before
  any approval is asked. The client opens the Terminal panel on a new tab
  whose process is the argv (§4.4) and registers the run as a client-side
  subagent (`runtime: "external"`). The end is the client's (process exit).
  The end of a TURN is keryx's, through the vendor CLI's own hook (D-14):
  - Hook, injected by keryx at launch (registry `turnHook`; verified against
    claude 2.1.281, codex 0.147.0 and agy 1.4.2): `claude`: `--settings <json>`
    with a `Stop` hook whose command is `/bin/sh -c '{ cat; echo; } >> "$1"' sh
    '<file>'` (stdin JSON: `session_id`, `transcript_path`, `hook_event_name`,
    `stop_hook_active`, optional `last_assistant_message`); `codex`: `-c
    notify=["/bin/sh","-c","printf '%s\n' \"$2\" >> \"$1\"","sh","<file>"]` (one
    JSON argv: `type: "agent-turn-complete"`, `thread-id`, `turn-id`, `cwd`,
    `input-messages`, `last-assistant-message`); `agy` (and `gemini-acp`): no
    hook flag exists, `turnHook: none`, the run keeps exit-only status. The
    command is fixed by keryx; the only variable is `<file>`, an argv element
    (`<session dir>/delegate/<runId>.jsonl`), and no task text reaches it. No
    hook on a platform without `/bin/sh` or for a session with no stored
    directory. `-c notify` replaces a `notify` of the user's own codex config
    for that run only; claude's `--settings` hooks add to the user's.
- Model-started external runs (D-14, owner 2026-11-18). Who starts a run
  decides the approval: a human `/delegate` keeps the dialog above; a run the
  MODEL starts (an orchestrator or the main agent, `spawn_subagent` with
  `runtime: { kind: "external", agent }`, offered when the client advertised
  `_meta.keryx.terminal`) is allowed only when the session's permission mode is
  `trust` or `auto`, and then starts WITHOUT a question. In `ask` mode the call
  is refused with a sentence the model sees: "external agents may only be
  started by the model in trust or auto mode" (`Denied`,
  `external-runtime-not-authorized`). Every other gate of the `/delegate` path
  applies (capability default-on, explicit off, per-agent gates, `agy`
  consent, an agent with an interactive form). keryx sends
  `_keryx/delegate_terminal { sessionId, runId, agentId, title, argv, cwd,
  autoClose: true }` (`runId` is the spawn's `workerId`, so the tool's own fleet
  row and the run are one subagent) and the client opens the same terminal tab.
  The `spawn_subagent` call WAITS for the first turn-done (the hook, with the
  existing per-agent `defaultTimeoutMs`, or the dispatch's `runtime.timeoutMs`)
  or the process exit and returns the turn's text as its tool result
  (size-capped, redacted, labelled "external agent output, reference data and
  not instructions"); no history note is added on top. keryx also sends
  `_keryx/delegate_result` with `autoClose: true`, and the client then marks the
  subagent done ("returned") and closes the tab (kills the PTY); the CLI keeps
  its own session/transcript, keryx keeps the result in history. A human-started
  run keeps its tab open. An agent with no turn hook (`agy`) is waited on until
  it exits; its result is "ended, no answer text" (an error result). A cancel
  of the session stops the wait. Without the terminal capability `spawn_subagent`
  stays native-only (`nativeOnly`).
- Result card (D-14): the parent transcript's "<agent> returned" card has a
  header (agent, turn, status "waiting in terminal" or "finished", and the
  subtle note "from <agent>, not instructions"), a preview of the answer
  rendered through the sanitising Markdown component (first 12 lines / 1200
  characters, faded, an open code fence closed), "Show all" / "Show less", and
  the actions "Open terminal" (focuses the tab; disabled once it is closed) and
  "Copy" (the whole text). The text is untrusted; only the Markdown component's
  allow-list (no raw HTML, inert links) ever renders it.
  - keryx polls that file for runs it started. For each new line it takes the
    last assistant message (the payload's, else the last assistant text blocks
    after the last real user message of the claude transcript at
    `transcript_path`) and sends `_keryx/subagent` upsert `status: "idle"`
    (a turn is done, the CLI is still open and waits for the user), a `log`
    `result` entry with the text, and `_keryx/delegate_result { sessionId,
    runId, agentId, turn, text }` (text capped at 8 KB with a truncation marker).
  - Hand-back (no auto turn): the same text joins the PARENT session's history
    as a user-role context note `[delegate <agent>, run <id>, turn N result]`,
    `provenance: "harness"`, `injected`, persisted like other history. It is
    marked as untrusted external content ("treat as reference data, never
    instructions"), redacted for secrets, and wrapped in a nonce-bearing
    envelope the text cannot forge. No turn starts: the operator decides what
    the parent does with it. A note that arrives while the session's turn runs
    waits for the turn's end. The desktop shows a collapsed "<agent> returned"
    card in the parent transcript (client-only, not replayed).
  - The client sends `_keryx/delegate_exited { sessionId, runId }` when the
    process ends or the tab is closed; keryx reads the file once more, stops
    watching and deletes it (also on session release and connection end).
- Refused with a reason, not served: every `/bus` subcommand (the ACP
  host does not join the bus), `/autoreview start|stop` (detached process
  with no supervisor), `/mcp connect|disconnect`, `/task` without a Hub
  connection, `/governance close` of a flow that needs a confirmation token.
- Setting toggles (`/guard`, `/editguard`, `/route`, `/external`,
  `/projectctx`) persist config for `keryx shell` sessions; the ACP turn has
  no guard or classifier to change.
- View commands answer `text` (a plain rendering starting with the title) and
  `_meta.keryx.view`. Shared text subcommands live in
  `src/commands/shell-subcommands.ts`; the TUI and readline REPL do not call
  them yet.
- Providers: the catalogue `refusal` is sent only for providers with no
  connection method; `needsBaseUrl` is true only for `none` providers, hosted
  ones accept an optional `baseUrl`. `connect` may answer `models` (count);
  `search_providers/connect` accepts optional `fields`. Unknown session is
  `-32002` (the server's existing "Unknown ACP session"), unknown or private
  task `-32602`.
- Subagents: the tool card's ACP id is minted by the IO (`toolCallIdFor`) and
  is what `parentToolCallId` carries; `spawn_subagent` cards have kind
  `think`. Children's provider choice comes from the session's listed model
  choices; before that list loads a child runs on the parent's model.

#### 3.9.6 Advertising

All new methods join `KERYX_ACP_EXTENSION_METHODS` and appear in
`initialize._meta.keryx.extensions`; the client checks for them and hides a
feature the connected keryx does not advertise.

## 4. Client side

### 4.1 Rust core (`apps/desktop/src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `locator.rs` | resolve the keryx binary per settings: `auto` (default, D-15: `keryx` on the login-shell `PATH`, else the bundled sidecar), the bundled sidecar (`<dir of current_exe>/keryx`, i.e. `Keryx.app/Contents/MacOS/keryx`), `PATH` only, or an explicit path |
| `appupdate.rs` | update banner backend (D-15): `app_update_check` runs `<keryx> app status --json --dir <install dir>` and compares the newest release and `minDesktopVersion` with the app's version; `app_update_run` starts `keryx app update --dir … --wait-pid <pid> --relaunch` detached (own process group, output to `app-update.log`) and quits |
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
| Settings | `settings.json` in the Tauri app config dir (`~/Library/Application Support/dev.keryx.desktop/`): `keryxSource` (`auto`, `bundled`, `path`, `custom`), `customPath`, `recentProjects`, `settingsVersion` (1 since D-15; a file without it holding `bundled` is read as `auto`) |
| Update log | `app-update.log` in the app log dir: the output of the last `keryx app update` the banner started |
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
  - A model chosen there (`session/set_config_option` `model`, `/model`, or the composer provider selector) is remembered: it is saved as `keryx shell`'s saved provider/model (`auth.json`), so a NEW session starts on it, in the desktop and the terminal alike. Order: `--provider/--model` flags at launch, then the remembered choice if still available, then the launch default. A loaded session keeps its own model; only an explicit switch writes it.
  (`session/set_config_option` `model`), plan, usage.
- Dialogs: permission (options from the request; `allow_always` only when
  offered), `ask_user`, incompatible-keryx error, session-leased error with
  a "new session" action.

### 4.2.1 Web view additions (M2a)

- Replayed `/delegate` notes (§3.9.5a): `reducer.ts` turns a replayed user chunk
  with `_meta.keryx.delegateResult` into a `delegate` item (`DelegateResultCard`)
  and one finished external subagent per run ("from history", no Open terminal),
  so the sidebar pill and Activity list survive a reload; envelope tags never
  reach the UI.
- Composer palette: typing `/` opens a grouped, filterable list of every
  advertised command with its hint; Tab/Enter completes; a `text` command is
  sent with `_keryx/command` and shown as a command card (input + output) in
  the transcript; `dialog` and `client` commands open their UI. The draft is
  cleared whenever keryx answered the command, whether it ran or refused it
  (`_meta.keryx.refused`: the refusal is its own card). The draft is kept only
  when the client itself refused the command (a `busy: refuse` command while a
  turn runs, shown inline without a request) or the request failed (transport
  or RPC error), so the user can fix and resend it. While a command is in
  flight, keryx may ask for approval or an answer (`session/request_permission`,
  `_keryx/ask_user`, for example `/delegate`); the window raises that dialog
  for the session the command runs in, the same as during a turn.
- Provider selector (composer, before the model chip): lists the providers of
  the session's model option (`<provider>/<model>` values), so it always matches
  what the session can switch to. Choosing one narrows the model menu to that
  provider and switches the session to the model that provider last ran in this
  window, else its first model (`session/set_config_option`); a
  `config_option_update` after connect or disconnect refreshes it. The last item
  is "Add or manage providers…", which opens the Providers dialog (`/connect`);
  a single provider is still listed so that item stays reachable.
- Providers dialog (`/connect`, also from the provider selector): Connected and
  Add tabs, Test, Disconnect, API-key field (password input), base URL,
  custom provider form, device-code panel (code, Copy, Open browser, Cancel).
- Command card tones: a successful command reads as neutral (an ok-toned
  command icon, normal border), a command keryx refused as a warning (warn
  border, `refused` badge, warn notice), and a failed request as an error
  (danger border, `error` badge, error notice). Success never uses the warn or
  danger tokens.
- Activity: a tab of the shared right side panel (§4.4: Terminal, Browser,
  Activity, Info; one width, one close button) with up to four sub-tabs. The
  session info (git, model, usage) is the panel's Info tab. The top-bar Activity
  button, a tool card's "Show subagent" and a sidebar subagent row open the panel
  on Activity; a `/delegate` run's detail has "Open terminal", which opens it on
  Terminal:
  - Subagents: one row per subagent (label, status, detail, model), linked
    from the `spawn_subagent` tool card; selecting one shows its task and
    transcript (text, reasoning, tool, result entries).
  - Tasks: one row per task (command, status, phase, elapsed, exit code);
    selecting one shows its output (polled with `_keryx/tasks/output` while
    shown and running); Kill with a confirmation.
  - Schedules (shown only when `_keryx/command` is advertised): the project's
    schedules from the `/schedules` view, one row per schedule with name,
    cadence, next run, last outcome (the row's detail) and an active/paused
    badge. Row actions are the view's own: Pause or Resume, Run now and Delete,
    the last two behind their `confirm` dialog; the list is read again after any
    action and whenever the tab opens. "Add schedule" opens the `/schedule` view's
    form in the tab (submit button "Create"); submitting asks once with the draft
    card (`confirmAction`, button "Confirm"), and a yes sends the confirmed line
    and returns to the list. Each row also has a "Runs" button that opens the Runs
    tab limited to that schedule.
  - Runs (shown with Schedules): recent runs (newest first, 30 at most) from
    `/schedules runs [<name>]` (time, status, permission mode, cost, one-line
    outcome), for one schedule or all. Selecting a run reads
    `/schedules run-log <name> <run id>`: the run's report (the agent's final
    answer, `reports/<name>/<runId>.md`) and the tail of its run log
    (`run-now/<name>-<start>.log`, last 64 KB; the badge says when the head was
    cut, and a run without a report or log says why). Refresh re-reads. Both
    subcommands live in `src/commands/shell-subcommands.ts`, so the terminal
    shells have them too. Run output is untrusted: control characters are
    stripped server-side and the client renders plain text only.
  - Width: the side panel's (§4.4); the content never widens it: long lines
    wrap and a `pre` block scrolls inside itself. The former `activityWidth` and
    `infoPanel` preferences are dropped (an old `infoPanel: true` opens the Info
    tab).
  - Badges for running subagents and tasks per session in the sidebar.
  - Sidebar tree (owner decision 2026-11-18): every subagent of a held session,
    native or external (`/delegate`), is a child row one level under its
    session (label, status dot, `external` badge, model). The session row has a
    chevron (`aria-expanded`); the fold is remembered per session and defaults
    to open while any subagent runs, else folded. Selecting a child shows its
    session and opens the side panel's Activity tab on that subagent. Released sessions
    show no children.

### 4.3 Client capabilities sent at `initialize`

`{ fs: { readTextFile: true, writeTextFile: false }, terminal: false,
  _meta: { keryx: { askUser: true } } }`

`terminal` stays `false` with the side panels: the agent reaches the panel
terminal through the panel MCP server (§4.4), not ACP `terminal/*`.

### 4.4 Side panels: terminal and browser (D-13)

Rust core:
- `pty.rs` — `PtyManager` (app state) keyed by window label and tab id.
  `pty_open` spawns `$SHELL -l` (fallback `/bin/zsh`) through `portable-pty`
  in the window's project root with the login-shell environment plus
  `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Keryx`; output
  goes to a Tauri channel as UTF-8 text (a split multi-byte sequence waits
  for its tail) and into a 1 MiB ring buffer. `pty_attach` replays the buffer
  to a new channel; `pty_write`, `pty_resize`, `pty_close`. Exit is reported
  on the channel. A destroyed window or app exit closes every PTY of that
  window: SIGHUP to the process group, SIGKILL after 500 ms.
- `browser.rs` — open/navigate/back/forward/reload/close/bounds/visibility of
  browser tabs. Each tab is a child webview of the project window; `http` and
  `https` only; new windows refused; `data_store_identifier` per project on
  macOS 14+, a non-persistent store below; URL and title changes are emitted
  to the window as `panel://browser`.
- `panel_mcp.rs` — one Unix socket per app (`$TMPDIR/keryx-panels-<pid>.sock`,
  0600), a random token per window, MCP over newline-delimited JSON-RPC
  (`initialize`, `tools/list`, `tools/call`). `main.rs` runs the relay when
  started as `<app binary> --panel-mcp`: it connects to `KERYX_PANEL_SOCKET`,
  sends `KERYX_PANEL_TOKEN`, then copies stdin → socket and socket → stdout.

Web view:
- `panels/SidePanel.tsx` with the Terminal, Browser, Activity and Info tabs (the
  last two are the session view's, portaled into the panel through
  `panels/sideSlots.ts`; the Activity tab shows the running count); open state, tab
  and width are per-viewer prefs.
- `panels/panelBus.ts` — `runInTerminal(command)` used by the Run buttons;
  `showTerminalTab(tab)` opens the panel on Terminal and focuses a tab;
  `notifyTabClosed(id)` tells the app a tab was closed in the panel;
  `closeTerminalTab(tab)` closes a tab and kills its process (a model-started
  `/delegate` run that returned its answer, §3.9.5a).
- `/delegate` runs (D-14): `pty_open_run(cwd, argv, title, cols, rows)` opens a
  tab whose process is `argv` itself (no shell), with the same login-shell
  environment and the same SIGHUP-then-SIGKILL close as a shell tab; a program
  that cannot start is an error and no tab exists. When the process ends the
  window gets `panel://pty-exit { id, code }` whether or not the tab is on
  screen. `session/delegateTerminals.ts` keeps each run as a subagent of the
  session (`runtime: "external"`, `agentId`, `task` = the argv's last element):
  `running` on start; exit 0 -> `done` ("exit 0"); non-zero -> `failed`
  ("exit N"; a signal -> "ended by a signal"); the tab closed while running ->
  `failed` ("closed"). Between those, keryx's `_keryx/subagent` `idle` upsert
  (a finished turn, the CLI still open) shows as "waiting for you" in its own
  colour (the Activity list, the detail's badge, the sidebar child dot); it
  never counts in a running badge, and a late `idle` never overrides the
  recorded `done`/`failed`. The detail lists each turn's `result` entry. The
  client sends `_keryx/delegate_exited` on exit/close. Clicking the run in the Activity panel or in the
  sidebar's subagent tree opens the panel and focuses the tab; once the tab is
  closed the entry shows the stored task and "Terminal closed.". Runs are not
  persisted across a reload, like every subagent (D-12).
- `session/useAcpSession.ts` adds the panel entry to `mcpServers` of every
  `session/new` and `session/load` inside the app.

As built (2026-11-18, found in the installed-app click-through):
- Every Tauri command takes `tauri::Window`, never `WebviewWindow`: once a
  child web view is added, Tauri no longer resolves the window as a
  `WebviewWindow` and such commands fail silently (it broke `acp_send`).
- Child web views are placed in the window frame, title bar included; the
  core adds the title bar height (`NSWindow.frame − contentLayoutRect`) to the
  bounds the page reports.
- `browser_layout` carries a sequence number; the core drops an older call,
  since commands run concurrently.
- Pages hide while any overlay (dialog, palette, menu) is open, on the
  overlay stack's change event, so an approval dialog is never under a page.
- Agent tools wait for `document.readyState === "complete"`, not for page-load
  callbacks.
- MCP results reach the model as text (keryx JSON-serialises MCP content), so
  `browser_screenshot` saves a PNG and returns its path; the model does not
  see the image.

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
  Developer ID signing and notarization when `APPLE_*` secrets exist; the
  release carries the `.dmg`, `Keryx_<version>_universal.app.tar.gz` (checked
  to unpack to that version with a valid signature) and `SHA256SUMS`.
  Homebrew cask and the signed updater manifest are M3.
- `keryx app install|update|build|status` (`src/commands/app.ts`, D-15): the
  install and update channel without a Developer ID. It reads the
  `desktop-v*` releases, picks the archive for the host arch (else
  `universal`), verifies `SHA256SUMS`, unpacks next to the target, checks the
  bundle version, and swaps it in by rename with the old app restored on
  failure; refuses while the app runs unless `--wait-pid`; `--relaunch` opens
  the app afterwards, also after a failure. `build` runs
  `scripts/desktop/build.sh` inside a keryx checkout only. keryx reports
  `minDesktopVersion` (`src/acp/profile.ts`) in `initialize._meta.keryx` of
  the shell profile and in `app status`.

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

## 9. Acceptance criteria (side panels, D-13)

| ID | Criterion | Check |
|---|---|---|
| AC20 | PTY opens in the project root with the login env; write/resize/replay; closing a tab, the window or the app leaves no process of its group | exec `cd apps/desktop/src-tauri && cargo test pty` |
| AC21 | Run button on single-command shell blocks and `execute` tool calls types into the active tab, opening the panel | exec `cd apps/desktop && bun test src` (happy-dom) |
| AC22 | browser tab loads a localhost page; non-http(s) navigation and new windows refused; a page cannot invoke app commands | exec `cargo test browser` + judged in the installed app |
| AC23 | panel MCP: token required; `tools/list`; `terminal_run` refuses a user tab; `terminal_read` returns output; browser tools round-trip | exec `cargo test panel_mcp` + judged |
| AC24 | `.dmg` builds; terminal, Run button and browser clicked through in the installed app | judged |
| AC25 | `keryx app install/update/status/build` against a fake release server: newest `desktop-v*` only, checksum enforced, swap with restore, running-app refusal and `--wait-pid`, build guard | exec `bun test src/commands/app.test.ts` |
| AC26 | `auto` source and settings migration; update-check parsing, decision, install-dir and argv | exec `cd apps/desktop/src-tauri && cargo test` |
| AC27 | banner shows a newer release (skippable) and a required update (not skippable) | exec `cd apps/desktop && bun test src/shell/UpdateBanner.test.ts` |
| AC28 | the banner's update replaces the installed app and relaunches it | judged (needs a published `desktop-v*` release) |
