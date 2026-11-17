# Keryx Desktop Client — Specification
Version: 0.2.0

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
  pair; a qualified name both provide keeps keryx's.
- Tasks: the shell-task tools (`shell_task_output`/`wait`/`kill`) are offered
  in M1 because `shell_exec` is supervised; the task *panel* is M2. Workspace,
  Slate and working-memory tools are offered through the shell factory with
  the session directory bound.
- In auto mode an `ask_user` the model answers itself is reported to the
  client as an `agent_message_chunk` with `_meta.keryx.selfAnsweredQuestion: true`.
- The `shell` profile treats one active session per connection: when
  `session/new` or `session/load` switches to another session, the previous one
  is released (lease, shell tasks, per-session state; after its running turn,
  if any), so `keryx shell --resume` can open it. The `editor` profile keeps
  every session until the connection ends.

## 4. Client side

### 4.1 Rust core (`apps/desktop/src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `locator.rs` | resolve the keryx binary: bundled sidecar (`<dir of current_exe>/keryx`, i.e. `Keryx.app/Contents/MacOS/keryx`), `keryx` on the login-shell `PATH`, or an explicit path, per settings |
| `shellenv.rs` | capture the login-shell environment once (`$SHELL -ilc 'env -0'`, 5 s timeout) so GUI-launched keryx sees `PATH` and provider keys from shell rc files |
| `process.rs` | spawn `keryx acp --profile shell` in its own process group with the project folder as cwd; stop = close stdin, SIGTERM, wait 6.5 s, SIGKILL the group |
| `framing.rs` | newline-delimited JSON framing; oversized-line guard (16 MiB) |
| `bridge.rs` | Tauri commands `acp_start(cwd)`, `acp_send(message)`, `acp_stop()`; per-window start lock; emits `acp://message` and `acp://exit` events per window; stops run off the UI thread |
| `fs.rs` | answers `fs/read_text_file` on a worker thread inside the git toplevel of the opened folder (the same root keryx binds); 8 MiB cap; one error for every outside path. Defence in depth only — keryx's own tools never pass through it |
| `settings.rs` | settings |
| `version.rs` | semver compare against `MIN_KERYX_VERSION` (0.4.32) |
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
