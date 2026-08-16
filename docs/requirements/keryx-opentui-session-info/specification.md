# Keryx OpenTUI Session Info — Specification
Version: 0.2.0

## Identity and ownership

**Package id:** `keryx-opentui-session-info`.

| Concern | Owner | This package |
|---|---|---|
| Modal chrome / tabs | `keryx-opentui-modal-tabs` | Caller only |
| Session records | `src/session/store.ts` | Read `SessionSummary` + live handle |
| Slash registry | `src/commands/agent-commands.ts` | `/status` only |
| TUI dispatch | `src/tui/session-info.ts` | `openSessionInfo` → `openModal` |
| Workspace / flow lines | `src/tui/inspector-sources.ts` | Shared with `/flows` |
| Readline dispatch | `src/commands/shell.ts` / chat shell | Text dump |
| Clipboard | existing OSC-52 helper | `c` copies session id |

**Depends on:** [keryx-opentui-modal-tabs](../keryx-opentui-modal-tabs/specification.md)
(`implemented`). This package must not introduce a private modal.

## Storage structure

No new files. Reads:

- Current `SessionHandle.summary` (`id`, `title`, `projectPath`,
  `createdAt`, `updatedAt`, `messageCount`, `archiveMessageCount`,
  `compactCount`, `provider`, `model`, `parentSessionId`).
- Live TUI selection (`TuiSelection`) when it has diverged from the
  summary (user just ran `/model`).
- Last `onUsage` payload if the IO recorded one this process.
- `package.json` `version` for the keryx version row.
- Session text / SAC workspace refs and flows whose `runLink.sessionId`
  matches, or that the session text mentioned (`flow 154`, `/flows 154`).

Session files stay under the existing project session dir
(`projectSessionsDir`).

## Manifest / config

None.

## CLI or skill surface

### Slash (interactive)

| Token | Modes | Effect |
|---|---|---|
| `/status` | chat, agent | Open inspector (TUI) or print dump (readline) |
| `/session-info` | — | **Removed.** Not an alias. |
| `/info` | — | **Removed.** Not an alias. |
| `/flows` | chat, agent | Sibling command (list + Detail). Not this package. |

Not a `keryx` top-level command. `keryx sessions list` / `export` and
`keryx status` (modules) stay as they are.

### TUI open

```ts
openModal({
  title: "/status",
  tabs: statusModalTabs(snapshot), // status, context, [workspaces], [flow]
  initialTab: "status",
  footer: SESSION_INFO_FOOTER, // c copy id · ←/→ tabs · esc close
  renderTab: renderSessionInfoTab,
});
```

Chrome is a fixed 72×18 panel (title + `[x] esc` header, one-line
footer). Tab switch must not shrink-wrap the host.

## Data contracts

Painted rows, Status tab:

| Row | Source | Notes |
|---|---|---|
| Title | `summary.title` | |
| Version | `package.json` version | keryx, not grok |
| Session id | `summary.id` | `c` copies this exact string |
| Project | `summary.projectPath` | |
| Provider | live selection ?? `summary.provider` | `—` if missing |
| Model | live selection ?? `summary.model` | `—` if missing |
| Parent | `summary.parentSessionId` | omit row if undefined |
| Created / Updated | summary ISO | |
| Messages | `messageCount` / `archiveMessageCount` | |
| Compactions | `compactCount` | |

Context tab:

| Row | Source |
|---|---|
| Last turn input | `usage.inputTokens` or `—` |
| Last turn output | `usage.outputTokens` or `—` |
| Context estimate | `estimateContextTokens`, labelled `estimate` |
| Context used / total / % | only when a real window is known |

Workspaces / Flow tabs (conditional): formatted lines from
`inspector-sources`. Omit the tab when the session has no such refs.

Do **not** invent: auth method, API backend name, sandbox profile, model
hash, SuperGrok hints.

## Integration points

- Slash filter/prefix match: `/status` and `/flows` in
  `AGENT_SLASH_COMMANDS` and `agent-commands.test.ts`.
- `runLine` / `runShell` slash-first rule: handler must return before
  `provider.stream` (`shell-slash-registry.test.ts`).
- Overlay guard: host package.
- Clipboard: `c` only on this surface.
- Footer token label: unchanged; inspector does not replace it.

## Grok reference (map, do not clone blindly)

| Grok | Keryx shipped |
|---|---|
| `/session-info`, `/status`, `/info` | **`/status` only** |
| Session info **tab** | Status + Context; optional Workspaces / Flow |
| Title, version, session id, cwd, model | yes (keryx version, project path) |
| Auth method, sandbox, model hash | **no** |
| Context used/total/% | yes when known; else labelled estimate |
| Click / drag copy | **no** (keyboard `c` only) |
| `/context` category breakdown | **out of scope** |

## Acceptance criteria

- **AC-1:** `/status` is in the agent and chat menus; `/session-info` and
  `/info` are not. The handler never calls `provider.stream`.
- **AC-2:** TUI open uses `openModal` from the host package. A missing
  host is a build-time / review blocker, not a silent `overlayBox` fork.
- **AC-3:** Status tab shows id, project path, and provider/model that
  match the live session after `/model`.
- **AC-4:** Forked sessions show a Parent row; non-forks omit it.
- **AC-5:** `c` copies `summary.id`.
- **AC-6:** Readline path prints the same rows and exits the command
  without opening OpenTUI.
- **AC-7:** Mid-turn invocation does not cancel the turn and does not
  queue a user message.
- **AC-8:** Estimated context is labelled so it cannot be read as billed
  tokens.
- **AC-9:** Workspaces / Flow tabs are absent unless the session
  referenced those objects.

## Delivery order

1. Land [modal-tabs](../keryx-opentui-modal-tabs/README.md). **Done.**
2. Land this package (registry + tab bodies + readline dump + tests). **Done** (0.2.36–0.2.37).
3. Optional later: mouse copy, `/model` on the same host.
