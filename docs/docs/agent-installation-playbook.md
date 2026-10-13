# Agent installation playbook

This page is written for a coding agent that installs and configures Keryx
unattended. It states the parameters, the rules the agent must follow, the
scenarios as Gherkin, a runtime compatibility matrix and the report the agent
returns. An agent matches its steps against these exact commands and checks
each exit code.

If you are setting Keryx up yourself, follow
[Set up a project end to end](guides/set-up-a-project.md) instead; it covers the
same steps as prose.

## Minimal invocation prompt

Paste this into an agent session opened at the target repository:

```text
Install and fully configure keryx in this project by executing the "Complete
recommended installation" scenario from the keryx agent installation playbook
(docs/docs/agent-installation-playbook.md in the keryx repository).

Parameters:
- PROJECT_ROOT: <absolute-project-path>
- RUNTIME: <runtime id from the compatibility matrix>
- INSTALL_MODE: global
- ENABLE_MCP: false
- ENABLE_SYMBOLS: false
- ENABLE_TIA: false

Follow the playbook exactly. Preserve existing user changes. Do not commit,
push, tag, publish, open a PR, or modify global configuration outside the requested
runtime integration without explicit approval. Return the structured handoff report.
```

For a fully enabled setup, set the optional capability values to `true`.

## Natural-language shortcuts

An agent maps these requests to scenarios:

| User request | Scenario |
|---|---|
| "Install keryx in this project." | Complete recommended installation |
| "Configure keryx for my agent." | Configure one agent runtime |
| "Enable every keryx capability." | Enable MCP integration, Enable the symbol layer, Enable coverage-map test selection |
| "Refresh keryx after pulling changes." | Refresh an existing installation |
| "Check whether keryx is configured correctly." | Validate a completed installation |
| "Repair this broken keryx setup." | Resume or repair a partial installation |

## Parameters

