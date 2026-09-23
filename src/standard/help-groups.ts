// HELP_GROUPS (flow 303): the single onboarding-ordered table that places
// every `CLI_ROUTES` verb (`src/cli.ts`) and every `AGENT_SLASH_COMMANDS`
// entry (`src/commands/agent-commands.ts`) into exactly one of nine
// task-based groups, each with a one-line summary — the data both
// `keryx help` and the OpenTUI `/help` modal render from.
//
// ZONE NOTE — read before adding an import here.
//
// This file lives in `src/standard/`, a CORE zone module
// (`src/lib/import-zones.ts`): core never imports client or adapter code, no
// exception (`src/lib/import-policy.ts`). So this table is a STATIC LITERAL —
// it does not import `CLI_ROUTES` or `AGENT_SLASH_COMMANDS` to derive its
// entries or their summaries; that would be a core -> adapter edge, which the
// policy has no exception for. Coverage against those two registries is
// cross-checked by a TEST (`help-groups.test.ts`), which the import-policy
// scan excludes (`listSourceFiles` drops `*.test.ts`) — that is the only
// place those two imports are allowed to meet this table. Every summary
// below is therefore a NEW summary field (the third option AC2 names),
// written by hand from `cli.ts`'s own `USAGE_BODY`/`Commands:` block and
// `agent-commands.ts`'s descriptions, not derived from either at runtime.
//
// Adapters (`src/commands/**`, `src/cli.ts`) and the client
// (`src/tui/**`) reach this table ONLY through `./service.ts`
// (`src/standard/service.ts`) — the facade `import-policy.ts`'s
// `client-imports-core-internal` rule expects: an edge whose target's
// basename is literally `service.ts` records no finding, while any other
// path into `src/standard/` from those zones is an AVOIDABLE bypass, and
// `import-policy.live.test.ts`'s ratchet (`AVOIDABLE_BYPASS_CEILING`) was at
// its ceiling with zero slack when this file was added. Import from
// `"../standard/service"` (or `"./service"` inside this directory) in
// `commands/**` and `tui/**`; never `"./help-groups"` directly outside this
// directory and its own test.

export type HelpGroupName =
  | "Start here"
  | "Connect a model provider"
  | "Look and feel"
  | "Working in keryx shell"
  | "Project knowledge"
  | "Managed work"
  | "Automation"
  | "External agents, ACP and MCP"
  | "Maintenance and diagnostics";

export interface HelpGroupDef {
  readonly name: HelpGroupName;
  /** CLI-addressable token: `keryx help <slug>`. Never collides with a verb name. */
  readonly slug: string;
  /**
   * Readable label for the TUI `/help` modal's tab STRIP — the full `name`
   * ran all nine together into a visually collided mess, but a whole-word
   * label reads far better than an abbreviation for a new user. `help-
   * modal.ts` uses this when all nine fit the modal's available width (about
   * 82 columns total — fits a 100-column modal); `tabShort` is the fallback
   * for a narrower modal. `renderGroupLines` and
   * `docs/docs/commands-by-task.md` keep using `name`, unabbreviated, as the
   * heading — only the tab STRIP ever reads `tab`/`tabShort`.
   */
  readonly tab: string;
  /**
   * Short fallback label for the TUI `/help` modal's tab strip, used only
   * when the readable `tab` labels don't all fit the modal's available
   * width (e.g. at `modal-host.ts`'s `MODAL_PANEL_MIN_WIDTH` floor). Unique
   * across the table, like `tab` — `help-modal.test.ts` pins both.
   */
  readonly tabShort: string;
}

