# gd-metapro — Developer Documentation

**gd-metapro** is a single-binary Bun/TypeScript CLI whose one job is to scaffold and maintain a per-project `.metaproject/` workspace — a file-based "agent operating system" that materializes a repo's structure, quality, tests, conventions, and history as durable Markdown plus machine-readable JSON. It has **no database and no HTTP server**; everything is local-first and offline, and external tools (git, gh, eslint, tsc) are optional and degrade gracefully. The CLI performs only deterministic mechanics (scaffold, scan, score, checksum, render); the "thinking" is delegated to the agent skills the workspace ships. Its eight optional product modules are loosely coupled through files under `.metaproject/data/` rather than direct calls.

## Quick start

Requirements: `git` and `bun` (>= 1.1.0).

```bash
# Global install (adds ~/.local/bin/gd-metapro)
bun install -g github:MrCipherSmith/meta-project
gd-metapro init
```

`init` is interactive by default (pass `--yes` to accept defaults). It scaffolds `.metaproject/`, enables the eight optional modules, wires your `AGENTS.md`/`CLAUDE.md` routing, and writes the `metaproject.json` manifest. See [onboarding.md](./onboarding.md) for project-local installs, the local-dev workflow, and the full first-run walkthrough.

## Documentation map

- **[onboarding.md](./onboarding.md)** — Install paths (global / project-local / from source), first-run walkthrough, the typical build loop, and TTY/CI behavior.
- **[architecture.md](./architecture.md)** — System overview, the four-layer pattern, the two invariants, cross-module data flows, and external integrations.
- **[modules.md](./modules.md)** — One section per module: purpose, CLI surface, key files, mechanics, the `.metaproject/` paths it reads/writes, and integrations.
- **[cli-reference.md](./cli-reference.md)** — Complete reference for every command, subcommand, flag, and exit code.
- **[workspace-and-lifecycle.md](./workspace-and-lifecycle.md)** — The `.metaproject/` directory contract, source-of-truth vs generated `data/`, the manifest, agent entrypoints, and the `init`/`update` lifecycle.

## Modules at a glance

The eight optional product modules (all enabled by default at `init`; disable any with `--no-<module>`):

| Module | CLI command | Role |
|---|---|---|
| gdgraph | `gd-metapro gdgraph` | Build and query a regex-based intra-project import/dependency graph (cycles, orphans, affected). |
| gdctx | `gd-metapro ctx` | Token-aware wrapper: run git/rg/shell/read, persist raw output, print a compacted Markdown summary. |
| gdwiki | `gd-metapro wiki` | File-based project knowledge base; hand-authored pages plus auto-collected drafts from sibling modules' data. |
| gdskills | `gd-metapro skills` | Manage bundled and project agent skills: install, route, verify, learn, export/sync; owns the JSON interop contracts. |
| health | `gd-metapro health` | Aggregate code-quality signals into per-scope scores, compare to baseline, evaluate a pass/warn/fail gate. |
| testing | `gd-metapro test` | Detect the test stack, run the project's existing runner (optionally changed-scoped), normalize results into a report. |
| memory | `gd-metapro memory` | Long-term typed project memory (lessons/decisions/constraints); deterministic search, dedup, ingest, reflect. |
| tasks (flow) | `gd-metapro flow` | Agent-first work lifecycle: scaffold a "flow" package, drive a status state machine, enforce completion gates. |

The `rules` module (`gd-metapro rules`) and the `cli-core` / `shared-lib` layers are cross-cutting rather than optional product modules.

---

> **Note.** This `docs/docs/` folder is **auto-generated developer documentation**, reverse-engineered from the source and describing what the code actually does. It is distinct from `docs/requirements/`, which holds the product specs (the intended design). Where the two disagree, this folder documents current behavior.