| Parameter | Required | Allowed values | Default |
|---|---:|---|---|
| `PROJECT_ROOT` | yes | absolute directory path | none |
| `RUNTIME` | yes | a runtime id from the [compatibility matrix](#runtime-compatibility-matrix) | none |
| `INSTALL_MODE` | yes | `global`, `project` | `global` |
| `ENABLE_MCP` | no | `true`, `false` | `false` |
| `ENABLE_SYMBOLS` | no | `true`, `false` | `false` |
| `ENABLE_TIA` | no | `true`, `false` | `false` |
| `ALLOW_GLOBAL_WRITES` | no | `true`, `false` | `false` |
| `ALLOW_COMMIT` | no | `true`, `false` | `false` |
| `ALLOW_PUSH` | no | `true`, `false` | `false` |

## Agent execution contract

These rules apply to every scenario:

1. Read the nearest agent instruction file and `.metaproject/index.md` before
   project work when they exist.
2. Preserve uncommitted and untracked user files. Never reset, clean, delete or
   overwrite them to make installation easier.
3. Discover state before changing it: prerequisites, current branch, working
   tree, existing runtime, manifest, modules and hooks.
4. Prefer idempotent keryx commands. Re-running a successful scenario must not
   duplicate managed blocks or destroy source content.
5. Treat exit codes as evidence. Do not report a gate as passed because the
   output "looks fine".
6. Enable optional dependencies and assets only when the matching parameter is
   `true`. Never download grammar or model assets otherwise.
7. Write files under `$HOME` only when `ALLOW_GLOBAL_WRITES=true` or the user
   explicitly asked for that runtime integration. Preview every install with
   `--dry-run` first.
8. Do not commit, push, tag, publish, create a release or open a pull request
   unless the matching permission is explicit.
9. Report every skipped step and its reason. A skipped required gate makes the
   result `BLOCKED`, not `PASS`.
10. If live `--help` or `keryx integrations matrix` disagrees with this page,
    trust the live output, report the difference, and skip the unsupported
    write.

## Gherkin specification

```gherkin
Feature: Autonomous keryx installation and project configuration
  As a repository owner
  I want a coding agent to install and configure keryx unattended
  So that the project gets reproducible context, quality, memory, workflow
  and agent-routing infrastructure without me running each command

  Background:
    Given PROJECT_ROOT is an absolute path to an existing project directory
    And the agent has read the nearest agent instruction file when present
    And the agent has captured `git status --short --branch` when PROJECT_ROOT is a git repository
    And the agent will preserve all pre-existing tracked, untracked and stashed work
    And commit, push, tag, publish, release and pull-request operations are forbidden by default

  Scenario: Complete recommended installation
    Given INSTALL_MODE is either "global" or "project"
    And RUNTIME identifies the user's primary agent runtime
    When the agent verifies `git --version` and `bun --version`
    Then the agent must stop with STATUS BLOCKED if git or Bun is unavailable
    And the agent must stop with STATUS BLOCKED if Bun is older than 1.3.14
    When the agent checks whether `keryx --version` succeeds
    And keryx is unavailable
    Then the agent installs keryx according to INSTALL_MODE
    And the agent verifies `keryx --version` again
    When `.metaproject/index.md` does not exist
    Then the agent runs `keryx init --yes`
    When `.metaproject/index.md` already exists
    Then the agent runs `keryx update --skip-runtime`
    And the agent explicitly reads `.metaproject/index.md`
    And the agent runs `keryx doctor`
    And the agent runs `keryx status`
    And the agent configures RUNTIME using the "Configure one agent runtime" scenario
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
    And the agent executes the optional capability scenarios whose parameters are true
    Then the agent returns the structured installation handoff

  Scenario: Install the global runtime
    Given INSTALL_MODE is "global"
    And `keryx --version` does not succeed
    When ALLOW_GLOBAL_WRITES is true or the user explicitly requested a global installation
    Then the agent runs `npm install -g @mrciphersmith/keryx`
    And the agent verifies `command -v keryx`
    And the agent verifies `keryx --version`
    But the agent must not modify a shell profile without authorization
    And the agent must never install the unscoped npm package `keryx`

  Scenario: Install a project-local runtime
    Given INSTALL_MODE is "project"
    And `keryx --version` does not succeed
    When the agent changes directory to PROJECT_ROOT
    Then the agent runs the repository installer `scripts/install.sh` with `--project --yes`
    And the runtime must exist under `.metaproject/runtime/keryx`
    And `.metaproject/index.md` must exist
    And the agent reports that this runtime tracks git main, not a release, unless KERYX_REF was set

  Scenario: Refresh an existing installation
    Given `.metaproject/index.md` exists
    When the agent records the current working-tree state
    Then the agent runs `keryx update --skip-runtime`
    And the agent reads the refreshed `.metaproject/index.md`
    And the agent runs `keryx sync` to report which derived layers are behind the code
    And the agent runs `keryx sync --apply` to rebuild the stale graph, wiki and memory layers
    And the agent runs `keryx wiki index`
    And the agent runs `keryx wiki check-links`
    And the agent runs `keryx wiki validate`
    And the agent runs `keryx dashboard build`
    And the agent runs `keryx standard validate`
    Then the agent reports changed managed files separately from pre-existing user files
    But the agent must not delete accepted or human-edited wiki pages

  Scenario Outline: Configure one agent runtime
    Given RUNTIME is "<runtime>"
    When the matrix lists global bootstrap for the runtime
    And ALLOW_GLOBAL_WRITES is true or the user requested this runtime's integration
    Then the agent runs `keryx agents bootstrap install --runtime <bootstrap-id> --dry-run`
    And the agent runs `keryx agents bootstrap install --runtime <bootstrap-id>`
    And the agent runs `keryx agents bootstrap status --runtime <bootstrap-id>`
    When the matrix lists at least one hook for the runtime
    Then the agent runs `keryx integrations install --runtime <runtime> --dry-run`
    And the agent runs `keryx integrations install --runtime <runtime>`
    And the agent runs `keryx integrations doctor --runtime <runtime>`
    And unsupported integrations are reported as skipped rather than forced

    Examples:
      | runtime              | bootstrap-id |
      | claude               | claude       |
      | codex                | codex        |
      | cursor               | none         |
      | windsurf             | none         |
      | opencode             | opencode     |
      | antigravity          | antigravity  |
      | zed                  | zcode        |
      | gemini-cli           | none         |
      | kiro                 | none         |
      | github-copilot-agent | none         |
      | generic-mcp          | none         |

  Scenario: Enable MCP integration
    Given ENABLE_MCP is true
    When the matrix lists an `integrate` target for RUNTIME
    Then the agent previews `keryx integrate <target> --dry-run`
    And the agent requests approval if the preview modifies project client configuration
    And after approval the agent runs `keryx integrate <target>`
    And the agent verifies that the client configuration contains the managed keryx server
    When the matrix lists no dedicated target for RUNTIME
    Then the agent runs `keryx integrate generic` and reports the printed snippet for the user to place
    But the agent must not start a long-running MCP server during setup verification

  Scenario: Enable the symbol layer
    Given ENABLE_SYMBOLS is true
    When the agent runs `keryx gdgraph symbols enable`
    Then the agent runs `keryx gdgraph assets list`
    And the agent explicitly pulls the pinned grammar assets for the project's languages when missing
    And the agent runs `keryx gdgraph build`
    And the agent runs `keryx gdgraph symbols status`
    And the agent records symbol and call counts
    But a missing grammar must leave the file graph working

  Scenario: Enable coverage-map test selection
    Given ENABLE_TIA is true
    When the agent runs `keryx test coverage-map build`
    Then the agent runs `keryx test coverage-map status`
    And the agent runs `keryx test run --changed --strict`
    And the agent reports whether selection used coverage data or the heuristic fallback

  Scenario: Validate a completed installation
    Given `.metaproject/index.md` exists
    When the agent runs `keryx doctor`
    And the agent runs `keryx status`
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
    Then the installation status is PASS only when every required command exits 0
    And any required failure produces STATUS DONE_WITH_CONCERNS or BLOCKED with evidence

  Scenario: Resume or repair a partial installation
    Given managed files, modules, hooks or artifacts are missing or stale
    When the agent records the current manifest and working-tree state
    Then the agent runs `keryx doctor`
    And the agent runs `keryx standard doctor`
    And the agent runs `keryx status`
    And the agent runs `keryx modules status`
    And the agent applies only idempotent repair commands suggested by diagnostics
    And the agent runs `keryx update --skip-runtime`
    And the agent runs `keryx sync --apply`
    And the agent reruns the "Validate a completed installation" scenario
    But the agent must not delete `.metaproject`, accepted or user-authored wiki pages, memory, flows or project skills

  Scenario: Preserve repository safety boundaries
    Given the setup creates or changes files
    Then the agent separates pre-existing changes from installation changes
    And the agent checks `git diff --check`
    And the agent reports ignored raw logs and generated artifacts separately
    And the agent does not use `git reset --hard`, destructive checkout, clean or unapproved deletion
    And the agent does not commit when ALLOW_COMMIT is false
    And the agent does not push when ALLOW_PUSH is false

  Scenario: Commit and push an approved installation
    Given ALLOW_COMMIT is true
    And all required installation gates have been reported
    And the user approved the exact file scope
    When the agent stages only the approved installation files
    Then the agent creates a conventional commit
    When ALLOW_PUSH is true
    Then the agent pushes the current feature branch and verifies upstream synchronization
    But the agent must not push directly to a protected main branch
    And the agent must not open a pull request unless explicitly requested
```

## Runtime compatibility matrix

The agent uses this matrix instead of forcing unsupported hooks. It reflects
`keryx integrations matrix` for this release; run that command for the live
answer, including each hook's confidence.

| Runtime id | Agent | Global bootstrap | Orientation hook | Compact-output guard | Security checks | MCP client wiring | Confidence |
|---|---|---|---|---|---|---|---|
| `claude` | Claude Code | `claude` | yes | yes | yes | `integrate claude` | verified |
| `codex` | Codex CLI | `codex` | yes | yes | no | `integrate generic` | verified |
| `cursor` | Cursor | no | yes | yes | yes | `integrate cursor` | verified |
| `windsurf` | Windsurf | no | no | yes | yes | `integrate generic` | verified |
| `opencode` | OpenCode | `opencode` | no | yes | no | `integrate opencode` | experimental |
| `antigravity` | Antigravity | `antigravity` | no | yes | no | `integrate generic` | experimental |
| `zed` | Zed | `zcode` | no | no; see note | no | `integrate generic` | experimental |
| `gemini-cli` | Gemini CLI | no | no | yes | no | `integrate generic` | experimental |
| `kiro` | Kiro | no | no | yes | no | `integrate generic` | experimental |
| `github-copilot-agent` | GitHub Copilot coding agent | no | no | yes | no | `integrate generic` | experimental |
| `generic-mcp` | Any MCP host | no | no | no | yes | `integrate generic` | experimental |

Notes:

- **Hooks** install with `keryx integrations install --runtime <id>`. The
  older `keryx orient install-hook`, `keryx ctx install-hook` and
  `keryx security hooks install` commands install the same hooks for the
  runtimes they accept.
- **`zed`** has no scriptable pre-exec hook. When Keryx runs as that editor's
  agent over ACP, Keryx's own permission gate applies instead;
  `keryx integrations install --runtime zed` writes instruction files only.
- **`integrate vscode`** writes the editor's project MCP configuration;
  `integrate all` writes the `cursor`, `claude` and `opencode` targets.
- Several runtimes also accept agent definitions, rules or instruction files;
  `keryx integrations matrix` lists every surface.

## Structured handoff contract

The run ends with this report:

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
  hooks: <installed surfaces, or skipped>
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
  doctor: pass | warn | fail
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

## Example requests

Recommended setup:

```text
Install keryx in this repository using the complete recommended installation
scenario. RUNTIME is codex. Keep optional MCP, symbol and TIA capabilities off,
preserve all existing changes, and stop before commit or push.
```

Fully enabled setup:

```text
Install and fully configure keryx using the agent installation playbook. Use the
global runtime, RUNTIME claude, enable MCP, symbols and coverage-map TIA, run every
required validation gate, and return the structured handoff. Ask before any global
config write, commit, or push.
```

Repair:

```text
Repair the existing keryx installation using the partial-installation recovery
scenario. Preserve all user-authored Metaproject content, apply only idempotent
repairs, rerun validation, and report unresolved blockers.
```
