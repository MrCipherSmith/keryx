# Configuration and environment

Keryx reads configuration from three places: a per-user directory, a per-user store under `~/.keryx/`, and files inside each project. Environment variables override or switch off a few behaviours. This page lists every file and every variable a user can meaningfully set, grouped by what it controls. Variables that exist only for tests or that keryx sets for its own child processes are listed at the end so you can recognise them.

## Where configuration lives

| Place | Resolves to | Holds |
|---|---|---|
| User config directory | `$XDG_DATA_HOME/keryx`, or `~/.local/share/keryx` (also on macOS); `%APPDATA%\keryx` on Windows | Provider selection and keys, the project registry, `serve` settings, shell permissions, sandbox defaults, theme, sessions |
| User store | `~/.keryx/`, or `$KERYX_HOME/.keryx/` | Personal skills, agents, memory, learned patterns, bundles, user-scope hooks |
| Project | `<repo>/.metaproject/`, `<repo>/.keryx/`, `<repo>/routing.config.json` | Module configuration, hooks, triggers, sandbox policy, project MCP servers |

Files in the user config directory are created owner-only (mode `0600`, directory `0700`) and are refused unread when larger than 1 MB, so a corrupt file cannot hang a command. Nothing here is created until a command needs it.

## User config directory

| File or directory | Purpose | Written by |
|---|---|---|
| `auth.json` | Last provider and model, per-provider endpoints and API keys, subscription login grants, external-agent settings, bus settings, per-user routing table, output-token and reasoning defaults | `keryx shell` (`/connect`), `keryx auth`, `keryx providers`, `keryx routing`, `keryx external` |
| `llm-providers.json` | Custom OpenAI-compatible providers (name, base URL, key variable, sampling and budget fields) | `keryx shell` (`/connect`, custom provider) |
| `projects.json` | Registry of initialised projects | `keryx init`, `keryx projects` |
| `serve.json`, `serve-credentials.json` | `keryx serve` settings; the salted hash of the bearer token | `keryx serve config`, `keryx serve token` |
| `permissions.json` | Shell commands you chose to auto-approve | `keryx shell`, when you approve a command for reuse |
| `sandbox.json` | Global sandbox defaults, for example `{"shell": "workspace"}` for the shell sandbox mode | you, by hand |
| `tui.json` | Theme | `/theme` |
| `mcp-servers.json`, `mcp-servers-disabled.json` | User-scope MCP servers for the shell; per-server disable overlay | `keryx mcp` |
| `version-check.json`, `codex-catalog-version.json` | Cached update-check and model-catalog data | `keryx version check` |
| `turns/` | Durable records of remote turns | `keryx serve` |
| `sessions/` | Per-project shell sessions | `keryx shell` |

Never put an API key in a project file. Keys belong in `auth.json` (use `/connect`) or in an environment variable.

## User store: `~/.keryx/`

Resolved from `KERYX_HOME` first, then the real home directory. See [Move skills, rules, agents, and memory](../guides/portability.md) for the layout.

| Path | Purpose |
|---|---|
| `skills/<name>/SKILL.md`, `skills/external-imports.json` | Personal skills; catalog entries referenced rather than copied |
| `agents/<name>.md` | Personal agent definitions |
| `memory/` | User-scope memory |
| `learning/` | User-scope learned patterns and the cross-project evidence index |
| `bundles/` | Imported bundle cache and the `applied-state.json` ledger |
| `hooks.json` | User-scope [lifecycle hooks](../hooks.md) |
| `state/` | Reserved for keryx's own integrity keys; no bundle can write here |

## Project files

