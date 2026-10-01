# Project Wiki

Version: 0.1.0

## Purpose

This is the local project knowledge base. It stores knowledge that should
outlive a single task: architecture, domain models, business rules, user
scenarios, components, services, integrations, and known decisions.

Read this index first. Do not read every page unless necessary.

## Page Types

- `architecture` - system or module architecture
- `domain-model` - entities, invariants, relationships
- `business-rule` - business constraints and decisions
- `user-scenario` - user workflows and expected outcomes
- `component` - UI/component behavior and ownership
- `service` - backend/service responsibility and APIs
- `integration` - external systems and contracts
- `decision` - known decisions and ADR-like records

## Create A Page

```bash
keryx wiki new <type> <slug> --title "<title>"
keryx wiki index
```

## Pages

<!-- keryx:wiki-index:begin -->
<!-- generated: 2026-10-01T06:49:30.340Z | pages: 97 -->

### Architecture

- [Agent Bus](architecture/agent-bus.md) (accepted)
- [Supervised Shell Tasks (formerly Background Shell Jobs)](architecture/background-jobs.md) (accepted) - **Every `shell_exec` call is a supervised task.** The call returns within a bounded yield (`KERYX_SHELL_YIELD_MS`, 10 s by default): a command that finishes inside the yield returns its output exactly as a blocking call would, while one still running when the yield elapses keeps running as a background task and hands back `{task_id, pid, status, output}` instead of freezing the turn. Backgrounding is not a mode the model has to choose — it is what happens to any command that turns out to be slow. The model cannot forget to ask for it.
- [OS Sandbox](architecture/os-sandbox.md) (accepted) - The OS sandbox is a kernel-enforced containment layer that sits *below* keryx's policy engine, structural command guard, env allowlist, and approval gate. Those layers decide **whether a command may start**; the OS sandbox constrains **what the process can do once running** — which paths it can write, which secrets it can read, and which network it can reach — using macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap (`bwrap`). It adds no npm dependencies: containment is delegated to system binaries. When containment cannot be applied, a run is **refused**, never silently downgraded.
- [Permission Modes](architecture/permission-modes.md) (accepted) - The interactive agent session (`keryx shell`, supporting both the OpenTUI surface and the readline fallback) exposes three user-selectable permission modes — `ask`, `trust`, and `auto` — that determine whether a mutating tool call prompts for approval before execution. Affected operations include `shell_exec`, `spawn_subagent`, and any tool declaring `risk: "destructive"`.
- [Project Map](architecture/project-map.md) (accepted)
- [Quality Map](architecture/quality-map.md) (accepted)
- [Remote Control (Telegram)](architecture/remote-control.md) (accepted) - `/remote-control <name>` in a full-screen `keryx shell` opens a topic in a Telegram supergroup and mirrors that session into it. A line sent in the topic runs in the shell as if typed there; replies and approval questions go back to the topic. It is off unless two files exist and validate (`remote/bot-token`, `remote/config.json` in the user-global keryx directory) and a shell has turned it on. Verified against an in-process fake Bot API only; no run against real Telegram has been done.
- [Testing Map](architecture/testing-map.md) (accepted) - This page provides a high-level overview of the project's testing infrastructure. It documents the testing framework in use, the available test scripts, configuration files, and the location of test files. This map is auto-generated to serve as a quick reference for developers and CI/CD pipelines.
- [Wiki, Graph, and Shared Agent Context](architecture/wiki-graph-sac.md) (accepted) - The project wiki, the code graph, and Shared Agent Context (SAC) form a unified knowledge stack with three distinct owners. Each layer has a clear responsibility:

### Domain Model

_No pages yet._

### Business Rule

- [Code Search Routing Rule](business-rules/code-search-routing.md) (accepted) - Every text, symbol, or pattern search an agent runs over this project's code goes through `keryx ctx rg` — never a bare `rg` or `grep`. A `PreToolUse` hook enforces the rule before the command runs and refuses the raw form with a message naming the routed replacement. The one sanctioned exception is an inline escape marker that states a reason.

### User Scenario

_No pages yet._

### Component

  - [fixtures/change-impacted-test/src](components/fixtures-change-impacted-test-src.md) (accepted)
  - [fixtures/churn-complexity/src](components/fixtures-churn-complexity-src.md) (accepted)
    - [fixtures/import-policy/allowed-client-imports-core-facade/gdgraph](components/fixtures-import-policy-allowed-client-imports-core-facade-gdgraph.md) (draft)
    - [fixtures/import-policy/tree-shaken-through-barrel/harness](components/fixtures-import-policy-tree-shaken-through-barrel-harness.md) (draft)
- [fixtures/mcp-servers](components/fixtures-mcp-servers.md) (draft)
- [scripts](components/scripts.md) (draft)
- [scripts/benchmark](components/scripts-benchmark.md) (accepted)
- [scripts/stress](components/scripts-stress.md) (draft)
- [src](components/src.md) (accepted)
- [src/agents](components/src-agents.md) (accepted)
- [src/assets](components/src-assets.md) (accepted)
- [src/capability](components/src-capability.md) (accepted)
- [src/commands](components/src-commands.md) (accepted)
- [src/contracts](components/src-contracts.md) (draft)
- [src/ctx](components/src-ctx.md) (accepted)
- [src/eval](components/src-eval.md) (draft)
- [src/flow](components/src-flow.md) (accepted)
  - [src/flow/tracker](components/src-flow-tracker.md) (accepted)
