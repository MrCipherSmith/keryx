// Shared slash-command registry for BOTH shell modes (flow 062; mode-aware in
// flow 112 S4).
//
// One source of truth for the interactive commands, consumed by three surfaces:
// the OpenTUI composer's live `/` dropdown + submit handler (`tui/tui-shell.ts`),
// the readline chat REPL (`runShell`) and the readline agent REPL
// (`runAgentRepl`). Pure + deterministic — nothing here touches IO.
//
// A command is not simply "available" or "absent": `/model` and `/connect` exist
// in both modes but MEAN different things (chat's `/model` takes a `<name>`
// argument and never opens a picker; the TUI's opens one). A single flattened
// `{name, description}` would make the menu lie in one of the two modes, so the
// registry keeps the definition mode-aware and only ever flattens THROUGH a mode
// (see {@link describeCommand} / {@link commandsForMode}).

/** The two shell modes. `agent` has tools; `chat` is a plain conversation. */
export type ShellMode = "chat" | "agent";

/** Every mode, in a stable order (menu/help rendering, exhaustiveness tests). */
export const SHELL_MODES: readonly ShellMode[] = ["chat", "agent"];

/**
 * A command as presented in ONE mode: exactly the `{name, description}` shape
 * OpenTUI's `SelectRenderable` options want. Obtainable only by resolving a
 * registry entry against a mode, so a menu cannot render another mode's text.
 */
export interface SlashCommandOption {
  name: string;
  description: string;
}

/** A registry entry: one command, plus what it means in each mode it exists in. */
export interface AgentSlashCommand {
  /** The slash token, e.g. `/help`. */
  name: string;
  /** Description for every listed mode that has no `modeDescriptions` override. */
  description: string;
  /** The modes this command is available in. Never empty. */
  modes: readonly ShellMode[];
  /**
   * Per-mode description overrides, for commands whose SEMANTICS differ between
   * the surfaces (flow 112 risk R4) — not for cosmetic rewording. Present only
   * on `/model`, `/connect` and `/exit`.
   */
  modeDescriptions?: Readonly<Partial<Record<ShellMode, string>>>;
}

const CHAT_ONLY: readonly ShellMode[] = ["chat"];
const AGENT_ONLY: readonly ShellMode[] = ["agent"];
const BOTH: readonly ShellMode[] = ["chat", "agent"];

/**
 * The commands, in menu order. Filtering this list to `agent` reproduces the
 * pre-flow-112 agent menu's SET and ORDER exactly — but not verbatim: four
 * descriptions were sharpened when the registry became mode-aware (`/model`,
 * `/connect` and `/exit`, which now spell out the agent-mode behaviour their
 * `modeDescriptions` carry, plus `/compact`, which names its `[focus]` argument).
 */
export const AGENT_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  { name: "/help", description: "Show available commands", modes: BOTH },
  {
    name: "/model",
    description: "Switch the model",
    modes: BOTH,
    modeDescriptions: {
      // Two genuinely different commands behind one token (R4).
      agent: "Switch the model (interactive picker)",
      chat: "Switch the active model for later turns — /model <name>",
    },
  },
  {
    name: "/models",
    description: "Pick a model for the current provider (numbered menu)",
    // The TUI's `/model` picker subsumes this, so it stays a chat-mode entry.
    modes: CHAT_ONLY,
  },
  {
    name: "/connect",
    description: "Switch provider / API key",
    modes: BOTH,
    modeDescriptions: {
      agent: "Switch provider / API key (interactive picker, key entry)",
      chat: "Show how to set a provider API key in the environment",
    },
  },
  {
    name: "/provider",
    description: "Switch provider — /provider <name>, or no arg to re-select",
    // The TUI's `/connect` picker subsumes this, so it stays a chat-mode entry.
    modes: CHAT_ONLY,
  },
  { name: "/think", description: "Expand the last reasoning block", modes: AGENT_ONLY },
  { name: "/expand", description: "Expand the last tool output block", modes: AGENT_ONLY },
  {
    name: "/copy",
    description: "Copy the newest transcript block to the clipboard",
    modes: AGENT_ONLY,
  },
  { name: "/new", description: "Start a new session (old kept on disk)", modes: BOTH },
  { name: "/resume", description: "Resume a prior session in this project", modes: AGENT_ONLY },
  {
    name: "/compact",
    description: "Compact model context — /compact [focus] (archive kept)",
    modes: BOTH,
  },
  { name: "/clear", description: "New session (alias of /new)", modes: BOTH },
  {
    name: "/exit",
    description: "Leave the shell (/quit works too)",
    modes: BOTH,
    modeDescriptions: { agent: "Leave agent mode (/quit works too)" },
  },
];

