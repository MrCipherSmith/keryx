---
Title: Module vscode-extension/src
Version: 1.0.1
Type: component
Status: accepted
Summary: "`vscode-extension/src` groups 22 file(s). Exposes 8 public symbol(s)."
---

# Module vscode-extension/src

## Summary

`vscode-extension/src` groups 22 file(s). Exposes 8 public symbol(s).

## Overview

The module is the source of the Keryx VS Code extension. It owns the activation lifecycle and turns the output of the `keryx` CLI into editor behavior: an initialization prompt, a status-bar item, tree views, a hover provider, an output channel with audit lines, and an advisory version check. `activate` and `deactivate` are the only public boundary with VS Code. Decision logic lives in `*-logic.ts` files that do not import `vscode`, so they can be unit-tested with `bun test`.

## How it works

The module is split into three layers.

- **Thin `vscode` shell.** `extension.ts` is the composition point. It wires commands, tree views, the hover provider, the status bar and the output channel, and delegates every decision to the pure modules. Its header notes that it is not exercised by the test suite, so it is backed only by static and manual review.
- **Pure logic.** `status-logic.ts` holds the status model: `interpretStatus` reads the first line of `keryx status` and maps it to `KeryxStatusState`, with unrecognised output falling back to `"incomplete"`. The same layer contains `status-bar-logic.ts`, `tree-view-logic.ts`, `hover-logic.ts`, `version-logic.ts`, `output-channel-logic.ts` and `audit-log.ts`. `audit-log.ts` owns the one-line audit format through `formatAuditLine`.
- **CLI I/O seam.** `keryx-cli.ts` exposes `runKeryx`, which runs the `keryx` binary through `execFile`. A non-zero exit comes back as a result with `exitCode`, not as a thrown error, because callers read the exit code as a signal. A missing binary is raised as `KeryxBinaryNotFoundError`, and an aborted call as `KeryxAbortedError`.

The `vscode` adapters sit between these layers. `status-bar.ts` (`KeryxStatusBar`) polls every 60 seconds and skips a tick while a refresh is still running. Each refresh runs three CLI calls (`status`, `health status`, `security status`) and feeds their parsed output into `status-bar-logic.ts`. `tree-view.ts` provides the status, projects and recent-turns tree providers. `output-channel.ts` provides `KeryxOutputChannel`, whose `audit` method writes the audit lines. The registered commands are `keryx.init`, `keryx.refresh` and `keryx.runInTerminal` (`RUN_IN_TERMINAL_COMMAND`), which opens a fresh terminal for each tree-item click.

## Key concepts

- **Activation and deactivation.** VS Code calls `activate` when the extension starts and `deactivate` on shutdown. `deactivate` clears module state, and disposables are released through `context.subscriptions`.
- **`KeryxStatusState`.** The three-value readiness model (`"not-initialized"`, `"incomplete"`, `"ready"`) that every status-driven feature reads.
- **Init prompt.** `shouldPromptInit` is true for `"not-initialized"` and `"incomplete"`, and false for `"ready"`. `initPromptMessage` supplies the text. The extension never runs `keryx init --yes` on its own; it runs only when the user clicks "Run keryx init".
- **Post-initialization outcome.** `shouldRevealAfterInit` is true only when the init exit code is 0 and the status afterwards is `"ready"`. `initSucceededButNotReadyMessage` covers the case where init exits 0 but the workspace is still not ready, so the user is never left without feedback.
- **Audit line.** Each mutating action is recorded as one line, `[timestamp] actor=... action=... outcome=...`, with an optional `detail`. The actor is `"user"` or `"extension"`.
- **Turn-event rendering.** `output-channel-logic.ts` parses SSE bodies (`parseSseBody`) and renders events as single lines (`formatTurnEventLine`).
- **Version advisory.** `MIN_KERYX_VERSION` is `0.2.0`. A binary below it produces a warning, but activation is never blocked.

## Main flows

### Extension activation flow

