#!/usr/bin/env bun
// retired-spellings-ok: file — help text still lists the retired usage lines because those invocations still work; removing them would hide a working command

import { runModelTurn } from "./harness/provider/single-turn";
import { setModelTurnPort } from "./sac/model-turn-port";

import { initCommand } from "./commands/init";
import { ctxCommand } from "./commands/ctx";
import { gdgraphCommand } from "./commands/gdgraph";
import { wikiCommand } from "./commands/wiki";
import { orientCommand } from "./commands/orient";
import { syncCommand } from "./commands/sync";
import { skillVerifySkillCommand, skillsCommand } from "./commands/skills";
import { healthCommand } from "./commands/health";
import { testCommand } from "./commands/test";
import { memoryCommand } from "./commands/memory";
import { flowCommand, printFlowHelp } from "./commands/flow";
import { jobCommand } from "./commands/job";
import { reviewCommand } from "./commands/review";
import { rulesCommand } from "./commands/rules";
import { standardCommand } from "./commands/standard";
import { commandsCommand } from "./commands/commands";
import { securityCommand } from "./commands/security";
import { sandboxCommand } from "./commands/sandbox";
import { mcpCommand } from "./commands/mcp";
import { printServeMcpHelp, serveMcpCommand } from "./commands/serve-mcp";
import { integrateCommand } from "./commands/integrate";
import { statusCommand } from "./commands/status";
import { harnessCommand } from "./commands/harness";
import { ShellFlagError, shellCommand } from "./commands/shell";
import { sessionsCommand } from "./commands/sessions";
import { acpCommand } from "./commands/acp";
import { busCommand } from "./commands/bus";
import { modulesCommand } from "./commands/modules";
import { projectsCommand } from "./commands/projects";
import { serveCommand } from "./commands/serve";
import { updateCommand } from "./commands/update";
import { dashboardCommand } from "./commands/dashboard";
import { agentsCommand } from "./commands/agents";
import { metricsCommand } from "./commands/metrics";
import { versionCommand } from "./commands/version";
import { workspaceCommand } from "./commands/workspace";
import { providersCommand } from "./commands/providers";
import { authCommand } from "./commands/auth";
import { retentionCommand } from "./commands/retention";
import { forgettingCommand } from "./commands/forgetting";
import { printTriggerHelp, triggerCommand } from "./commands/trigger";
import { scheduleCommand } from "./commands/schedule";
import { governanceCommand, printGovernanceHelp } from "./commands/governance";
import { sandboxNetForwardCommand } from "./commands/sandbox-net-forward";
import { helpCommand } from "./commands/help";
import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

/**
 * Every top-level CLI verb, mapped to its handler. Each handler receives the
 * arguments AFTER the verb.
 *
 * This is exported because it is the only honest source for "what commands does
 * this CLI actually have". The descriptor registry in `src/standard` is
 * hand-curated, and a coverage test that compares it against another
 * hand-written list proves nothing — it just compares two copies of the same
 * belief. Deriving the surface from the dispatch table means a new verb added
 * here fails the coverage test until it is either described or explicitly
 * excluded with a reason.
 *
 * Limit worth stating: this is verb-level. It cannot see that `wiki` grew a new
 * subcommand, because subcommand parsing lives inside each handler. It catches
 * the failure that actually happened twice, not every possible one.
 */