- [src/forgetting](components/src-forgetting.md) (draft)
- [src/gdgraph](components/src-gdgraph.md) (accepted)
  - [src/gdgraph/treesitter](components/src-gdgraph-treesitter.md) (accepted)
- [src/gdskills](components/src-gdskills.md) (accepted)
- [src/harness](components/src-harness.md) (accepted)
  - [src/harness/branch](components/src-harness-branch.md) (draft)
  - [src/harness/budget](components/src-harness-budget.md) (draft)
  - [src/harness/child](components/src-harness-child.md) (accepted)
  - [src/harness/completion](components/src-harness-completion.md) (draft)
  - [src/harness/context](components/src-harness-context.md) (draft)
  - [src/harness/evidence](components/src-harness-evidence.md) (draft)
  - [src/harness/extension](components/src-harness-extension.md) (draft)
  - [src/harness/external](components/src-harness-external.md) (draft)
    - [src/harness/external/codec](components/src-harness-external-codec.md) (draft)
  - [src/harness/flow](components/src-harness-flow.md) (draft)
  - [src/harness/monitor](components/src-harness-monitor.md) (draft)
  - [src/harness/mutation](components/src-harness-mutation.md) (draft)
  - [src/harness/parallel](components/src-harness-parallel.md) (draft)
  - [src/harness/policy](components/src-harness-policy.md) (draft)
  - [src/harness/process](components/src-harness-process.md) (draft)
    - [src/harness/process/sandbox](components/src-harness-process-sandbox.md) (draft)
  - [src/harness/provider](components/src-harness-provider.md) (accepted)
    - [src/harness/provider/anthropic](components/src-harness-provider-anthropic.md) (draft)
    - [src/harness/provider/compat](components/src-harness-provider-compat.md) (draft)
    - [src/harness/provider/gemini](components/src-harness-provider-gemini.md) (draft)
    - [src/harness/provider/ollama](components/src-harness-provider-ollama.md) (draft)
    - [src/harness/provider/openai](components/src-harness-provider-openai.md) (draft)
  - [src/harness/replay](components/src-harness-replay.md) (draft)
  - [src/harness/resume](components/src-harness-resume.md) (draft)
  - [src/harness/run](components/src-harness-run.md) (draft)
  - [src/harness/search](components/src-harness-search.md) (draft)
  - [src/harness/session](components/src-harness-session.md) (draft)
  - [src/harness/tool](components/src-harness-tool.md) (accepted)
    - [src/harness/tool/builtin](components/src-harness-tool-builtin.md) (accepted)
  - [src/harness/web](components/src-harness-web.md) (draft)
- [src/health](components/src-health.md) (accepted)
  - [src/health/metrics](components/src-health-metrics.md) (accepted)
  - [src/health/sources](components/src-health-sources.md) (accepted)
- [src/job](components/src-job.md) (draft)
- [src/lib](components/src-lib.md) (accepted)
  - [src/lib/oauth](components/src-lib-oauth.md) (draft)
- [src/mcp](components/src-mcp.md) (accepted)
- [src/mcp-client](components/src-mcp-client.md) (draft)
- [src/mcp-servers](components/src-mcp-servers.md) (draft)
  - [src/mcp/transport](components/src-mcp-transport.md) (accepted)
- [src/memory](components/src-memory.md) (accepted)
  - [src/memory/embedding](components/src-memory-embedding.md) (accepted)
- [src/metrics](components/src-metrics.md) (accepted)
- [src/retention](components/src-retention.md) (draft)
- [src/review](components/src-review.md) (accepted)
- [src/rules](components/src-rules.md) (accepted)
- [src/sac (Shared Agent Context)](components/src-sac.md) (accepted)
- [src/security](components/src-security.md) (accepted)
  - [src/security/agent-hooks](components/src-security-agent-hooks.md) (accepted)
  - [src/security/detect](components/src-security-detect.md) (accepted)
    - [src/security/detect/injection](components/src-security-detect-injection.md) (accepted)
    - [src/security/detect/pii](components/src-security-detect-pii.md) (accepted)
  - [src/security/eval](components/src-security-eval.md) (accepted)
- [src/session](components/src-session.md) (draft)
- [src/standard](components/src-standard.md) (accepted)
- [src/sync](components/src-sync.md) (accepted)
- [src/testing](components/src-testing.md) (accepted)
- [src/tui](components/src-tui.md) (accepted)
  - [src/tui/games](components/src-tui-games.md) (draft)
    - [src/tui/games/tic-tac-toe](components/src-tui-games-tic-tac-toe.md) (draft)
- [src/wiki](components/src-wiki.md) (accepted)
  - [src/wiki/freshness](components/src-wiki-freshness.md) (draft)
- [vscode-extension/src](components/vscode-extension-src.md) (draft)

### Service

_No pages yet._

### Integration

_No pages yet._

### Decision

- [SAC: SAC harness integration demo](decisions/sac-proposal-a41fc4152ad147e2.md) (draft)
<!-- keryx:wiki-index:end -->
