# Agent Installation Playbook

This playbook is the autonomous-agent companion to the
[Complete Installation, Project Setup, and Agent Workflow Guide](./complete-setup-and-agent-workflows.md).
It converts the installation process into explicit Gherkin scenarios that an AI
coding agent can execute and verify without requiring the user to remember keryx
commands.

## Minimal invocation prompt

Copy this prompt into an agent session opened at the target repository:

```text
Install and fully configure keryx in this project by executing the "Complete
recommended installation" scenario from docs/docs/agent-installation-playbook.md.

Parameters:
- PROJECT_ROOT: <absolute-project-path>
- RUNTIME: codex
- INSTALL_MODE: global
- ENABLE_MCP: false
- ENABLE_SYMBOLS: false
- ENABLE_TIA: false

Read and follow the playbook exactly. Preserve existing user changes. Do not commit,
push, tag, publish, open a PR, or modify global configuration outside the requested
runtime integration without explicit approval. Return the structured handoff report.
```

For a fully enabled setup, change the optional capability values to `true`.

## Natural-language shortcuts

An agent should map these requests to the corresponding scenarios:

| User request | Scenario |
|---|---|
| “Install keryx in this project.” | Complete recommended installation |
| “Configure keryx for Codex.” | Configure one agent runtime |
| “Enable every keryx capability.” | Enable optional capabilities |
| “Refresh keryx after pulling changes.” | Refresh an existing installation |
| “Check whether keryx is configured correctly.” | Validate a completed installation |
| “Repair this broken keryx setup.” | Resume or repair a partial installation |

## Parameters

| Parameter | Required | Allowed values | Default |
|---|---:|---|---|
| `PROJECT_ROOT` | yes | absolute directory path | none |
| `RUNTIME` | yes | `codex`, `claude`, `cursor`, `opencode`, `zcode`, `antigravity`, `windsurf`, `generic-mcp` | `codex` |
| `INSTALL_MODE` | yes | `global`, `project` | `global` |
| `ENABLE_MCP` | no | `true`, `false` | `false` |
| `ENABLE_SYMBOLS` | no | `true`, `false` | `false` |
| `ENABLE_TIA` | no | `true`, `false` | `false` |
| `ALLOW_GLOBAL_WRITES` | no | `true`, `false` | `false` |
| `ALLOW_COMMIT` | no | `true`, `false` | `false` |
| `ALLOW_PUSH` | no | `true`, `false` | `false` |

## Agent execution contract

The following rules apply to every scenario:

1. Read the nearest `AGENTS.md` and `.metaproject/index.md` before project work
   when they exist.
2. Preserve uncommitted and untracked user files. Never reset, clean, delete, or
   overwrite them to make installation easier.
3. Discover state before changing it: check prerequisites, current branch,
   working-tree status, existing runtime, manifest, modules, and hooks.
4. Prefer idempotent keryx commands. Re-running a successful scenario must not
   duplicate managed blocks or destroy source-of-truth content.
5. Treat command exit codes as evidence. Do not report a gate as passed because
   output “looks fine.”
6. Optional dependencies and assets must be enabled explicitly. Never download
   model or grammar assets unless the corresponding parameter is `true`.
7. Global files under `$HOME` may be modified only when `ALLOW_GLOBAL_WRITES=true`
   or when the user explicitly requested the corresponding runtime integration.
8. Do not commit, push, tag, publish, create a release, or open a pull request
   unless the matching authorization is explicit.
9. Report every skipped step and reason. A skipped required gate makes the final
   result `BLOCKED`, not `PASS`.
10. All generated documentation and reports must be English-only.

## Gherkin specification