export const CLI_ROUTES: Record<string, (rest: string[]) => Promise<void> | void> = {
  init: initCommand,
  // Flow 303 (AC10): grouped command help by task. `--help`/`-h`/bare `keryx`
  // keep printing the flat USAGE_BODY below (AC5) — this is a SEPARATE verb.
  help: helpCommand,
  status: statusCommand,
  modules: modulesCommand,
  projects: projectsCommand,
  providers: providersCommand,
  auth: authCommand,
  serve: serveCommand,
  update: updateCommand,
  dashboard: dashboardCommand,
  dash: (rest) => dashboardCommand(rest.length > 0 ? rest : ["open"]),
  gdgraph: gdgraphCommand,
  ctx: ctxCommand,
  wiki: wikiCommand,
  orient: orientCommand,
  sync: syncCommand,
  skills: skillsCommand,
  "skill-verify-skill": skillVerifySkillCommand,
  health: healthCommand,
  metrics: metricsCommand,
  test: testCommand,
  memory: memoryCommand,
  flow: flowCommand,
  job: jobCommand,
  review: reviewCommand,
  rules: rulesCommand,
  agents: agentsCommand,
  standard: standardCommand,
  commands: commandsCommand,
  security: securityCommand,
  sandbox: sandboxCommand,
  "serve-mcp": serveMcpCommand,
  integrate: integrateCommand,
  // Retired spelling of the two verbs above; kept working, kept thin.
  mcp: mcpCommand,
  harness: harnessCommand,
  shell: shellCommand,
  sessions: sessionsCommand,
  session: sessionsCommand,
  acp: acpCommand,
  bus: busCommand,
  version: versionCommand,
  workspace: workspaceCommand,
  retention: retentionCommand,
  forgetting: forgettingCommand,
  trigger: triggerCommand,
  schedule: scheduleCommand,
  governance: governanceCommand,
  // Flow 301 (AC5): internal helper only — `planUnattendedSandbox.wrap()` invokes this
  // from inside the sandbox; no operator ever types it. Excluded from the CLI
  // reference with a reason (`DOCUMENTED_ELSEWHERE` in `cli-reference-coverage.test.ts`).
  "__sandbox-net-forward": sandboxNetForwardCommand,
};