/** Onboarding order (AC1, AC3): the order both `keryx help` and the TUI modal's tabs use. */
export const HELP_GROUP_ORDER: readonly HelpGroupDef[] = [
  { name: "Start here", slug: "start-here", tab: "Start", tabShort: "Start" },
  { name: "Connect a model provider", slug: "connect", tab: "Connect", tabShort: "Conn" },
  { name: "Look and feel", slug: "look-and-feel", tab: "Look", tabShort: "Look" },
  { name: "Working in keryx shell", slug: "shell-work", tab: "Shell", tabShort: "Shell" },
  { name: "Project knowledge", slug: "project-knowledge", tab: "Knowledge", tabShort: "Know" },
  { name: "Managed work", slug: "managed-work", tab: "Work", tabShort: "Work" },
  { name: "Automation", slug: "automation", tab: "Automate", tabShort: "Auto" },
  { name: "External agents, ACP and MCP", slug: "external-agents", tab: "Agents", tabShort: "Agents" },
  { name: "Maintenance and diagnostics", slug: "maintenance", tab: "Maintain", tabShort: "Maint" },
];

export type HelpEntryKind = "cli" | "slash";

export interface HelpEntry {
  readonly kind: HelpEntryKind;
  /** `init`, `shell` for a CLI verb; `/help`, `/theme` for a slash command. */
  readonly name: string;
  readonly group: HelpGroupName;
  /** One line (no embedded newline), wrapped by the renderer, not here. */
  readonly summary: string;
}

/**
 * The table itself. Every `CLI_ROUTES` key (`src/cli.ts`, including the
 * `help` verb this flow adds — AC10) and every `AGENT_SLASH_COMMANDS` name
 * (`src/commands/agent-commands.ts`) appears exactly once — enforced by
 * `help-groups.test.ts` against both live registries.
 */