```gherkin
Feature: Autonomous keryx installation and project configuration
  As a repository owner
  I want an AI coding agent to install and configure keryx autonomously
  So that the project receives reproducible context, quality, memory, workflow,
  and agent-routing infrastructure without requiring manual command knowledge

  Background:
    Given PROJECT_ROOT is an absolute path to an existing project directory
    And the agent has read the nearest AGENTS.md when present
    And the agent has captured `git status --short --branch` when PROJECT_ROOT is a Git repository
    And the agent will preserve all pre-existing tracked, untracked, and stashed work
    And the agent will use English for every generated artifact
    And commit, push, tag, publish, release, and PR operations are forbidden by default

  Scenario: Complete recommended installation
    Given INSTALL_MODE is either "global" or "project"
    And RUNTIME identifies the user's primary agent runtime
    When the agent verifies `git --version` and `bun --version`
    Then the agent must stop with STATUS BLOCKED if Git or Bun is unavailable
    When the agent checks whether `keryx --version` succeeds
    And keryx is unavailable
    Then the agent installs keryx according to INSTALL_MODE
    And the agent verifies `keryx --version` again
    When `.metaproject/index.md` does not exist
    Then the agent runs `keryx init --yes`
    When `.metaproject/index.md` already exists
    Then the agent runs `keryx update --skip-runtime`
    And the agent explicitly reads `.metaproject/index.md`
    And the agent runs `keryx status`
    And the agent configures RUNTIME using the compatible runtime scenario
    And the agent runs `keryx gdgraph build`
    And the agent runs `keryx test analyze`
    And the agent runs `keryx test run --strict`
    And the agent runs `keryx health run --strict`
    And the agent runs `keryx wiki collect --force`
    And the agent runs `keryx wiki index`
    And the agent runs `keryx wiki check-links`
    And the agent runs `keryx wiki validate`
    And the agent runs `keryx dashboard build`
    And the agent runs `keryx sync install-hooks`
    And the agent runs `keryx standard validate`
    And the agent runs `keryx security policy validate`
    And the agent runs `keryx flow check`
    And the agent executes optional capability scenarios whose parameters are true
    Then the agent returns the structured installation handoff

  Scenario: Install the global runtime
    Given INSTALL_MODE is "global"
    And `keryx --version` does not succeed
    When ALLOW_GLOBAL_WRITES is true or the user explicitly requested global installation
    Then the agent runs the repository global installer with `--global`
    And the agent adds `$HOME/.local/bin` to PATH for the current process
    And the agent reports any shell profile change before making it
    And the agent verifies `command -v keryx`
    And the agent verifies `keryx --version`
    But the agent must not modify a shell profile without authorization

  Scenario: Install a project-local runtime
    Given INSTALL_MODE is "project"
    And `keryx --version` does not succeed
    When the agent changes directory to PROJECT_ROOT
    Then the agent runs the repository installer with `--project --yes`
    And the runtime must exist under `.metaproject/runtime/keryx`
    And `.metaproject/index.md` must exist
    And the agent verifies the project-local runtime version

  Scenario: Refresh an existing installation
    Given `.metaproject/index.md` exists
    When the agent verifies the current working-tree state
    Then the agent runs `keryx update --skip-runtime`
    And the agent reads the refreshed `.metaproject/index.md`
    And the agent runs `keryx sync` to report derived-layer drift since each layer was built
    And the agent runs `keryx sync --apply` to rebuild stale graph/wiki/memory incrementally and prune orphan wiki drafts for removed modules
    And the agent runs `keryx wiki index`
    And the agent runs `keryx wiki check-links`
    And the agent runs `keryx wiki validate`
    And the agent runs `keryx dashboard build`
    And the agent runs `keryx standard validate`
    Then the agent reports changed managed files separately from pre-existing user files
    But the agent must not delete accepted or human-edited wiki pages when pruning

  Scenario Outline: Configure one agent runtime
    Given RUNTIME is "<runtime>"
    When the runtime supports global bootstrap
    Then the agent runs `keryx agents bootstrap install --runtime <runtime>` only with global-write authorization
    And the agent runs `keryx agents bootstrap status --runtime <runtime>`
    When the runtime supports orientation hooks
    Then the agent runs `keryx orient install-hook --runtime <runtime>`
    When the runtime supports gdctx routing guards
    Then the agent runs `keryx ctx install-hook --runtime <runtime>`
    When the runtime supports security hooks
    Then the agent runs `keryx security hooks install --runtime <runtime>`
    And unsupported integrations are reported as skipped rather than forced

    Examples:
      | runtime      |
      | codex        |
      | claude       |
      | cursor       |
      | opencode     |
      | zcode        |
      | antigravity  |
      | windsurf     |
      | generic-mcp  |

  Scenario: Enable MCP integration
    Given ENABLE_MCP is true
    When the selected runtime is "cursor" or "claude"
    Then the agent previews `keryx mcp install --runtime <runtime> --dry-run`
    And the agent requests approval if the preview modifies project client configuration
    And after approval the agent runs `keryx mcp install --runtime <runtime>`
    And the agent verifies `keryx standard capabilities`
    And the agent verifies that the selected client configuration contains the managed keryx server
    But the agent must not start a long-running MCP server during setup verification

  Scenario: Enable the symbol layer
    Given ENABLE_SYMBOLS is true
    When the agent runs `keryx gdgraph symbols enable`
    Then the agent runs `keryx gdgraph assets list`
    And the agent explicitly pulls the pinned TypeScript, TSX, and JavaScript grammar assets when missing
    And the agent runs `keryx gdgraph build`
    And the agent runs `keryx gdgraph symbols status`
    And the agent records symbol and call counts
    But absent optional dependencies or assets must preserve the deterministic file graph

  Scenario: Enable coverage-map Test Impact Analysis
    Given ENABLE_TIA is true
    When the agent runs `keryx test coverage-map build`
    Then the agent runs `keryx test coverage-map status`
    And the agent runs `keryx test run --changed --strict`
    And the agent reports whether selection used coverage data or deterministic fallback

  Scenario: Validate a completed installation
    Given `.metaproject/index.md` exists
    When the agent runs `keryx status`
    And the agent runs `keryx gdgraph build`
    And the agent runs `keryx test analyze`
    And the agent runs `keryx test run --strict`
    And the agent runs `keryx health run --strict`
    And the agent runs `keryx wiki check-links`
    And the agent runs `keryx wiki validate`
    And the agent runs `keryx memory check`
    And the agent runs `keryx flow check`
    And the agent runs `keryx standard validate`
    And the agent runs `keryx security policy validate`
    Then the installation status is PASS only when every required command exits successfully
    And any required failure produces STATUS DONE_WITH_CONCERNS or BLOCKED with evidence

  Scenario: Resume or repair a partial installation
    Given one or more managed files, modules, hooks, or artifacts are missing or stale
    When the agent records the current manifest and working-tree state
    Then the agent runs `keryx standard doctor`
    And the agent runs `keryx status`
    And the agent runs `keryx modules status`
    And the agent applies only idempotent repair commands suggested by diagnostics
    And the agent runs `keryx update --skip-runtime`
    And the agent runs `keryx sync --apply` to rebuild only the stale graph/wiki/memory layers and prune orphan wiki drafts
    And the agent reruns the complete installation validation scenario
    But the agent must not delete `.metaproject`, accepted or user-authored wiki pages, memory, flows, or project skills

  Scenario: Preserve repository safety boundaries
    Given the setup creates or changes files
    Then the agent separates pre-existing changes from installation changes
    And the agent checks `git diff --check`
    And the agent reports ignored raw logs and generated artifacts separately
    And the agent does not use `git reset --hard`, destructive checkout, clean, or unapproved deletion
    And the agent does not commit when ALLOW_COMMIT is false
    And the agent does not push when ALLOW_PUSH is false

  Scenario: Commit and push an approved installation
    Given ALLOW_COMMIT is true
    And all required installation gates have been reported
    And the user approved the exact file scope
    When the agent stages only approved installation and documentation files
    Then the agent creates an English conventional commit
    When ALLOW_PUSH is true
    Then the agent pushes the current feature branch and verifies upstream synchronization
    But the agent must not push directly to a protected main branch
    And the agent must not create a pull request unless explicitly requested
```

