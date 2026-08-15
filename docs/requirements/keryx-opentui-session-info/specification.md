# Keryx OpenTUI Session Info — Specification
Version: 0.1.0

## Identity and ownership

**Package id:** `keryx-opentui-session-info`.

| Concern | Owner | This package |
|---|---|---|
| Modal chrome / tabs | `keryx-opentui-modal-tabs` | Caller only |
| Session records | `src/session/store.ts` | Read `SessionSummary` + live handle |
| Slash registry | `src/commands/agent-commands.ts` | New entries |
| TUI dispatch | `src/tui/tui-shell.ts` / chrome | Open host; do not stream |
| Readline dispatch | `src/commands/shell.ts` | Text dump |
| Clipboard | existing `/copy` / OSC-52 helper | Reuse, do not fork |

**Depends on:** [keryx-opentui-modal-tabs](../keryx-opentui-modal-tabs/specification.md)
must be `implemented` (or land in the same stacked PR **after** the host
commit). This package must not introduce a private modal.

## Storage structure

No new files. Reads:

- Current `SessionHandle.summary` (`id`, `title`, `projectPath`,
  `createdAt`, `updatedAt`, `messageCount`, `archiveMessageCount`,
  `compactCount`, `provider`, `model`, `parentSessionId`).
- Live TUI selection (`TuiSelection`) when it has diverged from the
  summary (user just ran `/model`).
- Last `onUsage` payload if the IO recorded one this process.
- `package.json` `version` for the keryx version row.

Session files stay under the existing project session dir
(`projectSessionsDir`).

## Manifest / config

None.

## CLI or skill surface

### Slash (interactive)

| Token | Modes | Effect |
|---|---|---|
| `/session-info` | chat, agent | Open inspector (TUI) or print dump (readline) |
| `/status` | chat, agent | Alias |
| `/info` | chat, agent | Alias |

Not a `keryx` top-level command. `keryx sessions list` / `export` stay
as they are.

### TUI open

```ts
openModal({
  title: "Session",
  tabs: [
    { id: "session", label: "Session" },
    { id: "usage", label: "Usage" },
  ],
  initialTab: "session",
  renderTab: renderSessionInfoTab,
});
```

A later command must be able to open the **same** host on `usage` if we
add `/context` (Grok's `/context` is a sibling; **not** in v1).

## Data contracts

Painted rows, v1 Session tab:

| Row | Source | Notes |
|---|---|---|
| Title | `summary.title` | |
| Version | `package.json` version | keryx, not grok |
| Session id | `summary.id` | `c` copies this exact string |
| Project | `summary.projectPath` | |
| Provider | live selection ?? `summary.provider` | `—` if missing |
| Model | live selection ?? `summary.model` | `—` if missing |
| Parent | `summary.parentSessionId` | omit row if undefined |
| Created / Updated | summary ISO | display local or UTC; say which |
| Messages | `messageCount` / `archiveMessageCount` | |
| Compactions | `compactCount` | |
| Context | usage or estimate | label `estimate` when estimated |

Usage tab:

| Row | Source |
|---|---|
| Last turn input | `usage.inputTokens` or `—` |
| Last turn output | `usage.outputTokens` or `—` |
| Context estimate | `estimateContextTokens` |
| Context used / total / % | only when a real window is known |

Do **not** invent: auth method, API backend name, sandbox profile, model
hash, SuperGrok hints.

## Integration points

- Slash filter/prefix match already works; add names to
  `AGENT_SLASH_COMMANDS` and the `agent-commands.test.ts` expected list.
- `runLine` / `runShell` slash-first rule: handler must return before
  `provider.stream` (extend `shell-slash-registry.test.ts`).
- Overlay guard: host package.
- Clipboard: same helper block-nav `y` uses.
- Footer token label: unchanged; inspector does not replace it.

## Grok reference (map, do not clone blindly)

| Grok | Keryx v1 |
|---|---|
| `/session-info`, `/status`, `/info` | same tokens |
| Session info **tab** | Session tab on shared host |
| Title, version, session id, cwd, model | yes (keryx version, project path) |
| Auth method, sandbox, model hash | **no** |
| Context used/total/% | yes when known; else estimate |
| Click / drag copy | **no** (keyboard `c` / `y` only) |
| `/context` category breakdown | **out of v1** |

## Acceptance criteria

- **AC-1:** `/session-info`, `/status`, `/info` are in the agent and chat
  menus; each is handled without calling `provider.stream`.
- **AC-2:** TUI open uses `openModal` from the host package (import /
  call site test). A missing host is a build-time / review blocker, not
  a silent `overlayBox` fork.
- **AC-3:** Session tab shows id, project path, and provider/model that
  match the live session after `/model`.
- **AC-4:** Forked sessions show a Parent row; non-forks omit it.
- **AC-5:** `c` copies `summary.id`; `y` copies a multi-line text that
  includes that id.
- **AC-6:** Readline path prints the same rows and exits the command
  without opening OpenTUI.
- **AC-7:** Mid-turn invocation does not cancel the turn and does not
  queue a user message.
- **AC-8:** Estimated context is labelled so it cannot be read as billed
  tokens.

## Delivery order

1. Land [modal-tabs](../keryx-opentui-modal-tabs/README.md).
2. Land this package (registry + tab bodies + readline dump + tests).
3. Optional later: `/context`, mouse copy, `/model` on the same host.