| File | Purpose | Notes |
|---|---|---|
| `.metaproject/metaproject.json` | The manifest: enabled modules, each module's commands, data and core paths, agent-entrypoint scopes | Written by `init` and `update`; toggle modules with `keryx modules` |
| `.metaproject/gdctx.config.json` | Output limits for compact command and read output | Seeded once, then yours |
| `.metaproject/health.config.json` | Health sources, ignore paths, gate thresholds | Seeded once |
| `.metaproject/testing.config.json` | Test runner, changed-file selection, coverage map, smoke selectors, hooks | Seeded once |
| `.metaproject/memory.config.json` | Memory ranking weights, confidence values, dedup | Seeded once |
| `.metaproject/security.config.json` | Scanner mode (`advisory` by default), policies and actions, retention, the `impactEvidence` block | Seeded once |
| `.metaproject/gdgraph.config.json`, `wiki.config.json` | Optional graph and wiki settings | Absent until you create them |
| `.metaproject/learning.config.json`, `review-learning.config.json` | Optional learning-loop and review-learning settings | Absent until you create them |
| `.metaproject/core/mcp/mcp.config.json` | Settings for `keryx serve-mcp` | Seeded when the `mcp` module is enabled |
| `.metaproject/hooks.json` | Project [lifecycle hooks](../hooks.md); command hooks run only after `keryx hooks trust` | Version-controlled |
| `.metaproject/triggers.json` | Declared [triggers](../modules/automation.md); keryx never writes it | Version-controlled |
| `.metaproject/assets.lock.json` | Pins and checksums for optional downloaded assets | Managed |
| `routing.config.json` (repo root) | Category-to-model routing for this project; takes effect only after `keryx routing trust` | Version-controlled |
| `.keryx/sandbox-policy.json` | Non-secret sandbox policy: `maskMode`, `tlsTerminate`, `extraMasks`, `allowedDomains` | Honoured only when `KERYX_SANDBOX_TRUST_PROJECT_POLICY` is set |
| `.keryx/mcp-servers.json` | Project-scope MCP servers for the shell | Needs `keryx mcp trust` |
| `.mcp.json`, `.cursor/mcp.json` | MCP server files written by other tools | Read for compatibility; `keryx integrate` writes keryx's own entry into them |

`keryx init` and `keryx update` regenerate templates, manifests and managed blocks but never write under `.metaproject/data/`. The tree is described in [Workspace and lifecycle](../workspace-and-lifecycle.md).

## Environment variables

### Locations

| Variable | Effect | Default |
|---|---|---|
| `KERYX_HOME` | Home directory used to resolve `~/.keryx/` and user-scope hooks. A value that resolves inside the current project is refused for hooks. | the real home directory |
| `XDG_DATA_HOME` | Base of the user config directory (Linux, macOS) | `~/.local/share` |
| `APPDATA` | Base of the user config directory on Windows | `~/AppData/Roaming` |
| `KERYX_DATA_DIR` | Moves the per-project session store only; `auth.json` and the other config files stay where they are | the user config directory |
| `KERYX_ASSET_CACHE` | Cache directory for optional downloaded assets | `~/.cache/keryx/assets` |

### Provider credentials