export const HELP_GROUPS: readonly HelpEntry[] = [
  // ---- Start here ---------------------------------------------------------
  { kind: "cli", name: "init", group: "Start here", summary: "Initialize .metaproject in the current project." },
  { kind: "cli", name: "status", group: "Start here", summary: "Show local Metaproject status." },
  {
    kind: "cli",
    name: "shell",
    group: "Start here",
    summary: "Start the interactive TUI agent harness (--no-tui or --chat to opt out).",
  },
  {
    kind: "cli",
    name: "help",
    group: "Start here",
    summary: "Grouped command help by task — keryx help [group|command].",
  },
  { kind: "slash", name: "/help", group: "Start here", summary: "Show available commands, grouped by task." },

  // ---- Connect a model provider -------------------------------------------
  {
    kind: "cli",
    name: "auth",
    group: "Connect a model provider",
    summary: "Subscription login (SuperGrok, ChatGPT Plus/Pro, GitHub Copilot) and API-key status.",
  },
  {
    kind: "cli",
    name: "providers",
    group: "Connect a model provider",
    summary: "Providers this operator has configured, and cross-family review eligibility.",
  },
  { kind: "slash", name: "/connect", group: "Connect a model provider", summary: "Switch provider / API key." },
  {
    kind: "slash",
    name: "/search-provider",
    group: "Connect a model provider",
    summary: "Configure and test a web search provider.",
  },
  {
    kind: "slash",
    name: "/search-connect",
    group: "Connect a model provider",
    summary: "Select a connected web search provider.",
  },
  {
    kind: "slash",
    name: "/provider",
    group: "Connect a model provider",
    summary: "Switch provider — /provider <name>, or no arg to re-select.",
  },

  // ---- Look and feel -------------------------------------------------------
  {
    kind: "slash",
    name: "/theme",
    group: "Look and feel",
    summary: "Open the theme picker — /theme [name] applies immediately.",
  },
  { kind: "slash", name: "/model", group: "Look and feel", summary: "Switch the model." },
  {
    kind: "slash",
    name: "/models",
    group: "Look and feel",
    summary: "Pick a model for the current provider (numbered menu).",
  },
  {
    kind: "slash",
    name: "/mode",
    group: "Look and feel",
    summary: "Show or switch the permission mode — /mode [ask|trust|auto].",
  },
  {
    kind: "slash",
    name: "/think",
    group: "Look and feel",
    summary: "Expand the last reasoning block — /think [auto|expand|hide|collapse].",
  },
  {
    kind: "slash",
    name: "/reasoning",
    group: "Look and feel",
    summary: "Show or set reasoning effort — /reasoning [off|minimal|low|medium|high|xhigh|max].",
  },

  // ---- Working in keryx shell ----------------------------------------------
  { kind: "cli", name: "sessions", group: "Working in keryx shell", summary: "List or export per-project shell sessions." },
  {
    kind: "slash",
    name: "/sessions",
    group: "Working in keryx shell",
    summary: "Open the session list and switch to one.",
  },
  { kind: "slash", name: "/resume", group: "Working in keryx shell", summary: "Resume a prior session in this project." },
  { kind: "slash", name: "/new", group: "Working in keryx shell", summary: "Start a new session (old kept on disk)." },
  { kind: "slash", name: "/clear", group: "Working in keryx shell", summary: "New session (alias of /new)." },
  {
    kind: "slash",
    name: "/compact",
    group: "Working in keryx shell",
    summary: "Compact model context — /compact [focus] (archive kept).",
  },
  {
    kind: "slash",
    name: "/copy",
    group: "Working in keryx shell",
    summary: "Copy the newest transcript block to the clipboard.",
  },
  { kind: "slash", name: "/expand", group: "Working in keryx shell", summary: "Expand the last tool output block." },
  {
    kind: "slash",
    name: "/status",
    group: "Working in keryx shell",
    summary: "Show session identity, context window, limits, workspaces, and flows.",
  },
  {
    kind: "slash",
    name: "/queue",
    group: "Working in keryx shell",
    summary: "Manage the main queue — /queue <remove|edit|force> [N] (N = qN position, default 1).",
  },
  {
    kind: "slash",
    name: "/interrupt",
    group: "Working in keryx shell",
    summary: "Interrupt the running main agent turn.",
  },
  { kind: "slash", name: "/exit", group: "Working in keryx shell", summary: "Leave the shell (/quit works too)." },
  {
    kind: "slash",
    name: "/game",
    group: "Working in keryx shell",
    summary: "Games against the model — /game [seconds] raises the model-turn deadline.",
  },

  // ---- Project knowledge ----------------------------------------------------
  { kind: "cli", name: "gdgraph", group: "Project knowledge", summary: "Build and query the code dependency graph." },
  { kind: "cli", name: "ctx", group: "Project knowledge", summary: "Run compact context commands and save raw output." },
  { kind: "cli", name: "wiki", group: "Project knowledge", summary: "Manage the local project knowledge base." },
  { kind: "cli", name: "memory", group: "Project knowledge", summary: "Store and search long-term project memory." },
  {
    kind: "cli",
    name: "orient",
    group: "Project knowledge",
    summary: "Emit a bounded graph + wiki startup block, or install it as a turn-start hook.",
  },
  { kind: "cli", name: "skills", group: "Project knowledge", summary: "Manage bundled Metaproject working skills." },

  // ---- Managed work -----------------------------------------------------
  { kind: "cli", name: "flow", group: "Managed work", summary: "Agent-first flow lifecycle (Task Manager)." },
  {
    kind: "cli",
    name: "job",
    group: "Managed work",
    summary: "Agent-first job packages (job-orchestrator state, steps, documents).",
  },
  {
    kind: "cli",
    name: "review",
    group: "Managed work",
    summary: "Managed review packages and lightweight report-only review mode.",
  },
  { kind: "slash", name: "/flows", group: "Managed work", summary: "Browse project flows and inspect one." },
  {
    kind: "slash",
    name: "/review",
    group: "Managed work",
    summary: "Show project-wide items needing review (proposals, blocked sessions).",
  },
  { kind: "slash", name: "/plan", group: "Managed work", summary: "Toggle read-only mode — /plan [on|off]." },
  {
    kind: "slash",
    name: "/goal",
    group: "Managed work",
    summary: "Deterministically start a goal — /goal <text> [--workspace <id>] [--auto [N]].",
  },

  // ---- Automation ---------------------------------------------------------
  {
    kind: "cli",
    name: "trigger",
    group: "Automation",
    summary: "Fire one declared project trigger (git hook, cron line, CI job) — one pass, one exit code.",
  },
  {
    kind: "cli",
    name: "schedule",
    group: "Automation",
    summary: "Scheduled agent tasks in the background: create (with confirmation), list, pause, resume, remove.",
  },
  {
    kind: "cli",
    name: "governance",
    group: "Automation",
    summary: "Read-only report over already-recorded spend, confirmations, signatures and gate outcomes.",
  },
  {
    kind: "slash",
    name: "/triggers",
    group: "Automation",
    summary: "Declared triggers: last outcome, spend, reservations — run one now.",
  },
  {
    kind: "slash",
    name: "/schedule",
    group: "Automation",
    summary: "Schedule a background agent task — shows a confirmation card first (keryx schedule add).",
  },
  {
    kind: "slash",
    name: "/schedules",
    group: "Automation",
    summary: "Scheduled tasks: next run, last outcome, report — pause, resume, run now, delete.",
  },
  {
    kind: "slash",
    name: "/governance",
    group: "Automation",
    summary: "Show the last governance report, or run one in the background.",
  },

  // ---- External agents, ACP and MCP ----------------------------------------
  {
    kind: "cli",
    name: "acp",
    group: "External agents, ACP and MCP",
    summary: "Speak ACP v1 (newline-delimited JSON-RPC) over stdio, for an ACP client (e.g. an editor).",
  },
  {
    kind: "cli",
    name: "agents",
    group: "External agents, ACP and MCP",
    summary: "Manage optional global agent bootstrap instructions.",
  },
  {
    kind: "cli",
    name: "mcp",
    group: "External agents, ACP and MCP",
    summary: "Retired spelling of serve-mcp / integrate; still works, names its replacement.",
  },
  {
    kind: "cli",
    name: "integrate",
    group: "External agents, ACP and MCP",
    summary: "Wire this project into an editor or agent as an MCP server.",
  },
  {
    kind: "cli",
    name: "serve-mcp",
    group: "External agents, ACP and MCP",
    summary: "Expose Metaproject services over the Model Context Protocol (opt-in).",
  },
  {
    kind: "cli",
    name: "bus",
    group: "External agents, ACP and MCP",
    summary: "Agent bus: list peers and leases, read the log, send a message, prune.",
  },
  {
    kind: "cli",
    name: "workspace",
    group: "External agents, ACP and MCP",
    summary: "Shared Agent Context: workspaces, FWK reads, propose/review (module sac).",
  },
  {
    kind: "slash",
    name: "/delegate",
    group: "External agents, ACP and MCP",
    summary: "Hand a task to an external agent CLI — /delegate <agent> <task>.",
  },
  {
    kind: "slash",
    name: "/demote",
    group: "External agents, ACP and MCP",
    summary: "Move a running foreground task to the background — /demote <task_id>.",
  },
  {
    kind: "slash",
    name: "/mcp",
    group: "External agents, ACP and MCP",
    summary: "MCP servers keryx is connected to — status, connect/disconnect.",
  },
  {
    kind: "slash",
    name: "/integrations",
    group: "External agents, ACP and MCP",
    summary: "Wire this project into an editor over MCP (keryx integrate).",
  },
  {
    kind: "slash",
    name: "/bus",
    group: "External agents, ACP and MCP",
    summary: "Message or view peers on the project agent bus — /bus @<name> <text>.",
  },
  {
    kind: "slash",
    name: "/workspace",
    group: "External agents, ACP and MCP",
    summary: "Show this session's SAC workspace and its slates.",
  },

  // ---- Maintenance and diagnostics -----------------------------------------
  {
    kind: "cli",
    name: "health",
    group: "Maintenance and diagnostics",
    summary: "Aggregate code quality signals and run the quality gate.",
  },
  {
    kind: "cli",
    name: "test",
    group: "Maintenance and diagnostics",
    summary: "Analyze testing context and normalize test reports.",
  },
  {
    kind: "cli",
    name: "standard",
    group: "Maintenance and diagnostics",
    summary: "Validate the workspace against the Metaproject Standard.",
  },
  {
    kind: "cli",
    name: "update",
    group: "Maintenance and diagnostics",
    summary: "Refresh managed service files without touching data artifacts.",
  },
  {
    kind: "cli",
    name: "sync",
    group: "Maintenance and diagnostics",
    summary: "Reconcile graph/wiki/memory with the current code, and wire the git hooks.",
  },
  {
    kind: "cli",
    name: "security",
    group: "Maintenance and diagnostics",
    summary: "Policy-based scanning, redaction, guardrails and audit reports.",
  },
  {
    kind: "cli",
    name: "dashboard",
    group: "Maintenance and diagnostics",
    summary: "Build or open the project admin dashboard.",
  },
  {
    kind: "cli",
    name: "dash",
    group: "Maintenance and diagnostics",
    summary: "Rebuild and open .metaproject/keryx-dashboard.html.",
  },
  {
    kind: "cli",
    name: "metrics",
    group: "Maintenance and diagnostics",
    summary: "Provenance-aware execution observability: run records, baselines, benchmarks.",
  },
  {
    kind: "cli",
    name: "sandbox",
    group: "Maintenance and diagnostics",
    summary: "Report OS sandbox launcher availability and the per-capability containment matrix.",
  },
  {
    kind: "cli",
    name: "modules",
    group: "Maintenance and diagnostics",
    summary: "View and toggle Metaproject modules (interactive).",
  },
  {
    kind: "cli",
    name: "projects",
    group: "Maintenance and diagnostics",
    summary: "Inspect the user-global registry of initialized projects.",
  },
  {
    kind: "cli",
    name: "serve",
    group: "Maintenance and diagnostics",
    summary: "Loopback-bound authenticated HTTP entry (off by default; read-only routes).",
  },
  {
    kind: "cli",
    name: "rules",
    group: "Maintenance and diagnostics",
    summary: "Sync root AGENTS.md/CLAUDE.md into high-priority project rules.",
  },
  {
    kind: "cli",
    name: "harness",
    group: "Maintenance and diagnostics",
    summary: "Run a single provider turn (harness run) and print structured events.",
  },
  {
    kind: "cli",
    name: "version",
    group: "Maintenance and diagnostics",
    summary: "Check whether a newer npm release is available.",
  },
  {
    kind: "cli",
    name: "retention",
    group: "Maintenance and diagnostics",
    summary: "Bound stores that grow without bound (gdctx raw/artifacts, owner write-conflict sidecars).",
  },
  {
    kind: "cli",
    name: "forgetting",
    group: "Maintenance and diagnostics",
    summary: "Read the deletion trail — was this removed, or did it never exist?",
  },
  {
    kind: "cli",
    name: "commands",
    group: "Maintenance and diagnostics",
    summary: "Agent-callable command registry (intents, args, output, model usage).",
  },
];

