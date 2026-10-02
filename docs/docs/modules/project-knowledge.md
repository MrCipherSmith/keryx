# Project knowledge

Project knowledge is the part of Keryx that lets you and your agents ask the repository questions instead of re-reading it: a code dependency graph, token-compact command output, a wiki, long-term memory, a bounded startup block and a sync check that keeps them current. Agents that start every task by grepping and reading files burn context on things the repository can already answer in a few lines.

## When to use it

- You are about to change a file and want to know what depends on it before you read anything else.
- A search or a test run prints thousands of lines and you want a short summary plus a pointer to the full log.
- You want to record why a decision was made, so the next session (yours or an agent's) finds it by asking.
- An agent should start a session already oriented, without being told which files matter.
- You pulled changes and want to know whether the graph, the wiki and memory still match the code.

## Quick example

Run these in a repository that already has a `.metaproject/` workspace (`keryx init --yes` creates one).

```bash
keryx gdgraph build
keryx gdgraph affected src/greet.ts
keryx ctx rg greet src
keryx memory new decision use-plain-greeting --title "Greetings stay plain strings"
keryx wiki ask "how are greetings built"
```

```text
gdgraph build complete: 2 nodes, 1 edges
# Affected context for src/greet.ts

## Dependencies
- none

## Dependents
- src/main.ts
…
# gdctx rg summary
Command: `rg --with-filename --line-number --column --no-heading -- greet src`
Matches: `3`
Files: `2`
…
# how are greetings built

Based on the project's own wiki and memory:

1. **Greetings stay plain strings** — Greetings stay plain strings; no template engine. (`memory/decisions/use-plain-greeting.md`)
2. **Greeting flow › Details** — main.ts imports greet and prints the result. Greetings are plain strings. (`wiki/architecture/greeting-flow.md`)
```

The last answer assumes the memory entry and a wiki page were written and set to `Status: accepted`. `wiki ask` cites only current, accepted material and answers `no-match` when nothing fits.

## How it works

Every part reads and writes plain files under `.metaproject/` in your repository. None of it needs a model provider or a network.

| Part | Command | What it answers |
|---|---|---|
| Graph | `keryx gdgraph` | What imports this file, what does it import, which files match a term, which cycles exist. Optional symbol and call data with `gdgraph symbols enable`. |
| Compact context | `keryx ctx` | Runs a search, a file read or any command and prints a short summary, while saving the raw output so nothing is lost. |
| Wiki | `keryx wiki` | Architecture, domain rules and decisions written as Markdown pages with a status, a version and links to code. `wiki ask` retrieves from the pages and from memory. |
| Memory | `keryx memory` | Lessons, decisions, constraints and known mistakes as small Markdown entries; lexical search with lifecycle states. |
| Orient | `keryx orient` | Prints a bounded block (index, graph summary, wiki index) for an agent to read at the start of a task. |
| Sync | `keryx sync` | Reports whether graph, wiki and memory match `HEAD`; `--apply` rebuilds and records a baseline. |
| Stack | `keryx stack detect` | Offline detection of languages and frameworks, written to `.metaproject/data/stack/stack.json`. |

The graph answers from the last `keryx gdgraph build`, not from the working tree. When files changed since then, `gdgraph` prints a note saying so; rebuild before relying on an answer. `keryx init` also installs a post-commit hook that rebuilds the graph after each commit.

`keryx ctx` is a wrapper, not a cache. `ctx rg` states what it did not search (dot directories, ignored files) and whether the result is complete, so an empty result reads as "not looked at" rather than "not present". `ctx show <artifact|latest> --lines <start>-<end>` recovers a range the summary omitted. `ctx install-hook` adds an opt-in routing guard for an agent runtime; support differs per runtime and some are marked experimental.

For the layout of `.metaproject/` see [The Metaproject](../concepts/metaproject.md) and [Workspace and lifecycle](../workspace-and-lifecycle.md).

## Common tasks

| I want to… | Command or page |
|---|---|
| See what a change can break | `keryx gdgraph affected <file> [--ranked]` |
| Find files by topic | `keryx gdgraph find "<terms>"` |
| Find a symbol | `keryx gdgraph symbol "<name>"` after `keryx gdgraph symbols enable` |
| Search code with a short result | `keryx ctx rg "<pattern>" [path]` |
| Run a noisy command compactly | `keryx ctx run -- <command>` |
| Read a file outline | `keryx ctx read <file> --mode outline` |
| Write a wiki page | `keryx wiki new <type> <slug> --title "<title>"`, then `keryx wiki index` |
| Ask the wiki and memory | `keryx wiki ask "<question>"` |
| Record a decision or lesson | `keryx memory new <type> [slug] --title "<title>"` |
| Search memory | `keryx memory search "<query>"` |
| Give an agent a startup block | `keryx orient`; see [Give an agent context](../guides/give-an-agent-context.md) |
| Check that knowledge is current | `keryx sync`, then `keryx sync --apply` |
| Keep the wiki fresh over time | [Keep the wiki current](../guides/keep-the-wiki-current.md) |

## Status

Stable: the graph (`gdgraph`), compact context (`gdctx`), wiki (`gdwiki`) and memory are among the nine modules that `keryx init` enables by default; `orient` and `sync` are commands that work on top of them, not modules. Per-runtime `ctx` hooks are experimental. `wiki enrich` and `memory reflect --narrate` use a model and need a configured [provider](providers.md); everything else here is deterministic. See [Project status](../project/status.md).

## Reference

- CLI: [gdgraph](../cli-reference.md#gdgraph), [ctx](../cli-reference.md#ctx), [wiki](../cli-reference.md#wiki), [memory](../cli-reference.md#memory), [orient](../cli-reference.md#orient), [sync](../cli-reference.md#sync), [stack](../cli-reference.md#stack)
- Module reference: [modules.md](../modules.md#gdgraph)
- Guides: [Keep the wiki current](../guides/keep-the-wiki-current.md), [Give an agent context](../guides/give-an-agent-context.md)
