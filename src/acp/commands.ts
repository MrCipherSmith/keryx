// Slash commands over ACP (flow 288, AC4).
//
// ACP advertises commands through `session/update` `available_commands_update`
// and delivers them as ordinary `session/prompt` text beginning with `/`
// ("Slash Commands", agentclientprotocol.com). This file owns WHICH commands
// keryx advertises and how a prompt is recognised as one; `server.ts` runs them,
// because each one reads or changes session state only the server holds.
//
// Only commands keryx actually handles over this wire are listed. Every one is
// a real `keryx shell` command (`AGENT_SLASH_COMMANDS`, agent mode) — this list
// narrows that registry, it does not invent a second vocabulary — but its
// description is written for the editor, because several shell descriptions
// promise a TUI picker that does not exist here. A command whose whole meaning
// is a TUI surface (`/workspace`, `/review`, `/governance`, `/triggers`,
// `/integrations`, `/mcp`, `/game`,
// and every picker or transcript command) is not advertised.

import type { AcpAvailableCommand } from "./protocol";
// Flow 303 (AC7): group `/help`'s text the same way `keryx help` and the TUI's
// `/help` modal do — reached ONLY through this core facade (see the zone note
// in `src/standard/help-groups.ts`), never `../standard/help-groups` directly.
// ACP keeps its OWN editor-specific descriptions (see the file header on
// `ACP_SLASH_COMMANDS`); only the GROUP an entry falls under, and the order
// groups print in, come from the shared table.
import { findSlashEntry, HELP_GROUP_ORDER, type HelpGroupName } from "../standard/service";

export interface AcpSlashCommandSpec {
  /** Without the leading slash, as ACP's `AvailableCommand.name` carries it. */
  readonly name: string;
  readonly description: string;
  /** `AvailableCommand.input.hint`, for a command that takes an argument. */
  readonly hint?: string;
}

export const ACP_SLASH_COMMANDS: readonly AcpSlashCommandSpec[] = [
  { name: "help", description: "List the commands keryx handles in this editor" },
  {
    name: "model",
    description: "List the models this session can run, or switch to one from the next turn",
    hint: "model to switch to (omit to list)",
  },
  {
    name: "reasoning",
    description: "Show or set this session's reasoning effort from the next turn",
    hint: "off | minimal | low | medium | high | xhigh | max",
  },
  { name: "status", description: "Show this session's model, project root, reasoning effort, tools and MCP servers" },
];

/**
 * Shell commands that exist only as a TUI surface. Never advertised over ACP;
 * pinned so a later widening of `ACP_SLASH_COMMANDS` cannot pick one up.
 */
export const ACP_TUI_ONLY_COMMANDS: readonly string[] = [
  "workspace",
  "review",
  "governance",
  "triggers",
  // Flow 295: scheduling confirms a card in the TUI; an editor never reaches it.
  "schedule",
  "schedules",
  "integrations",
  "mcp",
  "game",
];

/** The `availableCommands` payload, in the published shape (`name`, `description`, optional `input.hint`). */
export function acpAvailableCommands(): AcpAvailableCommand[] {
  return ACP_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.hint !== undefined ? { input: { hint: command.hint } } : {}),
  }));
}

export interface ParsedAcpSlashCommand {
  readonly name: string;
  readonly args: string;
}

/**
 * The command one line of text carries, or `undefined` when it is not one.
 *
 * A command is a `/`, a word, and optionally an argument ON THE SAME LINE —
 * nothing else. Three things are deliberately NOT commands, and go to the
 * model as ordinary text (flow 288, T14):
 *   - text with a second line (`/status\n\nalso fix X`): answering `/status`
 *     would silently drop the rest;
 *   - text starting with whitespace (` /explain this`): the documented way to
 *     send a slash-led prompt to the model, as Zed itself suggests;
 *   - text whose first token contains another `/` (`/src/cli.ts fails`): a path.
 */
