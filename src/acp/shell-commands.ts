// The served command table of `keryx acp --profile shell` (Keryx Desktop Client M2a,
// specification §3.9.1, §3.9.2, §3.9.6; decision D-10).
//
// ONE table, built from `AGENT_SLASH_COMMANDS` (the registry both shells and the TUI
// already share): every agent-mode command is either a row here or named in
// `ACP_NOT_ADVERTISED_COMMANDS`. A command added to the registry without either fails
// `shell-commands.test.ts`, so the desktop never silently loses a command.
//
// A row names its `surface` (who acts on it), its `busy` behaviour (from
// `busy-dispatch.ts`, the rule the shells already follow while a turn runs) and its
// `runner` (which family of text functions answers `_keryx/command`). The runners live
// in `shell-command-runners.ts`; nothing here imports a runner, so the table stays pure
// and importable from `commands.ts`.

import { AGENT_SLASH_COMMANDS, describeCommand } from "../commands/agent-commands";
import { findSlashEntry, type HelpGroupName } from "../standard/service";
import { BUSY_REFUSED_COMMANDS, classifyBusyDispatch } from "../tui/busy-dispatch";
import { ACP_SHELL_SLASH_COMMANDS, ACP_TUI_ONLY_COMMANDS, type AcpSlashCommandSpec } from "./commands";

/**
 * Who acts on a command.
 *  - `text`: `_keryx/command` runs it and answers with text.
 *  - `view`: `_keryx/command` answers with a structured view (§3.9.1 "Views").
 *  - `dialog`: the client opens its own dialog (`/connect`, `/search-provider`).
 *  - `client`: the client acts alone (`/new`, `/clear`, `/resume`, `/sessions`, `/interrupt`, `/queue`).
 */
export type ShellCommandSurface = "text" | "view" | "dialog" | "client";

export type ShellCommandBusy = "run" | "refuse";

/** The family of text functions that answer a command. `none` = the client's, or not served yet. */
export type ShellCommandRunnerId =
  | "server"
  | "help"
  | "doctor"
  | "setup"
  | "flows"
  | "history"
  | "trail"
  | "notes"
  | "diag"
  | "compact"
  | "rewind"
  | "plan"
  | "tasks"
  | "demote"
  | "reviews"
  | "review"
  | "remote-control"
  | "channels"
  | "intake"
  | "rendering"
  | "remote-policy"
  | "permissions"
  | "approvals"
  | "external-diff"
  | "mcp"
  | "settings"
  | "search-connect"
  | "jev"
  | "flow"
  | "opencomments"
  | "route"
  | "guard"
  | "editguard"
  | "projectctx"
  | "external"
  | "external-agents"
  | "goal"
  | "delegate"
  | "bus"
  | "view"
  | "none";

export interface ShellCommandRow {
  /** Without the leading slash, as ACP's `AvailableCommand.name` carries it. */
  readonly name: string;
  readonly description: string;
  readonly hint?: string;
  readonly group: HelpGroupName;
  readonly surface: ShellCommandSurface;
  readonly busy: ShellCommandBusy;
  readonly runner: ShellCommandRunnerId;
}

/** The commands the client acts on alone. `_keryx/command` refuses them with -32602. */
const CLIENT_COMMANDS: readonly string[] = ["new", "clear", "resume", "sessions", "interrupt", "queue"];
/** The commands the client opens a dialog for. */
const DIALOG_COMMANDS: readonly string[] = ["connect", "search-provider"];

/**
 * Picker, modal and form commands (§3.9.1 "Views"). `_keryx/command` answers each one with a
 * structured view (`shell-views-*.ts`), and its text subcommands (`/guard on`,
 * `/schedules pause <id>`, `/review accept ...`) with text. The runner of a command that also
 * has older text forms (`/guard`, `/bus`, `/mcp`, `/review`) answers those first.
 */
const VIEW_COMMANDS: readonly string[] = [
  "routing",
  "ci",
  "conform",
  "task",
  "review",
  "product",
  "governance",
  "triggers",
  "schedule",
  "schedules",
  "autoreview",
  "jevprofile",
  "ac",
  "workspace",
  "decisions",
  "bus",
  "guard",
  "editguard",
  "projectctx",
  "mcp",
];

/**
 * What a view command answers when no view or subcommand covers its arguments (every view
 * runner answers its own, so this is the server's last resort): `{ text, _meta: { keryx:
 * { refused: true } } }`, the shape a refused command has.
 */
export function viewNotServedText(name: string): string {
  return `${name} is not served yet`;
}

/** Which runner family answers a command that is not the client's. */
const RUNNERS: Readonly<Record<string, ShellCommandRunnerId>> = {
  help: "help",
  status: "server",
  model: "server",
  reasoning: "server",
  mode: "server",
  doctor: "doctor",
  setup: "setup",
  flows: "flows",
  history: "history",
  trail: "trail",
  notes: "notes",
  diag: "diag",
  compact: "compact",
  rewind: "rewind",
  plan: "plan",
  tasks: "tasks",
  demote: "demote",
  reviews: "reviews",
  review: "review",
  "remote-control": "remote-control",
  channels: "channels",
  intake: "intake",
  rendering: "rendering",
  "remote-policy": "remote-policy",
  permissions: "permissions",
  approvals: "approvals",
  "external-diff": "external-diff",
  mcp: "mcp",
  settings: "settings",
  "search-connect": "search-connect",
  risk: "jev",
  scenarios: "jev",
  jevrules: "jev",
  staledocs: "jev",
  contract: "jev",
  triage: "jev",
  flow: "flow",
  opencomments: "opencomments",
  route: "route",
  guard: "guard",
  editguard: "editguard",
  projectctx: "projectctx",
  external: "external",
  "external-agents": "external-agents",
  goal: "goal",
  delegate: "delegate",
  bus: "bus",
  routing: "view",
  ci: "view",
  conform: "view",
  task: "view",
  product: "view",
  governance: "view",
  triggers: "view",
  schedule: "view",
  schedules: "view",
  autoreview: "view",
  jevprofile: "view",
  ac: "view",
  workspace: "view",
  decisions: "view",
};

