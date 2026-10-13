# Code truth — what Keryx is, per the code (flow 363 research)

Worktree: `~/goodea/keryx-docs` @ branch `docs/publication-grade-docs`, package `@mrciphersmith/keryx` **0.3.46** (`package.json:3`).
Sources of truth used: `src/cli-registry.ts` `CLI_ROUTES` (`:109-182`, top-level verbs) and `USAGE_BODY` (`:239-483`); `src/lib/group-subcommands.ts` (`:42-271`, real per-group subcommand vocabulary read from each handler's dispatch); `bun ./src/cli.ts help` / `<group> --help`; `bun ./src/cli.ts doctor --json`; `keryx modules status`.
Items not verified against code are marked **UNCONFIRMED**.

Note on completeness: section 3 (drift) is a first pass done by the main researcher. Three parallel drift sub-audits (README+entry docs, cli-reference/commands-by-task, concept pages+guides) were dispatched but had not reported when this file was written; their line-level findings should be appended under 3.4.

---

## 1. Feature map from the code

### 1.1 Top-level CLI verbs and subcommands

Maturity key: T = test files in the owning `src/<subsystem>` (src/test counts from `find`), R = retired spelling, I = internal-only, O = opt-in/off by default.

| verb | subcommands (from handler dispatch) | what it does | entry file | maturity |
|---|---|---|---|---|
| `help` | `[group\|command]` | grouped help by task (9 groups) | `src/commands/help.ts` (dynamic import, `cli-registry.ts:118`) | tested (`help-grouped.test.ts`) |
| `doctor` | `[--json]` | one-page ok/warn/fail: version, Bun floor, rg, sandbox, providers, MCP, integrations, standard, entrypoints, worktrees, graph/wiki freshness | `src/commands/doctor.ts` | tested; flow 353 |
| `setup` | `init\|refresh\|repair` | prints the preparation guide; runs nothing | `src/commands/setup.ts` | — |
| `init` | flags `--yes --no-gdgraph --no-gdctx --no-gdwiki --no-gdskills --gdskills-profile --no-health --no-testing --no-memory --no-*-hook` | initialise `.metaproject/` | `src/commands/init.ts` | tested (5 files) |
| `status` | — | local Metaproject status | `src/commands/status.ts` | — |
| `update` | `[--skip-runtime] [--hooks]` | refresh managed service files | `src/commands/update.ts` | — |
| `modules` | `status list enable/on disable/off interactive` | toggle the 11 modules (gdgraph, gdctx, gdwiki, gdskills, health, testing, memory, tasks, security, mcp, sac) | `src/commands/modules.ts` | tested; `mcp`, `sac` O |
| `projects` | `list register forget` | user-global registry of initialised projects | `src/commands/projects.ts` | tested |
| `shell` | flags: `-c -r --fork --take-over --provider --model --base-url --agent/--chat --tui/--no-tui --name --permission-mode --ask/--trust/--auto --deny-tools -p/--print --events-file --debug --guard` | interactive TUI agent harness (+ ~60 slash commands) | `src/commands/shell.ts`, `src/tui/` | 123 test files in `src/tui` |
| `sessions` / `session` | `list fork export path` | per-project shell sessions | `src/commands/sessions.ts`, `src/session/` | tested |
| `acp` | flags | ACP v1 agent server over stdio (for editors) | `src/commands/acp.ts`, `src/acp/` | 22 tests |
| `bus` | `list log send pause resume prune` | agent bus across this clone's worktrees | `src/commands/bus.ts`, `src/bus/` | 19 tests |
| `version` | `check` | npm latest check (advisory) | `src/commands/version.ts` | — |
| `harness` | `run exec extension wave replay` | single provider turn; sandboxed exec; extension/wave specs; replay validation | `src/commands/harness.ts`, `src/harness/` | 212 tests in `src/harness` |
| `providers` | `list status cross-family test remove` | configured providers, live model/balance catalog | `src/commands/providers.ts` | 10 test files |
| `routing` | `list set unset trust profile stats` | category → model routing, model profiles, measured cost | `src/commands/routing.ts` | tested |
| `external` | `on off status list` | block private work going to listed providers (Jev/TypeSafe) | `src/commands/external.ts` | tested |
| `auth` | `list login logout status` | subscription login (SuperGrok, ChatGPT Plus/Pro, GitHub Copilot) + API-key status | `src/commands/auth.ts`, `src/lib/oauth/` | tested |
| `serve` | `status token{issue,rotate,revoke} config{init,set,show}` + flags | loopback authenticated HTTP entry (off by default, read-only routes) | `src/commands/serve.ts`, `src/lib/serve-server.ts:1002` | tested; O |
| `approvals` | `list allow deny` | answer remote approvals locally, once | `src/commands/approvals.ts` | tested |
| `dashboard` / `dash` | `build open` | static project admin dashboard HTML | `src/commands/dashboard.ts` | tested |
| `gdgraph` | `build query find symbol symbols path affected repomap context assets` | code dependency graph | `src/commands/gdgraph.ts`, `src/gdgraph/` | 30 tests |
| `ctx` | `status diff rg read run show hook install-hook uninstall-hook` | token-compact command/read output with raw log | `src/commands/ctx.ts`, `src/ctx/` | 15 tests; per-runtime hook confidence can be `experimental` (`ctx.ts:595`) |
| `wiki` | `status new index collect check-links validate freshness refresh verify migrate-markers ask sections enrich context backlinks` | project knowledge base | `src/commands/wiki.ts`, `src/wiki/` | 32 tests |
| `orient` | `[<runtime>] install-hook` | bounded graph+wiki startup block / turn-start hook | `src/commands/orient.ts` | tested (dry-run) |
| `sync` | `[--apply] install-hooks uninstall-hooks` | reconcile graph/wiki/memory with code; git hooks | `src/commands/sync.ts`, `src/sync/` | tested |
| `rules` | `sync distill` | sync AGENTS.md/CLAUDE.md into project rules | `src/commands/rules.ts`, `src/rules/` | tested |
| `skills` | `catalog install doctor uninstall status list inspect route create generate import update remove verify learn export sync contracts scout eval judge-check stocktake` | bundled working skills (gdskills) | `src/commands/skills.ts`, `src/gdskills/` | 57 tests |
| `skill-verify-skill` | `<target>` | single-skill verifier | `src/commands/skills.ts` | — |
| `agents` | `bootstrap{status,install,uninstall,print} monitor external{enable,disable,list,probe,run,review,apply,discard} list show export verify generate` | global bootstrap instructions, subagent catalog, external CLI agents | `src/commands/agents.ts`, `agents-catalog.ts`, `agents-external.ts`, `src/agents/`, `src/harness/external/` | 14 + external tests |
| `stack` | `detect` | offline stack detection | `src/commands/stack.ts`, `src/stack/` | tested |
| `health` | `run status gate sources explain baseline trend` | quality signals + gate | `src/commands/health.ts`, `src/health/` | 25 tests |
| `metrics` | `status validate collect latest show compare rebuild plan benchmark` | provenance-aware run records, benchmarks | `src/commands/metrics.ts`, `src/metrics/` | 18 tests |
| `test` | `init analyze run status context report related explain coverage-map suggest` | testing context / impact | `src/commands/test.ts`, `src/testing/` | tested |
| `memory` | `new index search supersede transition assets ingest check reflect handoff` | long-term project memory | `src/commands/memory.ts`, `src/memory/` | 24 tests |
| `flow` | `init list status freeze start next task ac check-ac owner outcome implemented complete confirm recover block unblock check renumber repair-reviews plan schema` | Task Manager flow lifecycle | `src/commands/flow.ts`, `src/flow/` | 51 tests |
| `job` | `init status step document complete list` | job-orchestrator packages | `src/commands/job.ts`, `src/job/` | 2 tests (thin) |
| `review` | `attach start ingest scope floor blast-radius budget tier comments ci-triage conform bot metrics jev-{rules,edit-guard,risk,scenarios,docs,comments,contract,triage,select,profile} learn loop stack reviewers import status complete lightweight` | managed review packages, Jev-assisted checks, PR bot | `src/commands/review.ts`, `src/review/` | 57 tests; Jev scenarios/docs/comments called experimental in `agent-commands.ts:374` |
| `standard` | `validate doctor capabilities baseline emit` | Metaproject Standard validation, llms emit | `src/commands/standard.ts`, `src/standard/` | tested |
| `commands` | flags `--json --module --intent --intents` | agent-callable command registry | `src/commands/commands.ts`, `src/standard/command-registry.ts` | — |
| `security` | `status scan scan-mcp audit-harness impact-evidence check-input check-output redact report policy incidents hooks eval` | secrets/PII/injection scanning, redaction, egress | `src/commands/security.ts`, `src/security/` | 36 tests |
| `sandbox` | `status` | OS sandbox availability + containment matrix | `src/commands/sandbox.ts`, `src/harness/process/sandbox/` | smoke tests (macOS/Linux) |
| `serve-mcp` | `[--http] [--read-only] [--cwd]` | expose Metaproject over MCP (publisher side) | `src/commands/serve-mcp.ts`, `src/mcp/` | 16 tests; O |
| `integrate` | `[--remove] <cursor\|claude\|opencode\|vscode\|generic\|all>` | wire project into an editor as MCP server | `src/commands/integrate.ts` | tested |
| `integrations` | `install uninstall doctor matrix` | hooks/instructions in 12 harnesses | `src/commands/integrations.ts`, `src/integrations/` | 13 tests |
| `mcp` | consumer: `list add remove enable disable trust untrust doctor auth logout`; R: `serve install uninstall` | MCP **client** server management (consumer) + retired publisher spellings | `src/commands/mcp.ts`, `mcp-servers.ts:62`, `src/mcp-servers/`, `src/mcp-client/` | 39 tests; R spellings in `scripts/check-retired-cli-spellings.ts:173-177` |
| `workspace` | `create list show add-resource archive remove-resource rename overview read propose confirm-review review dismiss-candidate handoff collaboration policy-readiness catch-up list-proposals` | Shared Agent Context (module `sac`) | `src/commands/workspace.ts`, `src/sac/` | 33 tests; O (module off by default); docs call it experimental |
| `retention` | `status sweep` | bound growing stores (gdctx raw, sidecars) | `src/commands/retention.ts`, `src/retention/` | tested |
| `forgetting` | `trail lookup` | deletion trail | `src/commands/forgetting.ts`, `src/forgetting/` | tested |
| `trigger` | `run install uninstall list status schedule resolve` | declared project triggers, one pass each | `src/commands/trigger.ts`, `src/trigger/` | 8 tests |
| `schedule` | `add list show pause resume run remove` | scheduled unattended agent tasks (systemd --user / launchd / cron) | `src/commands/schedule.ts`, `src/trigger/schedule*.ts` | tested |
| `governance` | `report show` | spend/confirmations/signatures/gate outcomes across flows | `src/commands/governance.ts`, `src/governance/` | 1 test (thin) |
| `product` | `index open` | intent index; closed-without-lookback intents | `src/commands/product.ts`, `src/product/` | 12 tests |
| `hooks` | `list validate test enable disable trust untrust` | keryx shell lifecycle hooks | `src/commands/hooks.ts`, `src/harness/hooks/` | tested |
| `bundle` | `export import inspect verify uninstall` | portable skills/rules/agents/memory/hooks bundles | `src/commands/bundle.ts`, `src/bundle/` | 15 tests |
| `learn` | `observe extract list review accept reject apply promote graduate prune` | self-learning loop | `src/commands/learn.ts`, `src/learning/` | 27 tests |
| `__sandbox-net-forward` | — | internal helper invoked inside the sandbox | `src/commands/sandbox-net-forward.ts` | I (excluded from reference) |

### 1.2 Subsystems in `src/` (non-CLI view)

| subsystem | path | one-line | src / test files |
|---|---|---|---|
| TUI shell | `src/tui/`, `src/commands/shell*.ts` | OpenTUI (`@opentui/core`, optional dep) interactive agent shell + readline fallback | 123 / 123 |
| Agent harness core | `src/harness/` (run, resume, session, policy, process/sandbox, tool, budget, branch, parallel, child, routing, completion, evidence, monitor, replay, mutation, extension, flow, web, search) | turn loop, tool policy/permission modes, sandboxing, subagents, routing, replay | 174 / 212 |
| Model providers | `src/harness/provider/` (anthropic, openai, openai-codex, gemini, ollama, compat, fake) | native + OpenAI-compatible adapters | in harness |
| External agents | `src/harness/external/registry.ts` | delegate to `codex-cli`, `claude-cli`, `antigravity-cli`, `gemini-acp` (ACP client) | in harness |
| Web search | `src/harness/search/registry.ts` | duckduckgo, searxng (local), brave, tavily, exa | in harness |
| ACP server | `src/acp/` | ACP v1 JSON-RPC over stdio | 19 / 22 |
| Sessions / slate / rewind | `src/session/`, `src/rewind/` | per-project sessions, external slate, file+history rewind | 12/12, 11/8 |
| Agent bus | `src/bus/` | peers, leases, inbox across worktrees | 16 / 19 |
| MCP publisher | `src/mcp/` | Metaproject over MCP (stdio/HTTP) | 13 / 16 |
| MCP consumer | `src/mcp-servers/`, `src/mcp-client/` | add/trust/oauth third-party MCP servers for the shell | 21 / 45 |
| Integrations | `src/integrations/registry.ts` (`HARNESS_ADAPTERS`) | claude, codex, cursor, windsurf, antigravity, opencode, zed, generic-mcp, gemini-cli, kiro, github-copilot-agent, keryx-shell | 20 / 13 |
| Agent catalog | `src/agents/` | named subagent catalog, export to claude/codex/kiro/opencode/keryx-shell | 15 / 14 |
| gdgraph | `src/gdgraph/` | code graph (tree-sitter optional via `web-tree-sitter`) | 22 / 30 |
| gdctx | `src/ctx/` | compact output + raw logs + agent hooks | 12 / 15 |
| gdwiki | `src/wiki/` | wiki, freshness, ask | 29 / 32 |
| memory | `src/memory/` | decisions/lessons/constraints | 25 / 24 |
| gdskills | `src/gdskills/` (+ `bundled/`, `contracts/` shipped in npm `files`) | bundled skills, routing, eval | 39 / 57 |
| health | `src/health/` | quality gate | 27 / 25 |
| testing | `src/testing/` | related tests, coverage map | 7 / 7 |
| flow / job | `src/flow/`, `src/job/` | Task Manager, job packages | 20/51, 5/2 |
| review | `src/review/` | review packages, Jev checks, PR bot (`action.yml` GitHub Action "Keryx review bot") | 56 / 57 |
| security | `src/security/`, `src/impact-evidence/` | scanning, redaction, policy, egress, impact evidence | 38/36, 6/3 |
| SAC | `src/sac/` | shared agent context workspaces (opt-in) | 28 / 33 |
| learning | `src/learning/` | observe→graduate loop | 30 / 27 |
| trigger / schedule | `src/trigger/` | triggers, cron/systemd/launchd schedules, unattended runs | 15 / 8 |
| governance / product / metrics | `src/governance/`, `src/product/`, `src/metrics/` | reports and observability | 6/1, 7/12, 21/18 |
| retention / forgetting | `src/retention/`, `src/forgetting/` | bounded stores, deletion trail | 4/3, 5/3 |
| bundle | `src/bundle/` | portability | 15 / 15 |
| standard / capability / contracts | `src/standard/`, `src/capability/`, `src/contracts/` | Metaproject Standard, command registry, capability seams | 11/11, 6/8, 4/2 |
| rules / stack / sync / assets | `src/rules/`, `src/stack/`, `src/sync/`, `src/assets/` | entrypoint management, stack detect, reconcile, asset pull | — |
| eval | `src/eval/` | eval corpus + gate | 2 / 2 |
| Library API | `src/core.ts` → `dist/core.js` (`package.json` `main`/`exports`) | programmatic core export | `core-package.test.ts` |
| VS Code extension | `vscode-extension/` (`keryx-vscode` 0.1.0, `"private": true`) | visual layer; **not published** (private) — UNCONFIRMED whether on Marketplace | — |

---

## 2. Proposed documentation areas (site nav)

| # | area | covers | source paths |
|---|---|---|---|
| 1 | Get started (install, first run, doctor, setup) | install methods, `init`, `doctor`, `setup`, `status`, `update`, `version` | `scripts/install*.sh`, `install`, `install.ts`, `src/commands/{init,doctor,setup,status,update,version}.ts` |
| 2 | Project knowledge (graph, ctx, wiki, memory, orient) | gdgraph, gdctx, gdwiki, memory, orient, sync, stack | `src/gdgraph/`, `src/ctx/`, `src/wiki/`, `src/memory/`, `src/sync/`, `src/stack/`, `src/commands/orient.ts` |
| 3 | The keryx shell (TUI agent) | shell flags, slash commands, sessions, rewind, permission modes, settings/themes, /goal, /plan | `src/tui/`, `src/commands/shell*.ts`, `src/session/`, `src/rewind/`, `src/commands/permission-mode.ts`, `goal-command.ts` |
| 4 | Models & providers | providers, auth (subscriptions), routing, external block, web search | `src/harness/provider/`, `src/commands/{providers,auth,routing,external}.ts`, `src/lib/oauth/`, `src/harness/search/` |
| 5 | Agent harness & safety | permission modes, sandbox, `harness exec/run/replay`, hooks, security | `src/harness/{policy,process/sandbox,hooks}`, `src/commands/{harness,sandbox,hooks,security}.ts`, `src/security/` |
| 6 | Connect your agents (integrations) | `integrations`, `integrate`, `agents bootstrap`, `serve-mcp`, ACP server | `src/integrations/`, `src/mcp/`, `src/acp/`, `src/agents/bootstrap.ts` |
| 7 | MCP servers in the shell (consumer) | `mcp add/list/trust/auth/doctor` | `src/mcp-servers/`, `src/mcp-client/` |
| 8 | Delegation: subagents & external agents | agent catalog, `agents external`, ACP client, bus, slate | `src/agents/`, `src/harness/external/`, `src/bus/`, `src/session/external-slate.ts` |
| 9 | Managed work (flows, jobs, review) | flow lifecycle, job packages, review packages, Jev checks, PR bot action | `src/flow/`, `src/job/`, `src/review/`, `action.yml` |
| 10 | Quality: health & testing | health gate, test related/coverage, metrics | `src/health/`, `src/testing/`, `src/metrics/` |
| 11 | Skills, rules & learning | gdskills, rules, learn loop, bundle portability | `src/gdskills/`, `src/rules/`, `src/learning/`, `src/bundle/` |
| 12 | Automation & remote control | trigger, schedule, serve + approvals, CI usage | `src/trigger/`, `src/commands/{schedule,serve,approvals}.ts`, `src/lib/serve-server.ts` |
| 13 | Governance & data lifecycle | governance, product, retention, forgetting, dashboard | `src/governance/`, `src/product/`, `src/retention/`, `src/forgetting/`, `src/commands/dashboard.ts` |
| 14 | Shared Agent Context (experimental, opt-in) | `workspace` | `src/sac/`, `src/commands/workspace.ts` |
| 15 | Reference | CLI reference (generated from `CLI_ROUTES` + `GROUP_SUBCOMMANDS`), Metaproject Standard, modules, `commands` registry, limitations, architecture | `src/cli-registry.ts`, `src/lib/group-subcommands.ts`, `src/standard/` |

---

## 3. Drift report

### 3.1 Automated checks that already pass (run now)

| check | result |
|---|---|
| `bun scripts/check-doc-links.ts` | 1757 relative links across 543 files, **0 broken** — dead internal links are not a current problem |
| `bun scripts/check-retired-cli-spellings.ts` | 3443 files, 63 retired spellings seen, **0 undeclared** (all exempted or in was→is tables) |
| `src/cli-reference-coverage.test.ts` | enforces verb-level coverage of `CLI_ROUTES` in cli-reference (by its own comment, verb-level only — `cli-registry.ts:105-107`) |

### 3.2 Verified drift items

| # | doc path:line | claim | code evidence | severity |
|---|---|---|---|---|
| 1 | `src/cli-registry.ts:253` (USAGE_BODY, printed by `keryx --help`; mirrored in cli-reference) | `harness run --provider <fake\|anthropic\|ollama>` | `make-provider.ts` also builds `openai`, `gemini`, `openai-codex` and the compat registry; `harness run --provider gemini` runs (fails closed only on missing `GEMINI_API_KEY`) | wrong (help text) |
| 2 | `src/cli-registry.ts:308` / `keryx --help` | `ctx` has only `ctx status` | `group-subcommands.ts:62`: `status diff rg read run show hook install-hook uninstall-hook` — the most-used verbs (`rg`, `run`, `read`) are absent from flat help | missing |
| 3 | `src/cli-registry.ts:309-313` | `wiki` lists 5 subcommands | 15 real (`group-subcommands.ts:64-83`, incl. `ask freshness refresh verify sections enrich context backlinks validate`) — the file's own comment admits it (`:17-20`) | missing |
| 4 | `src/cli-registry.ts:314-327` | `skills` lists 13 lines | 22 real (`doctor uninstall generate import update remove scout eval judge-check stocktake` missing) | missing |
| 5 | `src/cli-registry.ts:330-340` | `test` (3), `memory` (4), `flow` (4) subcommands | `test` 10, `memory` 10, `flow` 22 (`group-subcommands.ts:91-121`) | missing |
| 6 | `src/cli-registry.ts:250` | `bus list\|log\|send\|prune` | also `pause`, `resume` (`group-subcommands.ts:` bus entry) | missing |
| 7 | `src/cli-registry.ts:282-288` | routing without `stats` | `routing stats` exists (`group-subcommands.ts:50`) | missing |
| 8 | `src/cli-registry.ts:385` | `trigger run <name>` only | `install uninstall list status schedule resolve` too | missing |
| 9 | `src/cli-registry.ts:303-304` | `agents bootstrap status\|install` only | `bootstrap uninstall/print`, `monitor`, `external …`, `list show export verify generate` (see `keryx agents --help`) | missing |
| 10 | `src/cli-registry.ts:347` | `review attach\|start\|ingest\|status\|complete` | 31 subcommands incl. `bot conform ci-triage jev-*` (`group-subcommands.ts:125-160`) | missing |
| 11 | `src/cli-registry.ts:362-366` | security without `audit-harness`, `impact-evidence` | `group-subcommands.ts` security entry | missing |
| 12 | `src/cli-registry.ts` (whole USAGE_BODY) | no line for consumer `keryx mcp list/add/trust/auth/doctor…` (only the retired `mcp serve/install`) | `mcp-servers.ts:62-73`; README:781-802 does document them | missing (help) |
| 13 | `docs/docs/cli-reference.md` | no literal `keryx <g> <s>` for: `modules status/list/enable/disable/on/off/interactive`, `projects list/register/forget`, `ctx hook`, `review stack`, `standard baseline`, `sessions fork/export/path`, `skills generate` | `group-subcommands.ts` | missing (may be documented in a bracketed form — UNCONFIRMED per item) |
| 14 | `mkdocs.yml:70-110` | nav omits `docs/docs/jev-in-review.md` | file exists in `docs_dir` | stale (orphan page, published but unreachable from nav) |
| 15 | `mkdocs.yml:11-12` | comment: "the eight pages a reader actually needs" | nav lists 34 pages | stale (comment only) |
| 16 | `README.md` | no mention of verbs `doctor, setup, projects, sync, skills, stack, metrics, job, rules, standard, commands, sandbox, serve-mcp, integrations, bus, retention, forgetting, hooks, bundle, learn` (no literal `keryx <verb>`) | `CLI_ROUTES` | missing (README is not a reference; flag only `doctor`, `setup`, `integrations`, `skills`, `serve-mcp` as launch-relevant) |
| 17 | `docs/docs/onboarding.md:199-246` / `README.md` | curl `install` / `install.ts` / `scripts/install.sh` presented next to npm | these clone **git `main`** (`scripts/install.sh:5,126`), not the published npm release; `--global` runs `src/cli.ts` from source | stale (needs an explicit "tracks main, not a release" note) — UNCONFIRMED whether docs already say so |
| 18 | provider naming | compat providers report `providerId: "ollama"` in `describe()` | `make-provider.ts` header (flow 183 T5) | stale (user-visible label risk) — UNCONFIRMED where surfaced |

### 3.3 Features in code with no user-doc page (no nav page; may be covered inside cli-reference)

`bus`, `governance`, `product`, `retention`/`forgetting`, `bundle` (guide `portability.md` covers it), `metrics`, `schedule`/`trigger` (only mentioned in other pages), `serve` + `approvals` (guides `drive-keryx-remotely`, `answer-remote-approvals` cover it), `mcp` consumer side (README only), `auth` subscriptions, `routing`, `external` block, `dashboard`, `stack`, `standard`, `vscode-extension/`, `action.yml` review bot (guide `review-as-a-pr-bot.md` covers it). UNCONFIRMED depth of coverage inside `cli-reference.md`/`modules.md`.

### 3.4 cli-reference.md / commands-by-task.md (sub-audit, help output and handler verified)

Every `CLI_ROUTES` verb has a `##` section in cli-reference except the internal `__sandbox-net-forward`. Drift is below verb level, where `cli-reference-coverage.test.ts` does not look.

| doc path:line | claim | code evidence | severity |
|---|---|---|---|
| cli-reference.md:6192 | `integrate` writes `args: ["mcp","serve","--cwd",…]` | `src/mcp/client-config.ts:33-34` `MCP_SERVER_ARGS = ["serve-mcp"]` | wrong |
| cli-reference.md:1065-1068 | `harness run --provider` list | `src/commands/harness.ts:83-91`: also openai, gemini, rapid-mlx, github-copilot | wrong |
| cli-reference.md:3386,3420 | `flow task add --kind context\|implement\|test\|review\|docs` | `flow --help` also lists `verify` | wrong |
| cli-reference.md:115,6461 | `mcp serve` given as the current spelling | retired, replaced by `serve-mcp` (`cli-registry.ts:156-160`) | stale |
| cli-reference.md:1244 | `init --mcp` tells the reader to use `mcp serve` / `mcp install` | both are retired spellings | stale |
| cli-reference.md:103 | `mcp` row = publisher | `mcp` is now the consumer client plus retired aliases (`mcp-servers.ts:62`) | stale |
| cli-reference.md:6170-6193 | `## mcp` section opens with publisher content | the consumer content only starts at :6221 | stale |
| cli-reference.md:100 | `agents` = bootstrap only | also covers monitor, external and the catalog | stale |
| cli-reference.md:4150,4159 | `agents show <name>` has no flags | `[--json]` exists | stale |
| cli-reference.md:6010 | `security scan` flags | `--recursive/--no-recursive --exclude --max-files --max-bytes` are missing | stale |
| cli-reference.md:6018-6019 | `check-input/check-output` | `--runtime <id>` is missing | stale |
| cli-reference.md:1242-1246 | init capability flags | `--sac/--no-sac` and `--external-agents` are missing (`init.ts:1307,1376,1386`) | stale |
| cli-reference.md:3379 | `flow init` synopsis | `--require-confirmation` is missing | stale |
| cli-reference.md:4204-4258 | `review` synopsis block | omits `jev-*` and `stack` (each has its own subsection) | stale |
| cli-reference.md:1422 | `providers remove` | `--json` is missing | stale |
| commands-by-task.md:146,58 | `agents` and `sessions` one-liners | source table `src/standard/help-groups.ts` is stale | stale |
| commands-by-task.md | "Every keryx CLI verb" | `skill-verify-skill` and `session` are absent (UNCONFIRMED whether excluded by design) | missing |
| cli-reference.md:66-105 | "Top-level commands" table | 18 verbs are absent from the table: setup, providers, routing, external, auth, approvals, trigger, schedule, governance, hooks, bundle, learn, sandbox, serve-mcp, integrate, integrations, retention, forgetting | missing |
| cli-reference.md:247-265 | `shell` flags | `-p/--print --events-file --events-max-field --permission-mode --deny-tools --ask/--trust/--auto` are missing | missing |
| cli-reference.md:4003-4008 | `standard` | `standard baseline` is missing | missing |
| cli-reference.md:1985-2002 | `trigger` | `run --schedule` and `resolve <runId> --spent` are missing | missing |
| cli-reference.md:4184,4191 | `orient uninstall-hook` | no such handler found | UNCONFIRMED |
| cli-reference.md:3119 | "65 SKILL.md files" | count not verified | UNCONFIRMED |

Not listed above (~9 items): three tables split by interleaved prose (harness :1061-1093, memory :3349-3353, flow ac :3430-3431), plus minor placeholder mismatches.

### 3.5 Concept pages and guides (sub-audit, appended after hand-back)

The mechanical checks were clean: every relative link resolves, every cited `src/` path exists, and the guides contain no retired spellings. hooks.md and learning.md match their `--help` output, and all 21 guides are in the nav.

| doc path:line | claim | code evidence | severity |
|---|---|---|---|
| modules.md:1087-1099, :58 | `mcp serve` / `mcp install\|uninstall` shown as the live surface | `mcp --help` says these are retired; the replacements are `serve-mcp` (`--http --cwd --read-only --harness`) and `integrate` | wrong |
| architecture.md:134 | the CLI verb for the MCP module is `mcp` | `serve-mcp` / `integrate` (`cli-registry.ts:156-160`) | wrong |
| architecture.md:212 | the SDK loads "on the `mcp serve` path" | it loads on the `serve-mcp` path | wrong |
| architecture.md:78,96 | `CLI_ROUTES` is at `src/cli.ts:51` with about 31 verbs | it is at `src/cli-registry.ts:109-182` with about 62 verbs (modules.md:44 makes the same mistake: "if-chain", about 16 verbs) | wrong |
| architecture.md:666 | "no `src/ctx/` dir" | `src/ctx/` exists, and the same page cites it at :118 and :129 | wrong |
| architecture.md:667 | the external runtime was "verified offline only" | harness.md:430-436 records live claude/agy runs; transcripts are in `fixtures/external/live/` | wrong |
| integrations.md:228-232 | `keryx-shell` is a placeholder and every surface is unsupported | `integrations matrix` shows its adapter as verified, with 8 surfaces | wrong |
| architecture.md:3 | "Reviewed … for 0.2.157" | the package is 0.3.46 | stale |
| integrations.md:50-61 | `--runtime <id>` takes a single id | it also takes `<id>[,<id>…\|all]` | stale |
| integrations.md:158-226 | per-harness surface notes | kiro also has `agents` and `rules`; the zed adapter is experimental (per-surface confidence UNCONFIRMED) | stale |
| harness.md:27-30 | providers are anthropic, ollama, fake plus 8 gateways | openai, gemini and openai-codex are missing; `auth`, `providers` and `routing` are never documented | stale |
| modules.md:1475 | shell flags | 12 flags are missing (see 3.4) | stale |
| modules.md:1317-1340; architecture.md:116 | `agents` = bootstrap only | it also has monitor, external and the catalog | stale |
| modules.md:44-61 | top-level table of about 16 verbs | more than 40 verbs are missing | stale |
| architecture.md:139 | slash inspectors are `/status` and `/flows` | the real set is about 60 slash commands | stale |
| architecture.md:132 | `assets` is a top-level verb | it is only a subcommand of `gdgraph` and `memory` | stale |
| integrations.md:12-15 | `integrate` is described as "MCP client configuration" | `integrate` registers keryx as an MCP server; the MCP client side is `keryx mcp` and `src/mcp-client` | stale |
| all 7 core pages | no coverage of: bus, retention/forgetting, auth/providers/routing/external, the ACP server, the MCP consumer, rewind, metrics, sandbox, bundle, stack, doctor, setup, version | `src/commands/*` | missing |
| harness.md:15, integrations.md:12 | "harness run and serve register no tools" | not traced | UNCONFIRMED |

Not listed above, by file: architecture ~6, harness ~3, integrations ~2, hooks ~1-2, modules ~10, learning ~1, workspace-and-lifecycle ~3, guides ~8. These are mostly flags that were checked by subcommand name only, not flag by flag.

### 3.6 README and entry docs (sub-audit, appended after hand-back)

No dead links and no retired spellings. The Bun floor (>=1.3.14) and the version (0.3.46) are consistent everywhere they appear. The "nine default modules" claim is consistent. The `keryx mcp add/doctor/list` in the README is the current consumer surface, not a retired spelling.

| doc path:line | claim | code evidence | severity |
|---|---|---|---|
| onboarding.md:79 | `bunx keryx` runs the bundle | unscoped `keryx` on npm is a different package; ours is `@mrciphersmith/keryx` (`package.json:2`) | wrong |
| README.md:970 | codex write mode needs >=0.159.0 | `dispatch.ts:101` requires min 0.159.2 and refuses 0.160.0 or later; README.md:536-537 itself says 0.159.2 | wrong |
| agent-installation-playbook.md:203,286 | `ctx install-hook --runtime zcode\|generic-mcp` | rejected: `src/ctx/runtimes.ts` accepts claude, codex, cursor, windsurf, antigravity, opencode, gemini-cli, kiro, github-copilot-agent, all | wrong |
| onboarding.md:574 | `integrate all` = cursor + claude | it is cursor, claude and opencode; `vscode` and `generic` are also valid (`integrate.ts:157`) | stale |
| agent-installation-playbook.md:203 | `integrate` supports cursor and claude only | it also supports opencode, vscode and generic | stale |
| README.md:805-806 | MCP OAuth is "next" | `keryx mcp auth` and `keryx mcp logout` already ship (`mcp.ts:149-150`) | stale |
| README.md:969 vs limitations.md:17,49 | "four of five" vs "five" commands exit non-zero without a credential | the two docs contradict each other; which is correct is UNCONFIRMED | stale |
| complete-setup-and-agent-workflows.md:669 | task kinds | `verify` is missing | stale |
| onboarding.md:548 | `update` self-refreshes the runtime from origin/main | only for managed or project clones; npm and binary installs skip it (`update.ts:1596-1604`) | stale |
| complete-setup-and-agent-workflows.md:107-110 | `KERYX_REF="v0.1.0"` pin example | uses an ancient tag; also does not mention `KERYX_RELEASE_TAG` for the binary | stale |
| docs/docs/README.md:14-15 | `bun install -g github:MrCipherSmith/keryx` | whether this works (bin points at the built `dist/`) is UNCONFIRMED | UNCONFIRMED |
| agent-installation-playbook.md:280-289 | runtime matrix covers 8 runtimes | gemini-cli, kiro, github-copilot-agent and vscode are missing | missing |
| index.md:10-24 | Contents list | `jev-in-review.md` is missing | missing |
| README, onboarding, playbook, complete-setup | no mention of `keryx doctor` / `keryx setup` | `cli-registry.ts:120-122` | missing (launch-relevant) |
| complete-setup, onboarding | no coverage of bundle, job, bus, hooks, retention, forgetting, `sandbox status` | `CLI_ROUTES` | missing |

Install verdict: npm, the standalone binary, the managed clone and the project clone are all real. There is no Homebrew formula, and `bunx keryx` is wrong.

### 3.7 Drift totals

| category | count |
|---|---|
| wrong | about 17 across 3.2 and 3.4-3.6 |
| stale | about 40 |
| missing | about 20 |
| not itemised | about 40, mostly flag-level in modules.md, the guides and cli-reference |

Top fixes before announcing:
1. Purge `mcp serve` / `mcp install` from modules.md, architecture.md and cli-reference.md.
2. Fix the `integrate` args in cli-reference.md:6192.
3. Fix `bunx keryx` in onboarding.md.
4. Fix the codex version in README.md:970.
5. Fix the playbook's `ctx install-hook` runtimes.
6. Fix the `CLI_ROUTES` location and verb count in architecture.md.
7. Fix the keryx-shell row in integrations.md.
8. Document `doctor` and `setup` in the Get started area.
9. Regenerate the flat `--help` USAGE_BODY from `GROUP_SUBCOMMANDS`.

---

## 4. Platforms, runtimes, providers, install methods

| dimension | what the code defines | evidence |
|---|---|---|
| Runtime | **Bun ≥ 1.3.14** required (npm `bin` is `dist/cli.js` built `--target bun`); Node is used only by CI to publish. Running under Node is handled defensively but not a supported runtime — UNCONFIRMED that it works | `package.json:97-99`, `:43`; `.github/workflows/release.yml` ("Node is here for that, not to run the project"); doctor prints `Bun 1.4.2 (floor >=1.3.14)` |
| Shebang | `#!/usr/bin/env -S bun --no-env-file --config=/dev/null` (blocks cwd `.env`/`bunfig` preload) — fails on BusyBox `env` (Alpine) | `src/cli.ts:1-35` |
| OS | macOS and Linux. Windows: no shebang, no standalone binary, sandbox unsupported (contained runs fail closed). Alpine/musl: no binary, shebang fails | `src/cli.ts:20-30`, `scripts/install.sh:57-87`, `scripts/install-binary.sh:72-93` |
| Sandbox | macOS Seatbelt (`sandbox-exec`): fs containment, network-off, domain allowlist, credential masking. Linux bubblewrap: fs + network-off only; allowlist/masking not implemented | `scripts/install.sh:60-81`, `keryx sandbox status` |
| Install: npm | `npm install -g @mrciphersmith/keryx` (needs Bun on PATH) | `package.json`, release workflow publishes with provenance on `v*` tag |
| Install: standalone binary | `scripts/install-binary.sh` → GitHub Release assets `keryx-bun-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}`, sha256 from GitHub API; no Bun needed | `release.yml:229-240`, `install-binary.sh` |
| Install: from source | `install` (bash) / `install.ts` (`curl … \| bun -`) → `scripts/install.sh --global` clones git `main` into `~/.keryx/keryx`, wrapper at `~/.local/bin/keryx`; `--project` clones into `.metaproject/runtime/keryx` and runs `init`. Requires git + bun | `install`, `install.ts`, `scripts/install.sh` |
| Homebrew | **No Homebrew formula/tap** for keryx (brew appears only as a way to install `ripgrep`) | `docs/docs/limitations.md:69`; no formula in repo — UNCONFIRMED no external tap |
| Optional deps | `@modelcontextprotocol/sdk` (MCP), `@opentui/core` (TUI), `web-tree-sitter` (graph symbols); zero hard `dependencies` | `package.json:73,83-87` |
| External tools | `ripgrep` needed for `ctx rg`/search; `git` for hooks; `gh` optional | doctor checks; `scripts/install.sh:129-141` |
| Model providers (native) | `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`, Responses API), `gemini` (`GEMINI_API_KEY`/`GOOGLE_API_KEY`), `ollama` (loopback), `openai-codex` (ChatGPT subscription OAuth), `fake` (offline). Missing key → fail closed | `src/harness/provider/make-provider.ts` |
| Model providers (OpenAI-compatible registry) | openai, openrouter, deepseek, zai, zai-coding, cerebras, groq, rapid-mlx (darwin only), moonshot, grok, github-copilot; plus user-defined custom compat providers | `OPENAI_COMPAT_PROVIDERS` in `src/commands/providers.ts` |
| Subscription auth | SuperGrok, ChatGPT Plus/Pro, GitHub Copilot | `keryx auth` description, `src/lib/oauth/` |
| External agents | `codex-cli`, `claude-cli` (write mode), `antigravity-cli`, `gemini-acp` | `src/harness/external/registry.ts:29,49,70,100` |
| Web search | duckduckgo, searxng (local), brave, tavily, exa | `src/harness/search/registry.ts:130,187,246-247` |
| Integration targets | claude, codex, cursor, windsurf, antigravity, opencode, zed, generic-mcp, gemini-cli, kiro, github-copilot-agent, keryx-shell; `integrate` editors: cursor, claude, opencode, vscode, generic | `src/integrations/registry.ts` `HARNESS_ADAPTERS`; `cli-registry.ts:368` |
| Bootstrap runtimes | claude, opencode, zcode, codex, antigravity | `keryx agents --help` |