export function parseAcpSlashCommand(text: string): ParsedAcpSlashCommand | undefined {
  const line = text.trimEnd();
  if (line.includes("\n") || line.includes("\r")) {
    return undefined;
  }
  const match = /^\/([A-Za-z][\w-]*)(?:[ \t]+(.*))?$/.exec(line);
  if (match === null) {
    return undefined;
  }
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

export interface ParsedAcpSlashPrompt extends ParsedAcpSlashCommand {
  /** The prompt carried more blocks (an attachment, an image) after the command line. */
  readonly extraBlocks: boolean;
}

/**
 * The command a `session/prompt`'s blocks carry: only when the FIRST block is
 * text that is a command by {@link parseAcpSlashCommand}. The argument is
 * taken from that line alone, so an attachment's content never becomes — or is
 * echoed back as — part of it.
 */
export function parseAcpSlashPrompt(blocks: readonly unknown[]): ParsedAcpSlashPrompt | undefined {
  const first = blocks[0] as { type?: unknown; text?: unknown } | undefined;
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    return undefined;
  }
  const command = parseAcpSlashCommand(first.text);
  return command === undefined ? undefined : { ...command, extraBlocks: blocks.length > 1 };
}

/**
 * Why a recognised command cannot run as sent, or `undefined` when it can.
 * Refused rather than half-run: a command never drops what came with it.
 */
export function acpCommandInputProblem(command: ParsedAcpSlashPrompt): string | undefined {
  const spec = ACP_SLASH_COMMANDS.find((entry) => entry.name === command.name);
  if (spec === undefined) {
    return undefined;
  }
  if (command.extraBlocks) {
    return `/${command.name} takes no attachments; nothing was done. Send the command on its own.`;
  }
  if (spec.hint === undefined && command.args.length > 0) {
    return (
      `/${command.name} takes no arguments; nothing was done. ` +
      "To send text that starts with a slash to the model, begin it with a space."
    );
  }
  return undefined;
}

/** The line an unlisted command is answered with. */
export function unknownAcpCommandText(name: string): string {
  return `keryx does not handle /${name} in this editor. Available commands:\n${acpCommandHelpText()}`;
}

/** One command's rendered line, in ACP's own wording (never the shared table's generic summary). */
function acpCommandLine(command: AcpSlashCommandSpec): string {
  return `  /${command.name}${command.hint !== undefined ? ` [${command.hint}]` : ""} — ${command.description}`;
}

/**
 * Flow 303 (AC7): grouped the same way `keryx help` and the TUI's `/help`
 * modal group everything — by the onboarding task table — because a modal
 * cannot render over ACP. Only four commands are advertised here at all, so
 * most groups are empty and printed nothing; that is expected, not a bug.
 *
 * PR #669 review, LOW: an ACP command with no `HELP_GROUPS` entry used to
 * fall into a synthetic "Other" bucket that `HELP_GROUP_ORDER`'s render loop
 * below never visits — it would vanish from `/help` silently, with nothing
 * to say why. Throwing here instead turns "a future ACP command silently
 * disappears" into "the build fails, naming exactly which command and where
 * to fix it" — every advertised command MUST have a real home in the shared
 * task table, same as every CLI verb and shell slash command already must
 * (AC1).
 *
 * `commands` defaults to the real registry; overridable only so a test can
 * prove the throw fires for a synthetic unclassified command without
 * needing one to actually exist in `ACP_SLASH_COMMANDS`.
 */
export function acpCommandHelpText(commands: readonly AcpSlashCommandSpec[] = ACP_SLASH_COMMANDS): string {
  const byGroup = new Map<HelpGroupName, AcpSlashCommandSpec[]>();
  for (const command of commands) {
    const entry = findSlashEntry(`/${command.name}`);
    if (entry === undefined) {
      throw new Error(
        `acpCommandHelpText: "/${command.name}" is in ACP_SLASH_COMMANDS but has no HELP_GROUPS entry — ` +
          "add it to src/standard/help-groups.ts so it has a real group instead of silently vanishing from /help.",
      );
    }
    const list = byGroup.get(entry.group) ?? [];
    list.push(command);
    byGroup.set(entry.group, list);
  }
  const lines: string[] = [];
  for (const group of HELP_GROUP_ORDER) {
    const commands = byGroup.get(group.name);
    if (commands === undefined) {
      continue;
    }
    lines.push(`${group.name}:`, ...commands.map(acpCommandLine));
  }
  return lines.join("\n");
}