## Runtime compatibility matrix

The agent must use this matrix instead of forcing unsupported hooks:

| Runtime | Global bootstrap | Orientation | gdctx guard | Security hook | MCP client wiring |
|---|---:|---:|---:|---:|---:|
| Codex | yes | yes | yes | no dedicated adapter | generic/manual |
| Claude Code | yes | yes | yes | yes | yes |
| Cursor | no global bootstrap command | yes | yes | yes | yes |
| OpenCode | yes | no orientation hook | yes | no dedicated adapter | generic/manual |
| Zed/Zcode | yes | no orientation hook | experimental/static rules | no dedicated adapter | generic/manual |
| Antigravity | yes | no orientation hook | experimental | no dedicated adapter | generic/manual |
| Windsurf | no global bootstrap command | no orientation hook | yes | yes | generic/manual |
| Generic MCP | no | no | harness-specific | yes | printed configuration |

If live command help disagrees with this matrix, the agent must trust live help,
report the documentation drift, and avoid the unsupported write.

## Structured handoff contract

The autonomous run must end with this shape:

```text
KERYX_INSTALLATION_RESULT
status: PASS | DONE_WITH_CONCERNS | BLOCKED
project_root: <absolute path>
install_mode: global | project
runtime: <runtime>
keryx_version: <version>
metaproject_status: ready | incomplete | missing

modules:
  enabled: <list>
  disabled: <list>

integrations:
  global_bootstrap: installed | skipped | failed
  orientation: installed | skipped | failed
  gdctx_guard: installed | skipped | failed
  security_hook: installed | skipped | failed
  sync_hooks: installed | skipped | failed
  mcp: installed | disabled | skipped | failed
  symbols: enabled | disabled | fallback | failed
  testing_tia: enabled | disabled | fallback | failed

artifacts:
  graph: <path and node/edge counts>
  testing_context: <path and test-file count>
  health: <path and gate>
  wiki: <path, page count, draft count, broken links>
  dashboard: <path>

verification:
  tests: pass | fail | skipped
  health: pass | warn | fail | skipped
  wiki_links: pass | fail
  wiki_validate: pass | fail
  standard: pass | fail
  security_policy: pass | fail
  flow_check: pass | fail
  diff_check: pass | fail

changes:
  created: <paths>
  modified: <paths>
  pre_existing_preserved: <paths or none>

warnings:
  - <warning or none>

next_actions:
  - <action or none>

publication:
  committed: yes | no
  pushed: yes | no
  pull_request: <url or not created>
```

## Example user commands

Recommended setup:

```text
Install keryx in this repository using the complete recommended installation
scenario. Configure it for Codex, keep optional MCP/symbol/TIA capabilities off,
preserve all existing changes, and stop before commit or push.
```

Fully enabled setup:

```text
Install and fully configure keryx using the agent installation playbook. Use the
global runtime, configure Claude Code, enable MCP, tree-sitter symbols, and
coverage-map TIA, run every required validation gate, and return the structured
handoff. Ask before any global config write, commit, or push.
```

Repair:

```text
Repair the existing keryx installation using the partial-installation recovery
scenario. Preserve all user-authored Metaproject content, apply only idempotent
repairs, rerun validation, and report unresolved blockers.
```