/**
 * `CLI_ROUTES` verbs deliberately OUT of `HELP_GROUPS` (never in both — see
 * `help-groups.test.ts`), each with a reason. `keryx help`, the TUI `/help`
 * modal and `commands-by-task.md` all render from `HELP_GROUPS` alone, so an
 * entry here is invisible to all three without needing per-surface filtering.
 * `keryx help <verb>` (an exact, already-known name) still works for any of
 * these — being hidden from the LISTING is not the same as the command not
 * existing.
 *
 * The set mirrors what `cli.ts`'s OWN flat `Commands:` block already does:
 * `dash` and `mcp` (both real alternate spellings an operator might type) get
 * their own row there and stay in `HELP_GROUPS`; `session` and
 * `skill-verify-skill` are omitted from that block entirely (not even
 * mentioned inline on `sessions`/`skills`), which is the same treatment given
 * here — hidden, not shown as an inline alias either.
 */
export const HIDDEN_FROM_HELP: readonly { readonly verb: string; readonly reason: string }[] = [
  {
    verb: "__sandbox-net-forward",
    reason:
      "internal helper keryx starts inside the unattended sandbox to bridge a local port to the allowlist proxy's socket; never typed by an operator (see the file header on src/commands/sandbox-net-forward.ts and its DOCUMENTED_ELSEWHERE entry in cli-reference-coverage.test.ts)",
  },
  {
    verb: "session",
    reason:
      "alias of `sessions`; cli.ts's own flat `Commands:` block omits it too (only `sessions` is listed there, with no inline alias mention)",
  },
  {
    verb: "skill-verify-skill",
    reason:
      "standalone alias of `skills verify`; cli.ts's own flat `Commands:` block omits it too (only `skills` is listed there), matching command-registry.coverage.test.ts's EXCLUSIONS reason for the same verb (\"standalone alias of skills verify; not part of the agent surface\")",
  },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function groupBySlug(token: string): HelpGroupDef | undefined {
  const lower = token.trim().toLowerCase();
  return HELP_GROUP_ORDER.find((g) => g.slug === lower);
}

export function entriesInGroup(group: HelpGroupName, kind?: HelpEntryKind): HelpEntry[] {
  return HELP_GROUPS.filter((e) => e.group === group && (kind === undefined || e.kind === kind));
}

export function findEntry(kind: HelpEntryKind, name: string): HelpEntry | undefined {
  return HELP_GROUPS.find((e) => e.kind === kind && e.name === name);
}

export function findCliEntry(name: string): HelpEntry | undefined {
  return findEntry("cli", name);
}

export function findSlashEntry(name: string): HelpEntry | undefined {
  return findEntry("slash", name);
}

// ---------------------------------------------------------------------------
// Rendering — pure text formatters shared by `keryx help` and the TUI modal.
// ---------------------------------------------------------------------------

/** Column budget a render call defaults to when the caller has no measured terminal width. */
export const HELP_DEFAULT_COLUMNS = 80;
/** Narrowest description column the wrappers below still word-wrap into. */
const MIN_WRAP_COLUMNS = 10;

/** Greedy word wrap; a word longer than `budget` keeps its own line. Mirrors `agent-commands.ts`'s `wrapWords`. */
function wrapWords(line: string, budget: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(/\s+/).filter(Boolean)) {
    if (cur.length > 0 && cur.length + 1 + word.length > budget) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur.length > 0 ? `${cur} ${word}` : word;
    }
  }
  out.push(cur);
  return out.length > 0 ? out : [""];
}