Keys saved with `/connect` live in `auth.json`; a variable in the environment is used when set.

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API |
| `OPENAI_API_KEY` | OpenAI API |
| `GEMINI_API_KEY`, `GOOGLE_API_KEY` | Gemini API (`GEMINI_API_KEY` wins) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `ZAI_API_KEY` | Z.ai (both endpoints) |
| `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `MOONSHOT_API_KEY`, `XAI_API_KEY` | Cerebras, Groq, Moonshot, xAI |
| `GITHUB_COPILOT_TOKEN` | GitHub Copilot, normally set through `keryx auth login` instead |

Subscription logins and local runtimes are configured with `keryx auth` and `/connect`; see [Connect a model provider](../guides/connect-a-provider.md). Web search providers are connected in the shell; see [Agent web search](../guides/web-search.md).

### Switches

| Variable | Effect |
|---|---|
| `KERYX_HOOKS=off` | Disables the [lifecycle hook runtime](../hooks.md) in `keryx shell` and `keryx serve` |
| `KERYX_LEARNING=off` | Makes learning observation a no-op, both the shell hook and `keryx learn observe`. Only the exact string `off` counts. ([Self-learning loop](../learning.md)) |
| `KERYX_REWIND=off` | Records no `/rewind` snapshots ([Undo a turn with /rewind](../guides/rewind.md)) |
| `KERYX_BUS=off` | The shell does not join the agent bus; it is also off in CI environments and when shell config sets `bus.enabled: false` |
| `KERYX_BUS_POLL_MS` | Bus inbox polling interval, clamped to 250-10000 (default 1500) |
| `KERYX_RETENTION_AUTO=0` | Disables the automatic daily sweep of the compact-output stores (`0`, `off` or `false`) |
| `KERYX_GDGRAPH_HOOK_REBUILD=0` | The graph post-commit hook prints a reminder instead of rebuilding |
| `KERYX_DISABLE_IMPACT_GATE=1` | Switches off the impact-evidence gate for the process (`1` or `true`) |
| `KERYX_SKIP_BOOT=1` | Skips the shell's startup animation |
| `KERYX_MAINTENANCE_LOCK_WAIT_MS` | How long `sync --apply` and `gdgraph build` wait for another run's maintenance lock before exiting with code 75 (default 120000) |

### Agent loop and tool limits

| Variable | Effect | Default |
|---|---|---|
| `KERYX_REASONING_EFFORT` | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Ranks below the session's `/reasoning` choice and above the saved value. | `off` |
| `KERYX_MAX_OUTPUT_TOKENS` | Output-token budget for the main turn (positive integer). Wins over saved config. | provider default |
| `KERYX_AGENT_MAX_ROUNDS` | Tool rounds per turn before the loop-safety stop (positive integer, capped at 200) | 40 |
| `KERYX_AGENT_MAX_ATTEMPTS_PER_HASH` | Attempts allowed for an identical tool call | 3 |
| `KERYX_SHELL_TIMEOUT_MS` | Wall-clock limit for one `shell_exec` command; `0` disables it | 120000 |
| `KERYX_MAX_BACKGROUND_JOBS` | Concurrent background jobs per session | 3 |
| `KERYX_SHELL_HOLD_MS` | How long a headless run waits for its own background tasks | 1800000 |
| `KERYX_SHELL_MAX_AUTO_WAKE` | Cap on consecutive turns started by a task completion with no operator input | built in |
| `KERYX_SUBAGENT_MODEL` | Model for subagents as `<provider>/<model>`; `inherit` or an unparseable value is ignored | inherit |
| `KERYX_SUBAGENT_TIMEOUT_MS` | Subagent wall-clock limit. It can only tighten the granted limit; `0` disables it. | the granted limit |
| `KERYX_SUBAGENT_MAX_TOOL_CALLS` | Hard cap on one subagent's tool calls; unset or `<= 0` means no cap | none |

### Sandbox and subprocesses

See [Contain an agent](../guides/contain-an-agent.md) and [Harness and safety](../modules/harness-and-safety.md).

| Variable | Effect |
|---|---|
| `KERYX_SANDBOX_SHELL` | Sandbox for the shell's `shell_exec`: `off`, `workspace` (also `1`, `on`) or `strict`. Overrides `sandbox.json`. |
| `KERYX_DANGEROUSLY_DISABLE_SANDBOX=1` | Turns the shell sandbox off. An unattended run refuses to start while it is set. |
| `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` | Lets `keryx harness run` proceed when no sandbox launcher is available, instead of failing closed |
| `KERYX_SANDBOX_ALLOW_WRITE`, `KERYX_SANDBOX_READ_DENY` | Comma-separated extra writable roots and extra read-denied roots |
| `KERYX_SANDBOX_ALLOWED_DOMAINS` | Comma-separated domains; when set, shell network access is restricted to them |
| `KERYX_SANDBOX_TRUST_PROJECT_POLICY=1` | Honour `.keryx/sandbox-policy.json` from the repository. Off by default so an untrusted repo cannot widen its own sandbox. |
| `KERYX_SANDBOX_MASK_MODE` | Credential masking: `auto`, `manual` (default) or `off` |
| `KERYX_SANDBOX_MASK_ENV` | `;`-separated `NAME@host` credential masks |
| `KERYX_SANDBOX_TLS_TERMINATE` | Explicit on or off for TLS termination in the sandbox proxy (`1`/`true`/`on`, `0`/`false`/`off`) |
| `KERYX_ALLOW_REAL_SUBPROCESS=1` | Allows `keryx harness exec` to start a real process (also `--allow-real-subprocess`) |
| `KERYX_SHELL_PASS_SAVED_KEYS=1` | Passes keys saved in `auth.json` into `shell_exec` commands. Off by default, so an agent that runs `env` does not print them. |

### Identity and calling context

| Variable | Effect |
|---|---|
| `KERYX_ACTOR` | Identity recorded for flow signatures and learning acceptances when no `--signed-by` is given |
| `KERYX_SESSION_PROVIDER`, `KERYX_SESSION_MODEL` | The provider and model of the session that is calling keryx, used by `keryx review tier` and `keryx providers cross-family` |
| `KERYX_HARNESS` | Harness id for `keryx serve-mcp` when `--harness` is not given |
| `KERYX_TRANSPORT` | Set by a host that embeds keryx. `local`, `cli`, `shell` and `tui` mean an operator is present; any other value is treated as remote. |
| `GITHUB_REPOSITORY` | Default for `--repo` in `keryx review bot` (set by GitHub Actions) |
| `SONAR_ISSUES_FILE` | Path of an exported SonarQube issues file for the health gate, tried before the default locations |
| `CLAUDE_PROJECT_DIR` | Project root passed by a host to hook commands; keryx uses it as the project root fallback and sets it for its own hooks |

### Installer

Read by `scripts/install.sh` and `scripts/install-binary.sh`, not by the `keryx` binary. See [Install](../getting-started/install.md).

| Variable | Effect | Default |
|---|---|---|
| `KERYX_BIN_DIR` | Install directory for the `keryx` command | `~/.local/bin` |
| `KERYX_RELEASE_TAG` | Release tag for the binary installer | latest |
| `KERYX_REPO`, `KERYX_REPO_URL` | Release repository (`owner/repo`) for the binary installer; git URL for the source installer | the project repository |
| `KERYX_REF` | Git ref the source installer checks out | `main` |
| `KERYX_HOME` | Checkout directory for the source installer | `~/.keryx/keryx` |
| `KERYX_ACKNOWLEDGE_NO_CHECKSUM=1` | Install without verifying the release digest when no checksum tool is available | unset |

### Set by keryx, for its child processes

Do not set these yourself. Every command a shell session starts inherits `KERYX_TOOL_CALL=1`; keryx uses it to refuse nested `schedule`, `bus send` and similar commands. Hook commands receive `KERYX_HOOK_EVENT`, `KERYX_HOOK_ID`, `KERYX_SESSION_ID`, `KERYX_RUN_ID`, `KERYX_PROJECT_ROOT` and `KERYX_POLICY_PROFILE` (see [Lifecycle hooks](../hooks.md)). `KERYX_GDGRAPH_LOCAL` marks the graph builder's delegated child, and `KERYX_EXTERNAL_DEPTH` and `KERYX_REEXEC_PARENT_PID` guard against nested external agents and re-execution.

### Internal and test-only

Variables with the prefixes `KERYX_TEST_` and `KERYX_LIVE_`, along with `KERYX_TRIGGER_RUN_HOLD_MS`, `KERYX_MAINTENANCE_LOCK_HOLD_UNTIL`, `KERYX_DISPATCH_LOCK_HOLD_UNTIL`, `KERYX_P0_ENFORCE`, `KERYX_CTX_CLOCK_PIN_MS`, `KERYX_JUDGE_RECORDINGS_DIR`, `KERYX_SESSION_LEASE_*`, `KERYX_BUS_HEARTBEAT_MS` and `KERYX_BUS_PRESENCE_STALE_MS`, exist to make tests deterministic or to run costly live checks. They are not a supported interface and may change without notice. Terminal-detection variables (`DISPLAY`, `WAYLAND_DISPLAY`, `TERM_PROGRAM`, `HERDR_*`) and the `GIT_*` variables keryx sets when it isolates git subprocesses are read or written internally and are not settings.

## Reference

- [CLI reference](../cli-reference.md) for the commands that write these files
- [Workspace and lifecycle](../workspace-and-lifecycle.md) for the `.metaproject/` tree
- [Move skills, rules, agents, and memory](../guides/portability.md) for the user store
- [Contain an agent](../guides/contain-an-agent.md) for the sandbox
