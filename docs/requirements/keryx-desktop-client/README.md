# Keryx Desktop Client (macOS)
Version: 0.2.0

## Purpose

A native macOS desktop application for keryx, written in Rust on Tauri v2,
that drives a full `keryx shell`-grade agent session through the Agent
Client Protocol. The application is a client: the agent, policy engine,
sandbox, session store and tools stay inside keryx. The Rust side owns the
`keryx acp` child process, the stdio transport and the macOS integration;
the web view owns rendering.

Parity with the OpenTUI shell is reached in three milestones. Most of the
parity work is on the keryx side: `keryx acp` today is a deliberately
narrowed editor agent, and it gains a `shell` profile that offers the
shell's own tool roster, permission modes and keryx extensions.

## Status

**M1 implemented on `feat/desktop-client`, not merged, owner acceptance
pending.** AC1–AC10 and FB1–FB2 pass their commands (`bun test src/acp/`,
`cargo test`, `bun run build`, `bun run desktop:build` producing an arm64
`.dmg`). AC11 (a real turn with an approved `shell_exec` in the installed
app) and FB3/FB4 through the app's buttons are judged criteria: the UI was
exercised in the browser dev mode against a real `keryx acp`, and the
bundled sidecar answered the shell-profile handshake, but no click-through of
the installed `.app` has been done. M2 and M3 are not started. The legacy
`keryx acp` behaviour this package started from is `src/acp/*` on
`origin/main` at 0.4.32.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Architecture, `keryx acp --profile shell` contract, `_keryx/*` extensions, client structure, packaging, acceptance criteria. |
| [decisions.md](decisions.md) | Owner decisions taken on 2026-11-17 with the options that were rejected. |
| [implementation-plan.md](implementation-plan.md) | Milestones M1–M3, the parity matrix and task breakdown. |
| [flows-board.md](flows-board.md) | The local Flows board: data source, lanes, detail panel, allowlisted actions. |

## Scope

- M1: chat with streaming, reasoning and tool calls; approvals; ask/trust/auto
  modes; `ask_user`; execution plan; usage; session list/load/new; model
  switching; project folder selection; bundled keryx sidecar; local `.dmg`.
- M2: image prompts (depends on flow 493 landing on main), subagent
  inspector, background shell tasks, rewind, compact, queue, sidebar cards,
  the full slash-command set.
- M3: remote-control and Team Hub toggles, Developer ID signing and
  notarization, Homebrew cask, auto-update.

## Non-goals

- Mac App Store distribution: its App Sandbox forbids the child processes
  keryx runs in a project.
- Windows and Linux builds. Tauri allows them later; nothing here targets them.
- Reimplementing any agent logic in Rust.
- Attaching to a session a running `keryx shell` holds (the lease refuses it;
  the client offers fork or view instead, as the shell does).

## Related Modules

- [keryx-desktop-app](../keryx-desktop-app/README.md) — the Hub-based work
  loop (task, stages, diff). Same Tauri application, later window; see
  decisions D-08.

- `src/acp/` — the ACP agent this client drives.
- `src/commands/acp.ts` — `keryx acp` entry point and flags.
- `src/commands/interactive-agent-tools.ts` — the shell roster the `shell` profile reuses.
- `src/session/` — session store, lease, compact, rewind.
- `docs/requirements/keryx-native-distribution/` — the compiled keryx binaries the app bundles.
- `docs/requirements/keryx-vscode-extension/` — the other keryx client, built on `keryx serve`.