/**
 * `maxColumns === undefined` renders every summary on one unwrapped line —
 * mirrors `agent-commands.ts`'s `renderCommandHelp` (no `maxColumns` given),
 * which the readline chat/agent REPLs rely on: their tests assert the
 * registry's FULL description string appears verbatim (`shell-slash-
 * registry.test.ts`), which a wrapped line would break across two rows.
 */
function renderEntryRows(entries: readonly HelpEntry[], maxColumns: number | undefined): string[] {
  if (entries.length === 0) {
    return [];
  }
  const width = entries.reduce((w, e) => Math.max(w, e.name.length), 0);
  const descColumn = width + 4;
  const wrapBudget = maxColumns === undefined ? undefined : Math.max(MIN_WRAP_COLUMNS, maxColumns - descColumn);
  const rows: string[] = [];
  for (const entry of entries) {
    const wrapped = wrapBudget === undefined ? [entry.summary] : wrapWords(entry.summary, wrapBudget);
    wrapped.forEach((line, i) => {
      rows.push(i === 0 ? `  ${entry.name.padEnd(width)}  ${line}`.trimEnd() : `${" ".repeat(descColumn)}${line}`.trimEnd());
    });
  }
  return rows;
}

/** Sub-heading marking a group's slash rows as shell-only commands (AC3, AC4: every group must appear, even slash-only ones). */
const SHELL_SUBHEADING = "  in keryx shell:";

