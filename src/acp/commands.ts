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
// is a TUI surface (`/workspace`, `/review`, `/integrations`, `/mcp`, `/game`,
// and every picker or transcript command) is not advertised.

import type { AcpAvailableCommand } from "./protocol";

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
export const ACP_TUI_ONLY_COMMANDS: readonly string[] = ["workspace", "review", "integrations", "mcp", "game"];

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
 * The command a prompt carries, or `undefined` when it is an ordinary prompt.
 *
 * A command is a `/` followed by a word and then whitespace or the end. A prompt
 * that merely STARTS with a slash — a pasted path such as `/src/cli.ts fails` —
 * is not one: the token after the slash contains another `/`, so it goes to the
 * model like any other text instead of being answered "unknown command".
 */
export function parseAcpSlashCommand(prompt: string): ParsedAcpSlashCommand | undefined {
  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (match === null) {
    return undefined;
  }
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

/** The line an unlisted command is answered with. */
export function unknownAcpCommandText(name: string): string {
  return `keryx does not handle /${name} in this editor. Available commands:\n${acpCommandHelpText()}`;
}

export function acpCommandHelpText(): string {
  return ACP_SLASH_COMMANDS.map(
    (command) => `  /${command.name}${command.hint !== undefined ? ` [${command.hint}]` : ""} — ${command.description}`,
  ).join("\n");
}