export async function main(): Promise<void> {
  // The client supplies the model turn that core refuses to import.
  //
  // `src/sac/**` declares a port and holds no provider: the norm forbids a
  // provider registry, model selection, credentials and live model calls inside
  // core, and a build-graph test fails if any of them reappear there. Without
  // this registration the SAC paths that need a model turn refuse by name
  // rather than pretending to have run one, which is correct but is not what a
  // user with a key configured expects. The CLI is the client, so it registers.
  //
  // Inside `main`, not at module scope: a registration at import time changes
  // the behaviour of every process that merely imports this file, which turned
  // three tests asserting the unwired refusal green for the wrong reason.
  setModelTurnPort(async (request) => runModelTurn(request));

  const args = process.argv.slice(2);
  const command = args[0];

  // `--help`, `-h` and bare `keryx` print the flat USAGE_BODY, unchanged
  // (AC5, flow 303). `help` used to be a third alias of that same branch;
  // it is now its own route (below, via CLI_ROUTES.help ->
  // `commands/help.ts`) so `keryx help` with no args can print the grouped
  // view (AC3) while these three keep printing exactly what they printed
  // before this flow.
  if (command === "--help" || command === "-h" || !command) {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  // Bare `keryx` is the CLI surface (help above). The interactive TUI agent
  // harness is only `keryx shell […]`. Do not route stray `--flags` into shell.

  const route = CLI_ROUTES[command];
  if (route) {
    // Ask for usage, do not DO anything. The guard sits here, in front of every
    // group, so a future subcommand cannot forget it — and it is skipped for
    // tokens after `--`, which are the child process's own.
    if (shouldInterceptHelp(command, args.slice(1))) {
      // A group in this map still gets intercepted — no mutating subcommand
      // handler ever runs on a stray `--help` — but the TEXT printed is the
      // group's own help, not a second, independently-drifting slice of
      // `USAGE_BODY` (AC5, flow 294). `groupUsage`'s slice is what silently
      // dropped `flow owner`/`flow ac`/half of `flow`'s subcommands and every
      // `trigger` subcommand but `run` — this is the fix for that class of
      // drift, applied without touching the "ask, don't do" guard above.
      await printCommandHelp(command);
      return;
    }
    await route(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

/**
 * The usage body `printHelp` prints — and the single source {@link groupUsage}
 * reads a group's own lines from. Hoisted rather than duplicated: a second copy
 * of this text would drift from the one operators actually read.
 */
export const USAGE_BODY = `Usage:
  keryx                                        Show CLI usage
  keryx help [group|command]                   Grouped command help by task (--help/-h keep this flat usage)
  keryx shell [-c|--continue] [-r|--resume [id]] [--provider <p>] [--model <m>] [--base-url <url>] [--agent|--chat] [--tui|--no-tui]
                                               Start TUI agent shell (sessions are per-project)
  keryx sessions list|fork <id>|export <id>|path
                                               List / branch / export sessions for the current project
  keryx acp [--provider <p>] [--model <m>] [--base-url <url>] [--data-dir <dir>]
                                               Agent Client Protocol agent server over stdio
  keryx bus list [--json] | log [--since <seq>] [--limit N] [--json] | send <@name|@all> [--kind <k>] [--reply-to <id>] <text> | prune
                                               Agent bus: peers, events and messages shared across this clone's worktrees
  keryx version check [--json]                 Check npm latest (advisory; never installs)
  keryx harness run --provider <fake|anthropic|ollama> --model <m> [--base-url <url>] [--record <path>] "<prompt>"
  keryx harness exec [--allow-env KEY]... [--max-runtime-ms N] [--allow-real-subprocess]
                     [--allowed-domains a,b] [--mask-env NAME@host] [--tls-terminate] [--mask-mode auto|manual|off] [--auto-mask] -- <path> [args...]
  keryx harness extension --spec <path>
  keryx harness wave --spec <path>
  keryx harness replay --record <path> [--fixture <path>] [--write-fixture <path>] [--json]
                                               Validate a recorded run's log against a fixture (no re-execution)
  keryx init [--yes] [--no-gdgraph] [--no-gdctx] [--no-gdwiki] [--no-gdskills] [--gdskills-profile recommended] [--no-health] [--no-testing] [--no-memory] [--no-gdgraph-hook] [--no-gdskills-hook] [--no-health-hook] [--no-testing-post-commit-hook] [--no-testing-pre-push-hook]
  keryx status
  keryx modules [status | enable <name> | disable <name>]
  keryx projects [list [--json] | register <path> | forget <id>]
  keryx serve [--bind <addr>] [--port <n>] [--profile <name>] [--acknowledge-non-loopback]
  keryx serve status [--json]
  keryx serve token issue | rotate | revoke
  keryx serve config init|set|show
  keryx update [--skip-runtime] [--hooks]
  keryx dashboard build
  keryx dashboard open
  keryx dash
  keryx rules sync
  keryx sync [--apply]
  keryx sync install-hooks | uninstall-hooks
  keryx providers list [--json]
  keryx providers cross-family [--opt-in] [--json]
  keryx auth list [--json]
  keryx auth login <provider>
  keryx auth logout <provider>
  keryx auth status <provider> [--json]
  keryx health run [--strict] [--changed [--since <ref>]] [--scope <s>] [--source a,b]
  keryx health status | gate [--strict-warn] | sources | trend
  keryx health explain <file-or-module> [--narrate] [--json]
  keryx health baseline update [--scope <s>]
  keryx orient [<runtime>]
  keryx orient install-hook [--runtime <id|all>] [--dry-run]
  keryx agents bootstrap status --runtime <claude|opencode|zcode|codex|antigravity|all>
  keryx agents bootstrap install --runtime <claude|opencode|zcode|codex|antigravity|all> [--dry-run]
  keryx gdgraph build
  keryx gdgraph query <cycles|orphans>
  keryx gdgraph affected <file>
  keryx ctx status
  keryx wiki status
  keryx wiki new <type> <slug> --title "<title>"
  keryx wiki collect [--force] [--limit <n>]
  keryx wiki index
  keryx wiki check-links
  keryx skills status
  keryx skills list
  keryx skills inspect <project-skill>
  keryx skills route <query-or-target>
  keryx skills catalog [--profile recommended]
  keryx skills install [--profile recommended]
  keryx skills create <target> --module <module> --name <skill-name>
  keryx skills verify <skill-or-target>
  keryx skills learn --from-review <path> --skill <module>/<skill>
  keryx skills learn apply <proposal.json>
  keryx skills export <project-skill> --runtime codex|claude|plugin
  keryx skills sync --runtime codex|claude --target <dir>
  keryx skill-verify-skill <skill-or-target>
  keryx skills contracts validate <file> --schema subagent-result
  keryx metrics status|collect|validate|latest|show|plan|benchmark
  keryx test analyze
  keryx test run [--changed]
  keryx test status
  keryx memory new <type> --title "<title>"
  keryx memory search "<query>" [--status accepted]
  keryx memory index
  keryx memory ingest --from-review <path>
  keryx flow init (--issue <url> | --title "<t>")
  keryx flow list
  keryx flow status <id>
  keryx flow complete <id> [--comment]
  keryx job init --name <slug> [--intent implement|analyze|review|custom] [--project <path>]
  keryx job list [--json]
  keryx job status <name> [--json]
  keryx job step <name> <step-id> --status pending|in-progress|completed|skipped|failed [--reason "<text>"]
  keryx job document <name> --type analysis|implementation-report|review|verification-report --file <path>
  keryx job complete <name>
  keryx review attach|start|ingest|status|complete
  keryx standard validate
  keryx standard doctor
  keryx standard capabilities
  keryx standard baseline --baseline <status> --pr <status>
  keryx standard emit llms [--stdout]
  keryx commands [--json] [--module <name>] [--intent "<phrase>"] [--intents]
  keryx security status
  keryx security scan <path> [--json]
  keryx security scan-mcp <manifest|dir> [--json]
  keryx security check-input [--source <kind>] [--file <path>]
  keryx sandbox status [--json]
                                               OS sandbox launcher availability + per-capability containment matrix (report, not a gate)
  keryx security check-output [--target <kind>] [--file <path>]
  keryx security redact <path> [--out <path>]
  keryx security report [--since <ref>]
  keryx security policy validate
  keryx security incidents [--limit <n>]
  keryx security hooks install --runtime <claude|cursor|windsurf|generic-mcp|all>
  keryx security eval [--corpus <name|all>] [--with-model]
  keryx serve-mcp [--http] [--read-only] [--cwd <project-root>]
  keryx integrate [--remove] <cursor|claude|opencode|vscode|generic|all> [--dry-run]
  keryx mcp serve [--http] ...                  # retired: use keryx serve-mcp
  keryx workspace create --title <title> [--component <workspace-relative-ref>]
  keryx workspace list|show|add-resource
  keryx mcp install|uninstall --runtime ...     # retired: use keryx integrate
  keryx retention status [--json]
  keryx retention sweep [--apply] [--target <id>]... [--max-age-days <n>] [--max-bytes <n>] [--json]
                                               Bound gdctx raw/artifacts logs and owner write-conflict
                                               sidecars; dry run by default, --apply removes
  keryx forgetting trail [--limit <n>] [--json]
  keryx forgetting lookup "<ref-or-path>" [--layer <layer>] [--search] [--json]
                                               Read the deletion trail: what was removed, when, at
                                               whose request, on what basis
  keryx trigger run <name>                      Perform exactly one pass of a declared trigger's
                                               action (.metaproject/triggers.json)
  keryx schedule add|list|show|pause|resume|run|remove
                                               Scheduled agent tasks: confirm a card, keryx installs
                                               a systemd --user timer (launchd/cron elsewhere)
  keryx governance report [--flow <id>] [--owner <name>] [--since <iso>] [--until <iso>] [--all-projects] [--json]
                                               Spend, confirmations, signatures and gate outcomes,
                                               unified across flows; writes latest.md/latest.json
  keryx governance show [--json]                Reprint the most recently written governance report
  keryx --version

Commands:
  help      Grouped command help by task: every verb, in nine onboarding-ordered groups
  shell     Start the interactive TUI agent harness. Use --no-tui or --chat to opt out.
            Sessions: -c continue last in this project, -r [id] resume (per-project).
  sessions  List or export per-project shell sessions
  acp       Speak ACP v1 (newline-delimited JSON-RPC) over stdio, for an ACP client (e.g. an editor)
  bus       Agent bus: list peers and leases, read the log, send a message, prune
  version   Check whether a newer npm release is available
  harness   Run a single provider turn (harness run) and print structured events
  init      Initialize .metaproject in the current project
  status    Show local Metaproject status
  modules   View and toggle Metaproject modules (interactive)
  projects  Inspect the user-global registry of initialized projects
  serve     Loopback-bound authenticated HTTP entry (off by default; read-only routes)
  update    Refresh managed service files without touching data artifacts
  dashboard Build or open the project admin dashboard
  dash      Rebuild and open .metaproject/keryx-dashboard.html
  rules     Sync root AGENTS.md/CLAUDE.md into high-priority project rules
  sync      Reconcile graph/wiki/memory with the current code, and wire the git hooks
  providers Providers this operator has configured, and cross-family review eligibility
  auth      Subscription login (SuperGrok, ChatGPT Plus/Pro, GitHub Copilot) and API-key status
  orient    Emit a bounded graph + wiki startup block, or install it as a turn-start hook
  agents    Manage optional global agent bootstrap instructions
  gdgraph   Build and query code dependency graph
  ctx       Run compact context commands and save raw output
  wiki      Manage the local project knowledge base
  skills    Manage bundled Metaproject working skills
  health    Aggregate code quality signals and run the quality gate
  test      Analyze testing context and normalize test reports
  memory    Store and search long-term project memory
  flow      Agent-first flow lifecycle (Task Manager)
  job       Agent-first job packages (job-orchestrator state, steps, documents)
  review    Managed review packages and lightweight report-only review mode
  standard  Validate the workspace against the Metaproject Standard
  commands  Agent-callable command registry (intents, args, output, model usage)
  security  Policy-based scanning, redaction, guardrails and audit reports
  sandbox   Report OS sandbox launcher availability and the per-capability containment matrix
  serve-mcp Expose Metaproject services over the Model Context Protocol (opt-in)
  integrate Wire this project into an editor or agent as an MCP server
  mcp       Retired spelling of serve-mcp / integrate; still works, names its replacement
  metrics   Provenance-aware execution observability: run records, baselines, benchmarks
  workspace Shared Agent Context: workspaces, FWK reads, propose/review (module sac)
  retention Bound stores that grow without bound (gdctx raw/artifacts, owner write-conflict sidecars)
  forgetting Read the deletion trail — was this removed, or did it never exist?
  trigger   Fire one declared project trigger (git hook, cron line, CI job) — one pass, one exit code
  schedule  Scheduled agent tasks in the background: create (with confirmation), list, pause, resume, remove
  governance Read-only report over already-recorded spend, confirmations, signatures and gate outcomes
`;

function printHelp(): void {
  console.log(`keryx ${VERSION}\n\n${USAGE_BODY}`);
}

/**
 * Does this argument list ask for help?
 *
 * `--help`/`-h` is recognized only as the FIRST argv token, so
 * `keryx skills install --help` used to RUN the install — which is how a
 * read-only question about a subcommand's usage installed 52 skills. Tokens
 * after a bare `--` belong to a CHILD process (`harness exec -- <cmd>`,
 * `ctx run -- <cmd>`), where `--help` is the child's own flag and must pass
 * through untouched. Pure.
 */
export function helpRequestedFor(rest: readonly string[]): boolean {
  const separator = rest.indexOf("--");
  const head = separator === -1 ? rest : rest.slice(0, separator);
  return head.some((token) => token === "--help" || token === "-h");
}

/**
 * The `Usage:` lines for one command group, or `undefined` when the group has
 * none. A group's block is its `keryx <group> …` line plus the indented
 * continuation lines that describe it — `sessions` has five of them, `skills`
 * thirteen — and never the next group's line. Pure.
 */
/**
 * Groups that implement their OWN `--help` (`args.includes("--help")`) instead
 * of treating a leading `--help` as the group's help. For those the guard below
 * must stay out of the way: their handler prints richer usage than this group's
 * block — `keryx shell` prints its full flag list, `keryx agents bootstrap`
 * prints the runtime list — and replacing that with two summary lines would be a
 * regression dressed as a safety fix. Every entry is pinned by a test that
 * drives it (`shell-cli-validation.test.ts`, `cli.test.ts`'s agents case).
 *
 * The list is a list of EXCEPTIONS on purpose: the default is to intercept, so a
 * mutating subcommand cannot inherit `--help` and run. A group that starts
 * answering help itself belongs here, and its own help test will say so.
 */
const DEEP_HELP_GROUPS: ReadonlySet<string> = new Set(["agents", "shell"]);

/**
 * Groups whose `--help` STAYS intercepted (the guard above never lets a
 * mutating subcommand see a stray `--help` and run) but whose printed TEXT
 * is the group's own handler help — not `groupUsage`'s slice of the static
 * `USAGE_BODY` (AC5, flow 294).
 *
 * `DEEP_HELP_GROUPS` above is the other way to solve "the intercepted text is
 * wrong": let the handler see `--help` itself. That is right for `agents` and
 * `shell`, whose EVERY subcommand already guards its own `--help` safely. It
 * is wrong here: `trigger install`/`uninstall`/`list`/`status`/`resolve` (and
 * most of `flow`'s subcommands) do not check for `--help` at all, so
 * `keryx trigger install --help` reaching the handler unintercepted would
 * actually run the install — the exact regression the interception guard
 * exists to prevent. Calling the group's own top-level help FUNCTION directly
 * (its `!command`/`--help`/`-h` branch) gets the same single-source-of-truth
 * text without ever handing a subcommand its own `--help` token.
 */
const RICH_GROUP_HELP: ReadonlyMap<string, () => void> = new Map([
  ["flow", printFlowHelp],
  ["trigger", printTriggerHelp],
  ["serve-mcp", printServeMcpHelp],
  ["governance", printGovernanceHelp],
]);

/**
 * Should the group's own usage be printed instead of running anything? Pure, so
 * the property is testable without a terminal: `skills install --help` is a
 * question, `agents bootstrap --help` is answered deeper, and `harness exec --
 * cmd --help` is the CHILD's question.
 */
export function shouldInterceptHelp(command: string, rest: readonly string[]): boolean {
  return !DEEP_HELP_GROUPS.has(command) && helpRequestedFor(rest);
}

export function groupUsage(command: string, usage: string = USAGE_BODY): string | undefined {
  const lines = usage.split("\n");
  const startsGroup = new RegExp(`^ {2,}keryx ${command}(?:\\s|$)`);
  const isContinuation = /^ {4,}\S/;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!startsGroup.test(line)) {
      continue;
    }
    out.push(line);
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      if (!isContinuation.test(next) || startsGroup.test(next) || /keryx\s/.test(next)) {
        break;
      }
      out.push(next);
    }
  }
  return out.length === 0 ? undefined : out.join("\n");
}

/**
 * A verb's full usage: the richer text `keryx <command> --help` prints today,
 * as a directly callable function — extracted from `main`'s own interception
 * branch above (flow 303 AC4, "keryx help <command> prints that command's
 * full usage (the existing rich group help where one exists)") rather than
 * duplicated. The FOUR rich group helps (flow, trigger, serve-mcp,
 * governance — AC5) win first; `agents`/`shell` (`DEEP_HELP_GROUPS`) answer
 * their own `--help` safely (proven by `shell-cli-validation.test.ts` and
 * `cli.test.ts`'s agents case — see the doc comment on `DEEP_HELP_GROUPS`),
 * so their route is invoked directly with exactly the token that reaches it
 * when an operator types `keryx <command> --help`; every other verb falls
 * back to its `groupUsage` slice of `USAGE_BODY`, same as before this
 * extraction.
 */
export async function printCommandHelp(command: string): Promise<void> {
  const richHelp = RICH_GROUP_HELP.get(command);
  if (richHelp) {
    richHelp();
    return;
  }
  if (DEEP_HELP_GROUPS.has(command)) {
    const route = CLI_ROUTES[command];
    if (route) {
      await route(["--help"]);
      return;
    }
  }
  const usage = groupUsage(command);
  console.log(usage === undefined ? `keryx ${VERSION}\n\n${USAGE_BODY}` : `keryx ${command} — usage:\n\n${usage}\n`);
}

/**
 * The exit code for an error that escaped `main`: 1, except a shell usage
 * error (`ShellFlagError`, e.g. `keryx shell --fork` without `-r <id>`), which
 * carries its own. Only that class is trusted: any other error that happens to
 * carry an `exitCode` (a Bun ShellError, an execa error) is a child process's
 * code, not keryx's (review F9).
 */
export function exitCodeForError(error: unknown): number {
  return error instanceof ShellFlagError ? error.exitCode : 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = exitCodeForError(error);
  });
}