/**
 * One group's full listing: its CLI verbs first, then (if any) its slash
 * commands under a `SHELL_SUBHEADING` sub-heading so they read as clearly
 * shell-only, never confused with a standalone CLI verb. A group with only
 * slash commands (e.g. "Look and feel") still renders — CLI-only used to be
 * the sole criterion for a group appearing at all, which made such groups
 * (and every command in them, including `/theme`) invisible in the terminal.
 */
function renderGroupLines(group: HelpGroupDef, maxColumns: number | undefined): string[] {
  const cliEntries = entriesInGroup(group.name, "cli");
  const slashEntries = entriesInGroup(group.name, "slash");
  if (cliEntries.length === 0 && slashEntries.length === 0) {
    return [];
  }
  const lines: string[] = [`${group.name}:`];
  lines.push(...renderEntryRows(cliEntries, maxColumns));
  if (slashEntries.length > 0) {
    lines.push(SHELL_SUBHEADING);
    lines.push(...renderEntryRows(slashEntries, maxColumns));
  }
  return lines;
}

/**
 * `keryx help` with no argument (AC3): every group, in onboarding order —
 * its CLI verbs, then its slash commands marked as shell-only (AC7 covers
 * the shell surfaces' OWN command lists; this is the terminal's one-stop
 * listing so a new user sees every command, including a slash-only group
 * like "Look and feel"/`/theme`) — each with its one-line summary,
 * word-wrapped to `maxColumns` so no rendered line exceeds it.
 */
