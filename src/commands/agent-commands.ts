// Shared agent-mode slash-command registry (flow 062).
//
// One source of truth for the interactive commands, consumed by the OpenTUI
// composer's live `/` dropdown (SelectRenderable options are `{name, description}`
// — this exact shape) and by the submit handler. Pure + deterministic.

export interface AgentSlashCommand {
  /** The slash token, e.g. `/help`. */
  name: string;
  /** One-line description shown in the dropdown. */
  description: string;
}

/** The agent-mode commands, in menu order. */
export const AGENT_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/model", description: "Switch the model" },
  { name: "/connect", description: "Switch provider / API key" },
  { name: "/think", description: "Expand the last reasoning block" },
  { name: "/expand", description: "Expand the last tool output block" },
  { name: "/copy", description: "Copy the newest transcript block to the clipboard" },
  { name: "/new", description: "Start a new session (old kept on disk)" },
  { name: "/resume", description: "Resume a prior session in this project" },
  { name: "/compact", description: "Compact model context (archive kept)" },
  { name: "/clear", description: "New session (alias of /new)" },
  { name: "/exit", description: "Leave agent mode" },
];

/**
 * Filter the registry by a composer `query`. Returns `[]` when `query` is not a
 * slash query; `/` alone returns ALL commands; otherwise a case-insensitive prefix
 * match on the command name (without the leading `/`). Pure.
 */
export function filterCommands(query: string): AgentSlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q.startsWith("/")) {
    return [];
  }
  const needle = q.slice(1);
  return AGENT_SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(needle));
}

/**
 * Resolve a submitted line's FIRST token to a command. `/quit` aliases `/exit`;
 * an unknown token returns `undefined`. Pure.
 */
export function findAgentCommand(line: string): AgentSlashCommand | undefined {
  const token = line.trim().split(/\s+/)[0] ?? "";
  if (token === "/quit") {
    return AGENT_SLASH_COMMANDS.find((c) => c.name === "/exit");
  }
  // /clear is a first-class command (alias behavior handled by the shell).
  return AGENT_SLASH_COMMANDS.find((c) => c.name === token);
}