1. VS Code calls `activate`, which creates the output channel and registers the `keryx.init`, `keryx.refresh` and `keryx.runInTerminal` commands.
2. If no workspace folder is open, `activate` returns after registering the commands.
3. Otherwise it registers the hover provider, the tree views and the status bar. `createKeryxStatusBar` runs the first refresh before returning.
4. `runInitFlow` runs `keryx status` and passes the output to `interpretStatus` to decide whether to prompt.
5. After the init flow, `checkVersionAndWarn` runs `keryx --version` and warns if the version is below the minimum. A missing binary is reported once, by the init flow.

### Initialization prompt flow

1. `runInitFlow` calls `interpretStatus` on the output of `keryx status`.
2. If `shouldPromptInit` is false, the flow ends silently.
3. Otherwise `initPromptMessage` is shown with the buttons "Run keryx init" and "Not now".
4. Only the "Run keryx init" choice proceeds. It calls `runKeryx(["init", "--yes"])` from `keryx-cli.ts` and records an audit line for `keryx.init`.
5. The status is read again, and the new state decides the outcome in the next flow.

### Post-initialization reveal flow

1. `shouldRevealAfterInit` receives the init exit code and the post-init state.
2. If it is true, the tree providers are refreshed, the status bar is refreshed, and the Keryx view container is revealed.
3. Otherwise, a non-zero exit shows an error message with the first line of stderr, and the stderr is written to the output channel.
4. Otherwise, an exit of 0 that still leaves the workspace not ready shows `initSucceededButNotReadyMessage` and writes the same message to the output channel.

## Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `activate` | function | Public entry point called by VS Code when the extension activates |
| `deactivate` | function | Public exit point called by VS Code during extension shutdown |
| `KeryxStatusState` | type | The three-value readiness state (`not-initialized`, `incomplete`, `ready`) |
| `interpretStatus` | function | Maps the first line of `keryx status` output to `KeryxStatusState` |
| `shouldPromptInit` | function | Determines whether to prompt the user for initialization |
| `initPromptMessage` | function | Builds the initialization prompt message |
| `shouldRevealAfterInit` | function | Determines whether to reveal output after initialization |
| `initSucceededButNotReadyMessage` | function | Provides the message when initialization succeeds but the environment is not ready |

## Key files

| File | Imports | Imported by | Purpose |
|------|---------|-------------|---------|
| `extension.ts` | 8 | 0 | Main composition point, coordinates activation |
| `status-logic.ts` | 0 | 6 | Central shared dependency for status handling |
| `keryx-cli.ts` | 0 | 5 | Mediates Keryx CLI interactions |
| `audit-log.ts` | 0 | 4 | Audit-oriented logging |
| `output-channel-logic.ts` | 2 | 2 | Output presentation and formatting |
| `status-bar.ts` | 3 | 1 | Status-bar contribution |

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)

<!-- keryx:reference:begin v=1 hash=efa39834ced1957387bcdd9434d2f074ecf9cf8b7d2b03651506cfefcce71cd2 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `activate`
- `deactivate`
- `KeryxStatusState`
- `interpretStatus`
- `shouldPromptInit`
- `initPromptMessage`
- `shouldRevealAfterInit`
- `initSucceededButNotReadyMessage`

### Key files

- `vscode-extension/src/extension.ts` - imported by 0, imports 8
- `vscode-extension/src/status-logic.ts` - imported by 6, imports 0
- `vscode-extension/src/keryx-cli.ts` - imported by 5, imports 0
- `vscode-extension/src/audit-log.ts` - imported by 4, imports 0
- `vscode-extension/src/output-channel-logic.ts` - imported by 2, imports 2
- `vscode-extension/src/status-bar.ts` - imported by 1, imports 3

### Graph signals

- Files: 22
- Cross-module imports: 0
<!-- keryx:reference:end -->

## Changelog

- 1.0.1 - Reference and Related Wiki added from the code graph (the page predated them).
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Initial draft generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z.
- 0.1.0 - Enriched and marked accepted.