export function renderGroupedCliHelp(maxColumns: number = HELP_DEFAULT_COLUMNS): string {
  const lines: string[] = [];
  for (const group of HELP_GROUP_ORDER) {
    const groupLines = renderGroupLines(group, maxColumns);
    if (groupLines.length === 0) {
      continue;
    }
    lines.push(...groupLines);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** `keryx help <group>` (AC4): one group's CLI verbs and slash commands, same row format as the full table. */
export function renderCliGroupHelp(group: HelpGroupDef, maxColumns: number = HELP_DEFAULT_COLUMNS): string {
  const lines = renderGroupLines(group, maxColumns);
  return lines.join("\n") + "\n";
}

/**
 * Grouped slash-command text for a shell surface (AC7): only the names in
 * `allow` (a mode's or a readline surface's own command subset), grouped in
 * onboarding order, same row format as the CLI table, using THIS table's own
 * summaries.
 */
export function renderGroupedSlashHelp(allow: readonly string[], maxColumns?: number): string {
  const allowed = new Set(allow);
  const lines: string[] = ["Commands:"];
  for (const group of HELP_GROUP_ORDER) {
    const entries = entriesInGroup(group.name, "slash").filter((e) => allowed.has(e.name));
    if (entries.length === 0) {
      continue;
    }
    lines.push("", `${group.name}:`);
    lines.push(...renderEntryRows(entries, maxColumns));
  }
  return lines.join("\n") + "\n";
}

/** A `{name, description}` pair, e.g. `agent-commands.ts`'s mode-resolved `SlashCommandOption`. */
export interface NamedHelpOption {
  readonly name: string;
  readonly description: string;
}

/**
 * Grouped slash-command text (AC7), same as {@link renderGroupedSlashHelp},
 * but the DESCRIPTION comes from the caller, not this table's own summary —
 * for a surface (the readline chat/agent REPLs) whose wording must keep
 * tracking `AGENT_SLASH_COMMANDS`'s mode-resolved text rather than a second,
 * independently-drifting copy. Only grouping and order come from this table.
 * An option whose name this table has no slash entry for is skipped (never
 * silently ungrouped at the top).
 */
export function renderGroupedNamedHelp(options: readonly NamedHelpOption[], maxColumns?: number): string {
  const lines: string[] = ["Commands:"];
  for (const group of HELP_GROUP_ORDER) {
    const rows: HelpEntry[] = options
      .filter((o) => findEntry("slash", o.name)?.group === group.name)
      .map((o) => ({ kind: "slash", name: o.name, group: group.name, summary: o.description }));
    if (rows.length === 0) {
      continue;
    }
    lines.push("", `${group.name}:`);
    lines.push(...renderEntryRows(rows, maxColumns));
  }
  return lines.join("\n") + "\n";
}

/**
 * One entry's detail block (AC6's modal "Enter shows the selected command's
 * detail"). Word-wrapped to `maxColumns` (default 80) — the fixed slash-
 * command explainer sentence alone runs to 94 unwrapped columns, well past
 * the terminal's 80-column budget every other `keryx help` surface holds to.
 */
export function renderEntryDetail(entry: HelpEntry, maxColumns: number = HELP_DEFAULT_COLUMNS): string {
  const lines = [`${entry.name}`, "", ...wrapWords(entry.summary, maxColumns), ""];
  if (entry.kind === "slash") {
    lines.push(
      ...wrapWords(
        "This is a keryx shell command — type it inside `keryx shell` (readline chat/agent mode, or " +
          "the TUI's `/`-menu). It has no standalone CLI form.",
        maxColumns,
      ),
    );
  } else {
    lines.push(...wrapWords(`Run \`keryx ${entry.name} --help\` (or \`keryx help ${entry.name}\`) for its full usage.`, maxColumns));
  }
  return lines.join("\n") + "\n";
}

/** Markdown-table-safe: escape a literal `|`, which would otherwise end a cell early. */
function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * `docs/docs/commands-by-task.md` (AC9): every CLI verb and every slash
 * command, grouped in onboarding order, as two tables per group (CLI, then
 * shell). Generated by `scripts/generate-commands-by-task.ts`; checked
 * against the file on disk by `src/standard/commands-by-task.test.ts`. Pure —
 * the same table `keryx help` and the TUI modal render from, just as
 * Markdown.
 */
export function renderCommandsByTaskMarkdown(): string {
  const lines: string[] = [
    "# Commands by task",
    "",
    "Every `keryx` CLI verb and every `keryx shell` command, grouped by task — " +
      "the same grouping `keryx help` and the OpenTUI shell's `/help` modal use " +
      "(`src/standard/help-groups.ts`, flow 303).",
    "",
    "Generated. Do not hand-edit: regenerate with " +
      "`bun scripts/generate-commands-by-task.ts`, and " +
      "`src/standard/commands-by-task.test.ts` fails when this page drifts from " +
      "the table it is generated from.",
    "",
  ];
  for (const group of HELP_GROUP_ORDER) {
    const cli = entriesInGroup(group.name, "cli");
    const slash = entriesInGroup(group.name, "slash");
    if (cli.length === 0 && slash.length === 0) {
      continue;
    }
    lines.push(`## ${group.name}`, "");
    if (cli.length > 0) {
      lines.push("| CLI command | Summary |", "|---|---|");
      for (const entry of cli) {
        lines.push(`| \`keryx ${mdCell(entry.name)}\` | ${mdCell(entry.summary)} |`);
      }
      lines.push("");
    }
    if (slash.length > 0) {
      lines.push("| Shell command | Summary |", "|---|---|");
      for (const entry of slash) {
        lines.push(`| \`${mdCell(entry.name)}\` | ${mdCell(entry.summary)} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

// ---------------------------------------------------------------------------
// "Did you mean" suggestions (AC4).
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    const row = dp[i];
    if (row !== undefined) row[0] = i;
  }
  const first = dp[0];
  if (first !== undefined) {
    for (let j = 0; j < cols; j += 1) first[j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = a[i - 1] === b[j - 1];
      const up = dp[i - 1]?.[j] ?? 0;
      const left = dp[i]?.[j - 1] ?? 0;
      const diag = dp[i - 1]?.[j - 1] ?? 0;
      const row = dp[i];
      if (row !== undefined) row[j] = same ? diag : 1 + Math.min(up, left, diag);
    }
  }
  return dp[rows - 1]?.[cols - 1] ?? Math.max(a.length, b.length);
}

/** Every token `keryx help <name>` accepts: group slugs, CLI verbs and slash-command names. */
export function allHelpTokens(): string[] {
  return [
    ...HELP_GROUP_ORDER.map((g) => g.slug),
    ...HELP_GROUPS.map((e) => e.name),
  ];
}

/** Nearest tokens to `query` by edit distance, closest first, for an unknown `keryx help <name>` (AC4). */
export function closestHelpTopics(query: string, limit: number = 3): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const threshold = Math.max(2, Math.ceil(needle.length / 2));
  return [...new Set(allHelpTokens())]
    .map((candidate) => ({ candidate, distance: levenshtein(needle, candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
