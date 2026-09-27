---
Title: Module vscode-extension/src
Version: 0.1.0
Type: component
Status: draft
Summary: "`vscode-extension/src` groups 22 file(s). Exposes 8 public symbol(s)."
---

# Module vscode-extension/src

## Summary

`vscode-extension/src` groups 22 file(s). Exposes 8 public symbol(s).

## Overview

The module contains the source code for the VS Code extension. It owns the extension lifecycle entry points and the logic that turns Keryx-related state into user-visible behavior, such as status-bar presentation, initialization prompts, and output messages.

It exposes `activate` and `deactivate` as the extension boundary with VS Code, while separating status interpretation, command-line interaction, audit logging, and output formatting into focused files. The module is internally cohesive with no cross-module imports.

## How it works

`vscode-extension/src` is organized around a small public surface:

- **Extension lifecycle**:
  - `activate` is the public entry point used by VS Code when the extension becomes active.
  - `deactivate` is the public exit point used when the extension is shut down.

- **Status interpretation**:
  - `KeryxStatusState` represents the observable status state for Keryx-related features.
  - `interpretStatus` maps raw status information into that domain state.
  - `status-logic.ts` is a central shared dependency in the module, imported by six files and importing none.

- **Initialization prompting**:
  - `shouldPromptInit` determines whether the user should be asked to initialize Keryx.
  - `initPromptMessage` builds the message shown when initialization should be prompted.
  - `shouldRevealAfterInit` determines whether output or another view should be revealed after an initialization attempt.
  - `initSucceededButNotReadyMessage` provides the message for the case where initialization succeeded but the environment is still not fully ready.

- **Supporting layers**:
  - `extension.ts` acts as the main composition point, importing eight internal files and coordinating the public activation path.
  - `keryx-cli.ts` is used by multiple internal consumers and likely mediates interactions with the Keryx command-line interface.
  - `audit-log.ts` provides audit-oriented logging and is imported by four files.
  - `output-channel-logic.ts` supports output presentation or formatting and participates in bidirectional imports with two internal files.
  - `status-bar.ts` consumes status and presentation dependencies to contribute status-bar behavior.

The code graph indicates a layered but lightweight architecture: `status-logic.ts` and `keryx-cli.ts` are broadly depended on, while `extension.ts` coordinates the module's public behavior.

## Key concepts

- **Activation**: The lifecycle phase in which VS Code calls `activate` and the extension begins contributing behavior.
- **Deactivation**: The lifecycle phase in which VS Code calls `deactivate`, allowing the extension to clean up resources.
- **`KeryxStatusState`**: A public domain state used to describe the current Keryx-related situation for the extension UI.
- **Status interpretation**: The process of turning lower-level status signals into `KeryxStatusState` through `interpretStatus`.
- **Initialization prompt**: A decision and message pair produced by `shouldPromptInit` and `initPromptMessage` when the user should start or prepare a Keryx workflow.
- **Post-initialization guidance**: Behavior governed by `shouldRevealAfterInit` and `initSucceededButNotReadyMessage`, describing what should happen after an initialization attempt succeeds but the system remains not ready.
- **Output and audit support**: `output-channel-logic.ts` and `audit-log.ts` support user-facing log presentation and internal operational logging, respectively.

## Main flows

### Extension activation flow

1. VS Code invokes `activate`.
2. `extension.ts` coordinates the activation process.
3. `interpretStatus` produces or derives a `KeryxStatusState`.
4. `status-bar.ts` can translate the resulting state into status-bar behavior.
5. `output-channel-logic.ts` can format output-channel content when detailed status or diagnostics are needed.
6. `audit-log.ts` can record lifecycle or status-related events.

### Initialization prompt flow

1. During activation or state observation, the extension evaluates whether initialization should be suggested.
2. `shouldPromptInit` decides whether to prompt the user.
3. If prompting is appropriate, `initPromptMessage` provides the message content.
4. When the user proceeds, `keryx-cli.ts` is likely involved in invoking or coordinating the underlying Keryx command-line workflow.
5. `audit-log.ts` can record the attempt or its result.

### Post-initialization reveal flow

1. After an initialization-related action completes, the extension evaluates whether additional output should be shown.
2. `shouldRevealAfterInit` determines whether to reveal output.
3. If the action succeeded but the environment is still not ready, `initSucceededButNotReadyMessage` provides the user-facing explanation.

## Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `activate` | function | Public entry point called by VS Code when the extension activates |
| `deactivate` | function | Public exit point called by VS Code during extension shutdown |
| `KeryxStatusState` | interface | Domain state representing the current Keryx-related situation |
| `interpretStatus` | function | Maps raw status information into `KeryxStatusState` |
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

- [Wiki Index](../index.md)

## Changelog

- 0.1.0 - Initial draft generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z.
- 0.1.0 - Enriched and marked accepted.