/** True when `command` is offered in `mode`. Pure. */
export function isCommandInMode(command: AgentSlashCommand, mode: ShellMode): boolean {
  return command.modes.includes(mode);
}

/**
 * The description `command` carries IN `mode`: the per-mode override when the
 * semantics differ there, else the shared default. Pure.
 */
export function describeCommand(command: AgentSlashCommand, mode: ShellMode): string {
  return command.modeDescriptions?.[mode] ?? command.description;
}

/**
 * The commands available in `mode`, in menu order, already flattened to the
 * `{name, description}` option shape with that mode's wording. Pure.
 */
export function commandsForMode(mode: ShellMode): SlashCommandOption[] {
  return AGENT_SLASH_COMMANDS.filter((c) => isCommandInMode(c, mode)).map((c) => ({
    name: c.name,
    description: describeCommand(c, mode),
  }));
}

/**
 * Filter `mode`'s commands by a composer `query`. Returns `[]` when `query` is
 * not a slash query; `/` alone returns ALL of the mode's commands; otherwise a
 * case-insensitive prefix match on the name (without the leading `/`). Pure.
 */
export function filterCommands(query: string, mode: ShellMode): SlashCommandOption[] {
  const q = query.trim().toLowerCase();
  if (!q.startsWith("/")) {
    return [];
  }
  const needle = q.slice(1);
  return commandsForMode(mode).filter((c) => c.name.slice(1).toLowerCase().startsWith(needle));
}

/** The first whitespace-delimited token of `line`, with `/quit` mapped to `/exit`. */
function commandToken(line: string): string {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === "/quit" ? "/exit" : token;
}

/** Look a token up across ALL modes, ignoring availability. Pure. */
function findAnyMode(line: string): AgentSlashCommand | undefined {
  const token = commandToken(line);
  return AGENT_SLASH_COMMANDS.find((c) => c.name === token);
}

/**
 * Resolve a submitted line's FIRST token to a command available in `mode`.
 * `/quit` aliases `/exit`; a token that is unknown — or known but belonging to
 * another mode — returns `undefined`. Use {@link describeUnavailableCommand} to
 * tell those two cases apart. Pure.
 */
export function findAgentCommand(line: string, mode: ShellMode): AgentSlashCommand | undefined {
  const command = findAnyMode(line);
  // /clear is a first-class command (alias behavior handled by the shell).
  return command !== undefined && isCommandInMode(command, mode) ? command : undefined;
}

/**
 * An explanatory message when `line`'s token is a REAL command that this mode
 * does not offer (e.g. `/expand` typed in chat), else `undefined` — so a wrong-
 * mode command fails with a reason instead of a bare "unknown command". Pure.
 */
export function describeUnavailableCommand(line: string, mode: ShellMode): string | undefined {
  const command = findAnyMode(line);
  if (command === undefined || isCommandInMode(command, mode)) {
    return undefined;
  }
  const where = command.modes.map((m) => `${m} mode`).join(" or ");
  return (
    `${command.name} is only available in ${where} — this is ${mode} mode. ` +
    `Type /help for the commands available here.\n`
  );
}

/**
 * Render `mode`'s commands as an aligned `Commands:` block. `only` restricts the
 * list to the given names (a surface that implements a subset of the mode —
 * the readline agent REPL — must not advertise what it cannot run), keeping the
 * registry's wording either way. Pure.
 */
export function renderCommandHelp(mode: ShellMode, only?: readonly string[]): string {
  const allow = only === undefined ? undefined : new Set(only);
  const options = commandsForMode(mode).filter((c) => allow === undefined || allow.has(c.name));
  const width = options.reduce((w, c) => Math.max(w, c.name.length), 0);
  return (
    ["Commands:", ...options.map((c) => `  ${c.name.padEnd(width)}  ${c.description}`)].join("\n") +
    "\n"
  );
}
