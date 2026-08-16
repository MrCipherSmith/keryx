# keryx — Developer Documentation

**keryx** is a single-binary Bun/TypeScript CLI whose one job is to scaffold and maintain a per-project `.metaproject/` workspace — a file-based "agent operating system" that materializes a repo's structure, quality, tests, conventions, and history as durable Markdown plus machine-readable JSON. It has **no database and no always-on HTTP server**; everything is local-first and offline by default, and external tools (git, gh, eslint, tsc) are optional and degrade gracefully. Two HTTP surfaces exist and both are **opt-in and off until you start them**: `keryx mcp serve --http` (localhost-only, and additionally gated on `http.enabled` in the module manifest) and `keryx serve`, the loopback-bound remote entry over the agent harness. The CLI performs deterministic mechanics (scaffold, scan, score, checksum, render); the "thinking" is delegated to the agent skills the workspace ships. Its nine default product modules are loosely coupled through files under `.metaproject/data/` rather than direct calls, while MCP remains opt-in.

## Quick start

Requirements: `git` and `bun` (>= 1.1.0).

```bash
# Global install. The scope matters: the unscoped `keryx` on npm is an
# unrelated project (github.com/actionhero/keryx). The executable is `keryx`.
npm install -g @mrciphersmith/keryx

# Or straight from the repository:
bun install -g github:MrCipherSmith/keryx

keryx init
```

`init` is interactive by default (pass `--yes` to accept defaults). It scaffolds `.metaproject/`, enables the nine default modules, wires your `AGENTS.md`/`CLAUDE.md` routing, and writes the `metaproject.json` manifest. See [onboarding.md](./onboarding.md) for project-local installs, the local-dev workflow, and the full first-run walkthrough.

## Documentation map

- **[onboarding.md](./onboarding.md)** — Install paths (global / project-local / from source), first-run walkthrough, the typical build loop, and TTY/CI behavior.
- **[complete-setup-and-agent-workflows.md](./complete-setup-and-agent-workflows.md)** — End-to-end global installation, full project setup, command catalog, copy-ready operational scripts, and reusable agent prompts.
- **[agent-installation-playbook.md](./agent-installation-playbook.md)** — Autonomous Gherkin scenarios for installation, runtime configuration, optional capabilities, validation, repair, and structured handoff.
- **[architecture.md](./architecture.md)** — System overview, the four-layer pattern, the two invariants, cross-module data flows, and external integrations.
- **[harness.md](./harness.md)** — The agent runtime, feature by feature: the four doors, providers, sessions and forking, the policy engine, OS containment, evidence and the completion gate, child agents, record and replay — and what it does not do yet.
- **[modules.md](./modules.md)** — One section per module: purpose, CLI surface, key files, mechanics, the `.metaproject/` paths it reads/writes, and integrations.
- **[cli-reference.md](./cli-reference.md)** — Complete reference for every command, subcommand, flag, and exit code.
- **[workspace-and-lifecycle.md](./workspace-and-lifecycle.md)** — The `.metaproject/` directory contract, source-of-truth vs generated `data/`, the manifest, agent entrypoints, and the `init`/`update` lifecycle.
- **[guides/shared-agent-context.md](./guides/shared-agent-context.md)** — Shared Agent Context: `keryx workspace`, FWK reads, propose/review, MCP `sac.*`, harness `workspace_*`.

## Modules at a glance

The nine product modules enabled by default at `init` (disable any with `--no-<module>`):

| Module | CLI command | Role |
|---|---|---|
| gdgraph | `keryx gdgraph` | Build and query file and optional symbol/call graphs: find, path, affected, impact, cycles, orphans, and repomaps. |
| gdctx | `keryx ctx` | Token-aware command/search/read wrapper plus opt-in routing guards for supported agent runtimes. |
| gdwiki | `keryx wiki` | File-based knowledge base with hierarchical collection, backlinks, validation, and grounded retrieval. |
| gdskills | `keryx skills` | Manage bundled and project agent skills: install, route, verify, learn, export/sync; owns the JSON interop contracts. |
| health | `keryx health` | Aggregate code-quality signals into per-scope scores, compare to baseline, evaluate a pass/warn/fail gate. |
| testing | `keryx test` | Detect the test stack, run the project's existing runner (optionally changed-scoped), normalize results into a report. |
| memory | `keryx memory` | Long-term typed project memory (lessons/decisions/constraints); deterministic search, dedup, ingest, reflect. |
| tasks (flow) | `keryx flow` | Agent-first work lifecycle: scaffold a "flow" package, drive a status state machine, enforce completion gates. |
| security | `keryx security` | Deterministic content scanning, redaction, policy gates, incidents, and merge-safe runtime hooks. |

The opt-in MCP module exposes Metaproject facades over stdio or isolated localhost HTTP/SSE. SAC tools on that server (`sac.overview` / `sac.read` / `sac.collaboration` / `sac.propose` / `sac.review`) run on **local stdio only**; HTTP returns `sac_transport_denied`. The `rules`, `agents`, `orient`, managed `review`, and `workspace` (SAC) command surfaces are cross-cutting rather than default data-producing modules.

---

> **Note.** This `docs/docs/` folder documents **what the code actually does**. It is distinct from `docs/requirements/`, which holds the product specs — the intended design. Where the two disagree, this folder is the one describing shipped behaviour.
