---
Title: Module src/flow/tracker
Version: 1.0.1
Type: component
Status: accepted
Summary: "Bridges keryx flow management to external issue trackers via a pluggable adapter interface. Currently ships a GitHub adapter (`githubAdapter`) that delegates all operations to the `gh` CLI."
---
# Module src/flow/tracker

VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:1f5947ce1f7d41bd0594e3806255906678327f0040c480d0a127c161445c0af1

## Summary

`src/flow/tracker` groups 2 file(s). Exposes 1 public symbol(s): `githubAdapter`. The module owns integration between keryx flow management and external issue trackers, bridging a flow's linked issue URL to a concrete tracker platform.

## Overview

`src/flow/tracker` owns the integration between keryx flow management and external issue trackers. Its single responsibility is to bridge a flow's linked issue URL to a concrete tracker platform so the rest of the system can fetch issue metadata, post progress comments, and check pull-request status without knowing which tracker is in use.

The module currently ships one concrete adapter — `githubAdapter` — which delegates every network call to the `gh` CLI, keeping the adapter dependency-free and testable without an HTTP client.

### Requirements

- `gh` CLI must be installed and available on `PATH`
- `gh` must have an active authenticated session (`gh auth login` previously run)

## How it works

The module is structured as a single thin adapter layer sitting on top of the `TrackerAdapter` interface defined in `src/flow/types.ts`. That interface declares five operations — `detect`, `parseRef`, `fetchIssue`, `prStatus`, and `comment` — and `githubAdapter` in `github.ts` implements all of them by spawning `gh` CLI subprocesses via `Bun.spawn`.

### Design principles

- **No HTTP client**: Relies entirely on `gh`'s pre-authenticated session and JSON output flags (`--json`)
- **No exceptions**: All methods return typed results or `null`/`false` on error
- **No caching layer**: Each call spawns a fresh subprocess
- **No token management**: Delegated entirely to the external tool

### Detection flow

`detect()` is a two-step probe:

1. `Bun.which("gh")` — checks for `gh` binary on `PATH`
2. `gh auth status` — confirms an authenticated session exists

A zero exit code from both confirms the adapter is usable. Any failure returns `false`, allowing callers to gracefully skip GitHub integration.

### Subprocess helper

The internal `gh(args)` function wraps `Bun.spawn` and collects stdout + exit code into a plain object. All five adapter methods share this helper, making it the single point where process spawning happens.

## Key concepts

**TrackerAdapter** — the interface (`src/flow/types.ts`) that any issue-tracker integration must satisfy. It acts as the plug-point: callers in `src/commands` depend only on this interface, not on any GitHub-specific code.

**TrackerRef** — a resolved reference to a specific issue: `{ repo: string; number: number }`. Produced by `parseRef` from a raw URL string and consumed by `fetchIssue` and `comment`. Separating parsing from network calls makes the reference reusable without repeated URL parsing.

**githubAdapter** — the sole concrete `TrackerAdapter` in this module. Identified via `id: "github"`, it is the exported public symbol of the module. Implementation is entirely driven by the `gh` CLI, delegating authentication, pagination, and API versioning to the external tool.

**gh subprocess helper** — the internal `gh(args)` function wraps `Bun.spawn` and collects stdout + exit code into a plain object. All five adapter methods share this helper, making it the single point where process spawning happens.

## Public API

### `githubAdapter`

The sole exported symbol. Implements `TrackerAdapter` with `id: "github"`.

#### Methods

| Method | Description |
|--------|-------------|
| `detect()` | Returns `true` if `gh` CLI is installed and authenticated |
| `parseRef(url: string)` | Extracts `{ repo, number }` from a GitHub issue/PR URL |
| `fetchIssue(ref: TrackerRef)` | Fetches issue title and body via `gh issue view` |
| `prStatus(url: string)` | Returns PR existence, draft state, and CI status |
| `comment(ref: TrackerRef, body: string)` | Posts a comment to the issue/PR |

All methods return `null` or `false` on any error. No exceptions are thrown.

## Main flows

### 1. Adapter detection at flow start

When a keryx command in `src/commands` starts a flow that references an issue URL:

1. Call `githubAdapter.detect()`
2. Adapter checks for `gh` on `PATH` via `Bun.which`
3. If found, spawns `gh auth status`
4. Zero exit code → adapter is usable
5. Any failure → caller can fall back or warn the user

### 2. Issue enrichment

1. Command layer calls `parseRef(url)` with the raw issue URL from flow metadata
2. `github.ts` matches against a GitHub issues regex to extract `repo` and `number`
3. Returns a `TrackerRef` object
4. `fetchIssue(ref)` spawns `gh issue view <number> --repo <repo> --json title,body`
5. Parses JSON response into `{ title, body }` for use in flow context or display

### 3. PR gate check

During flow completion:

1. `prStatus(url)` is called with a pull-request URL
2. Adapter runs `gh pr view <url> --json isDraft,state` to confirm PR exists and read draft flag
3. Runs `gh pr checks <url>` as a separate subprocess — zero exit = all CI checks green
4. Returns composed result `{ exists, isDraft, checksGreen }`
5. Gate layer in `src/commands` receives the result; no retry or polling logic inside adapter

## Error handling

The adapter employs defensive error handling:

- All subprocess failures return `null` or `false` — no exceptions surface to callers
- Callers in `src/commands` are responsible for interpreting `null`/`false` responses
- This design allows the adapter to be swapped without changing caller error-handling logic

## Testing

`src/flow/tracker/github.test.ts` contains unit tests for the adapter. Tests mock `Bun.spawn` calls to verify correct argument construction and response parsing without requiring a real `gh` CLI or GitHub API access.

---

<!-- keryx:reference:begin v=1 hash=233059dd0a17bb50f6e66ff54fb2a93f42d0fdd5b47ad5e438fe9b177a2632a0 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `githubAdapter`

### Key files

- `src/flow/tracker/github.ts` - imported by 4, imports 1
- `src/flow/tracker/github.test.ts` - imported by 0, imports 1

### Depends on

- `src/flow` - 1 import(s)

### Depended on by

- `src/commands` - 2 import(s)
- `src/harness/tool` - 1 import(s)

### Graph signals

- Files: 2
- Cross-module imports: 1
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.1 - Reference refreshed from the code graph (5886c474beb774901805417efb1cc4d1a03935df)
- 1.0.0 - Prose sections enriched by agent (gdwiki enrich workflow) on 2026-07-10. Status set to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