/** What each command takes, for the palette's input hint. Only commands with an argument. */
const HINTS: Readonly<Record<string, string>> = {
  compact: "focus (optional)",
  rewind: "N [files|history|both] | confirm",
  plan: "on | off",
  tasks: "output <id> [cursor] | kill <id>",
  demote: "task id",
  goal: "goal text",
  delegate: "agent and task",
  flows: "flow id (optional)",
  flow: "origin [<id>] | origin <id> <kind> --reason ...",
  trail: "[count] [tool=NAME] [file=TEXT]",
  notes: "key (optional)",
  guard: "on | off",
  route: "on | off",
  editguard: "on | off",
  projectctx: "warn | block | refs",
  external: "on | off",
  "external-agents": "on | off",
  rendering: "auto | rich | html | plain",
  intake: "status | list | pause | resume | poll",
  channels: "status",
  "remote-control": "name | off | status",
  review: "layers | parity | readiness",
  setup: "init | refresh | repair",
  "search-connect": "provider id",
  opencomments: "owner/repo pr",
  mcp: "trust list | trust revoke <server__tool> | all",
  bus: "send | ask | reply | name",
  routing: "set <category> <provider/model | baseline> | trust",
  ci: "triage <run id> [job name]",
  conform: "run <target id> <document>",
  task: "<mode> <description> [|| criteria]",
  governance: "run | check <flow id> | close <flow id>",
  triggers: "<name> | run <name>",
  schedule: "--name N --every C --rates IN,OUT --ceiling USD -- prompt",
  schedules: "<name> | pause|resume|run|delete <name> | runs [<name>] | run-log <name> <run id>",
  autoreview: "list | arbiter [pull request]",
  jevprofile: "set <key> on|off | apply",
  ac: "recheck <flow id>",
  decisions: "arms | reason <why> | change <option>",
};

/** Busy behaviour of one command, by the rule the shells follow while a turn runs. */
function busyOf(name: string): ShellCommandBusy {
  const token = `/${name}`;
  const target = classifyBusyDispatch({
    line: token,
    commandName: token,
    isSessionInfo: name === "status",
    isFlows: name === "flows",
    isWorkspace: name === "workspace",
    isReview: name === "review",
    isMcp: false,
    isMcpConsumer: name === "mcp",
  });
  return target === "deferred" ? "refuse" : "run";
}

function surfaceOf(name: string): ShellCommandSurface {
  if (CLIENT_COMMANDS.includes(name)) return "client";
  if (DIALOG_COMMANDS.includes(name)) return "dialog";
  if (VIEW_COMMANDS.includes(name)) return "view";
  return "text";
}

/** Palette wording: the editor-profile spec where one exists (it is shorter), else the registry's agent-mode text. */
function specFor(name: string, registryDescription: string): AcpSlashCommandSpec {
  const existing = ACP_SHELL_SLASH_COMMANDS.find((spec) => spec.name === name);
  if (existing !== undefined) return existing;
  const hint = HINTS[name];
  return { name, description: registryDescription, ...(hint !== undefined ? { hint } : {}) };
}

function buildTable(): readonly ShellCommandRow[] {
  const rows: ShellCommandRow[] = [];
  for (const command of AGENT_SLASH_COMMANDS) {
    if (!command.modes.includes("agent")) continue;
    const name = command.name.slice(1);
    if (ACP_TUI_ONLY_COMMANDS.includes(name)) continue;
    const entry = findSlashEntry(command.name);
    if (entry === undefined) {
      throw new Error(`shell-commands: "${command.name}" has no HELP_GROUPS entry — add it to src/standard/help-groups.ts`);
    }
    const spec = specFor(name, describeCommand(command, "agent"));
    const surface = surfaceOf(name);
    rows.push({
      name,
      description: spec.description,
      ...(spec.hint !== undefined ? { hint: spec.hint } : {}),
      group: entry.group,
      surface,
      busy: busyOf(name),
      runner: surface === "client" || surface === "dialog" ? "none" : (RUNNERS[name] ?? "none"),
    });
  }
  return rows;
}

/** Every command the shell profile advertises, in registry order. */
export const ACP_SHELL_COMMAND_TABLE: readonly ShellCommandRow[] = buildTable();

export function findShellCommand(name: string): ShellCommandRow | undefined {
  return ACP_SHELL_COMMAND_TABLE.find((row) => row.name === name);
}

/** The shell profile's `availableCommands`: the editor shape plus `_meta.keryx = { group, surface, busy }`. */
export function shellAvailableCommands(): {
  name: string;
  description: string;
  input?: { hint: string };
  _meta: { keryx: { group: HelpGroupName; surface: ShellCommandSurface; busy: ShellCommandBusy } };
}[] {
  return ACP_SHELL_COMMAND_TABLE.map((row) => ({
    name: row.name,
    description: row.description,
    ...(row.hint !== undefined ? { input: { hint: row.hint } } : {}),
    _meta: { keryx: { group: row.group, surface: row.surface, busy: row.busy } },
  }));
}

/** The shell's own wording for a command refused while a turn runs (`tui-shell.ts` and the remote gateway). */
export function busyRefusalText(name: string): string {
  return BUSY_REFUSED_COMMANDS.has(`/${name}`)
    ? "◇ main is busy — that command would replace the session under the running turn. Wait for the turn to end, or /interrupt."
    : "main is busy: command deferred";
}
