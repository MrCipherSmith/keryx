# Keryx for VS Code

A visual layer over the `keryx` CLI: project status, an activity-bar
sidebar, live turn events, and wiki-aware hovers — without leaving the
editor.

This extension is a **client**, not a second implementation of keryx. Every
action it takes shells out to the same `keryx` CLI you'd run in a terminal
(`keryx status`, `keryx init`, `keryx projects list --json`, `keryx
sessions list --json`, `keryx flow list --json`, `keryx workspace catch-up
--json`, `health status`, `security status`). It never re-implements
keryx's own logic — it renders what the CLI already knows.

## What it does

- **Auto-detect + offer init.** On activation, the extension runs `keryx
  status` for the open workspace. If the project isn't initialized, or the
  `.metaproject/` scaffold is incomplete, it asks — never silently — before
  running `keryx init --yes`. Decline, and nothing changes.
- **Status bar.** A status bar item shows the combined health of
  `keryx status` / `health status` / `security status`. Click it to see
  exactly which check is failing, by name — never just a color change with
  no explanation.
- **Sidebar (Keryx icon in the Activity Bar), four views:**
  - **Status** — the same information as the status bar, expanded.
  - **Projects** — every project keryx knows about on this machine
    (`keryx projects list --json`).
  - **Recent Turns** — the latest agent sessions for this project
    (`keryx sessions list --json`).
  - **Needs Your Attention** — in-progress Task Manager flows merged with
    pending SAC review proposals (`keryx flow list --json` +
    `keryx workspace catch-up --json`). Empty and says so explicitly when
    there's genuinely nothing to review — never a blank, ambiguous panel.
- **Output channel.** Streams live turn events over Server-Sent Events
  (resumable via `Last-Event-ID` if the connection drops) and logs exactly
  one audit line per mutating action the extension takes, whether it
  succeeded or failed.
- **Hover provider.** Hovering a symbol shows a `keryx wiki ask` snippet
  for it, debounced and cached per file. Renders a staleness indicator when
  the underlying wiki response provides one; says nothing about
  staleness rather than fabricating a claim when it doesn't.
- **Version check.** Compares your installed `keryx --version` against the
  extension's declared minimum and warns (non-blocking) if it's behind.

## Commands

| Command | What it does |
|---|---|
| **Keryx: Initialize Project** | Runs `keryx init --yes` for the open workspace. |
| **Keryx: Refresh** | Re-runs every status/list check and repaints the sidebar. |

## Install it locally (for development, or to try it before it's on a marketplace)

```bash
cd vscode-extension
bun install
bun run install:vscode   # packages with vsce, then `code --install-extension`
bun run install:cursor   # same, for Cursor
```

Reload the window afterward (Command Palette → "Developer: Reload Window")
to pick up a rebuilt install — installing a new `.vsix` over a running
extension host does not hot-swap it.

## Requirements

- `keryx` on `PATH` — install via `npm install -g @mrciphersmith/keryx`, the
  standalone binary (`scripts/install-binary.sh` in the main repo), or
  Homebrew (`MrCipherSmith/homebrew-keryx`).
- A project you want visibility into. The extension works on any workspace
  folder; it prompts to initialize one that isn't a keryx project yet.
- **A GUI-launched editor (Dock/Spotlight/Finder) does not inherit your
  shell's PATH.** If `keryx` is managed by nvm/asdf/similar (only added to
  PATH by your shell's profile), the extension will fail its first check
  with "The `keryx` CLI was not found on PATH" even though it works fine
  from a terminal. Fix once, permanently, for every GUI app:
  `sudo ln -s "$(which keryx)" /usr/local/bin/keryx` (macOS/Linux;
  `/usr/local/bin` is on the default system PATH every GUI process gets).
  Or launch the editor from a terminal where `keryx` already resolves
  (`code .` / `cursor .`) instead.

## Also: VS Code's own MCP client

Independently of this extension, `keryx mcp install --runtime vscode`
registers keryx as an MCP server directly with VS Code (writes
`.vscode/mcp.json`), so VS Code's native MCP client — including GitHub
Copilot Chat's agent mode — can call keryx's tools (gdgraph, wiki, health,
memory, flow, security, and more) without this extension's UI at all. The
extension and the MCP registration are complementary, not alternatives:
the extension gives you a visual dashboard; the MCP registration gives an
AI chat agent direct tool access.

## Architecture note (for contributors)

Every piece of decision logic — status interpretation, severity/icon
selection, tree-view node shaping, SSE event parsing, audit-log
classification, hover markdown rendering — lives in a `*-logic.ts` module
with zero `vscode` import, and is unit-tested outside any VS Code host
(`bun test src`, from this directory). The `vscode`-importing files
(`extension.ts`, `status-bar.ts`, `tree-view.ts`, `hover-provider.ts`,
`output-channel.ts`) are thin adapters over that logic — if you're
extending behavior, the logic module is almost always the right place to
start, not the VS Code-facing wrapper.

## Known gaps

No VS Code CLI (`code`) or `vsce` was available while building this
extension, so real Copilot Chat tool-call verification and `vsce
package`/Marketplace validation are open follow-ups, not yet confirmed
against a real VS Code instance. Everything else — TypeScript correctness,
unit-tested logic, manifest schema correctness — is built and verified.
`keryx wiki ask` doesn't yet expose a staleness/content-hash field to the
hover provider (`src/wiki/staleness.ts` exists but is currently scoped
only to `wiki enrich`'s resume pipeline) — the hover UI is built
forward-compatible for when that lands.
