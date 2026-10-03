// The command gateway (flow 387): which slash commands a line from the Telegram topic may run.
//
// A line that starts with "/" never reaches the model and never reaches the shell's command
// line directly. It is classified here, against an explicit allowlist, and only then does the
// bridge act on the answer. Anything not listed is refused with a reason and nothing runs.
//
// Pure and a leaf: no IO, no imports from the shell. The bridge uses it to decide, serve uses
// it to set the bot's command menu, and `/help` in the topic prints from it, so the three can
// never disagree about what is available.
//
// Telegram menu names are lowercase letters, digits and underscores only, so a hyphenated
// command is spelled with an underscore in the menu and in `/help` (`/external_agents`).
// Both spellings are accepted when typed.

import type { BotCommandMenuEntry } from "./types";

/** How a command runs from the topic. */
export type RemoteCommandKind =
  /** Runs in the shell as typed; its output goes to the topic. */
  | "text"
  /** Answered by the bridge itself (the help text, the session list). */
  | "builtin"
  /** Opens a button picker in the topic. */
  | "picker"
  /** Runs only after a Yes/No press in the topic when its arguments change something. */
  | "confirm";

export interface RemoteCommandSpec {
  /** The shell's own name, without the slash (`external-agents`). */
  name: string;
  kind: RemoteCommandKind;
  /** One line for the menu and `/help`; at most 256 characters. */
  description: string;
}

/** The allowlist, in menu order. Everything a topic may run is on this list. */
export const REMOTE_COMMANDS: readonly RemoteCommandSpec[] = [
  { name: "help", kind: "builtin", description: "List the commands you can use from this topic" },
  { name: "status", kind: "text", description: "Show the session: model, mode, queue, usage" },
  { name: "doctor", kind: "text", description: "Run the health checks" },
  { name: "model", kind: "picker", description: "Pick another model with buttons" },
  { name: "connect", kind: "picker", description: "Switch to a connected provider with buttons" },
  { name: "resume", kind: "picker", description: "Return to an earlier session with buttons" },
  { name: "sessions", kind: "builtin", description: "List recent sessions" },
  { name: "stop", kind: "builtin", description: "Stop the run you started from Telegram" },
  { name: "new", kind: "text", description: "Start a new session; this topic stays bound to it" },
  { name: "clear", kind: "text", description: "Same as /new" },
  { name: "compact", kind: "text", description: "Compact the conversation: /compact [focus]" },
  { name: "think", kind: "text", description: "Set how reasoning shows: /think <auto|expand|hide>" },
  { name: "goal", kind: "text", description: "Show or set the session goal" },
  { name: "queue", kind: "text", description: "Manage the queue: /queue <remove|edit|force> [N]" },
  { name: "mode", kind: "confirm", description: "Show or set the permission mode; trust and auto ask for a button press" },
  { name: "plan", kind: "confirm", description: "Read-only mode: /plan [on|off]; bare shows it, off asks for a button press" },
  { name: "reasoning", kind: "text", description: "Show or set reasoning effort" },
  { name: "theme", kind: "text", description: "Set the theme: /theme <name>" },
  { name: "jevrules", kind: "text", description: "Show the Jev rules" },
  { name: "staledocs", kind: "text", description: "Show stale documents" },
  { name: "opencomments", kind: "text", description: "Show open review comments" },
  { name: "contract", kind: "text", description: "Show the contract check" },
  { name: "triage", kind: "text", description: "Advisory triage of the latest review package" },
  { name: "risk", kind: "text", description: "Risk map of the working diff" },
  { name: "scenarios", kind: "text", description: "User scenarios the working diff likely changes" },
  { name: "delegate", kind: "confirm", description: "Hand a paid task to an external agent: /delegate <agent> <task>; asks first" },
  { name: "external", kind: "confirm", description: "Show or switch sending work to external providers; on and off ask first" },
  { name: "external-agents", kind: "confirm", description: "Show or switch the external agent runtime; on and off ask first" },
];

/** Commands that are never run from the topic, each with the reason the topic is told. */
export const REMOTE_REFUSED: Readonly<Record<string, string>> = {
  exit: "it would close the shell",
  quit: "it would close the shell",
  channels: "it manages the Telegram connection itself",
  provider: "it asks for provider keys and addresses, which are never typed into a chat",
  "search-provider": "it asks for provider keys, which are never typed into a chat",
  "search-connect": "it changes where searches are sent",
  "remote-control": "turning remote control off would delete this topic, and its panel is local",
  integrate: "it edits other tools' configuration on this machine",
  copy: "it uses this machine's clipboard",
  game: "it needs the shell's screen",
  setup: "it asks for keys and changes the configuration",
  mcp: "it can trust tools and change server connections; use the shell",
  guard: "it changes a safety guard; use the shell",
  route: "it changes where work is routed; use the shell",
  editguard: "it changes a safety guard; use the shell",
  settings: "it edits settings, some of them secret; use the shell",
  bus: "it talks to other agents on this machine",
  review: "it needs the shell's screen",
  reviews: "it needs the shell's screen",
  product: "it needs the shell's screen",
  governance: "it needs the shell's screen",
  decisions: "it opens a panel in the shell",
  expand: "it needs the shell's screen",
  interrupt: "use /stop here to end a run you started from Telegram, or stop it in the shell",
  permissions: "it opens a panel in the shell; saved rules are changed there, never from a chat",
  "remote-policy": "it changes what Telegram may do without asking; use the shell",
  demote: "it works on the shell's own tasks",
  models: "use /model",
  "external-diff": "listing and applying external patches stays in the shell, where the patch hash is typed",
  flows: "it opens a panel in the shell",
  ac: "it opens a panel in the shell",
  workspace: "it opens a panel in the shell",
  approvals: "it opens a panel in the shell",
  triggers: "it opens a panel in the shell",
  routing: "it opens a panel in the shell",
  schedules: "it opens a panel in the shell",
  schedule: "it opens a form in the shell",
  rewind: "it opens a picker of earlier points in the shell",
  conform: "it opens a picker in the shell",
  ci: "it opens a panel in the shell",
  jevprofile: "it opens a panel with toggles in the shell",
};

/** The commands a shell refuses while a turn runs, when the host gives no better answer. */
export const BUSY_DEFERRED_COMMANDS: readonly string[] = ["new", "clear", "resume", "sessions", "compact", "model", "connect"];

/** The reason the shell gives for a command it will not run during a turn. */
export const BUSY_REASON = "main is busy: command deferred";

export type GatewayDecision =
  /** Run the line in the shell; its output goes back to the topic. */
  | { kind: "run"; command: string; line: string }
  /** Answered by the bridge. */
  | { kind: "builtin"; command: string; args: string }
  /** Open a picker. */
  | { kind: "picker"; command: string; args: string }
  /** Ask Yes/No first, then run `line`. `agent` is set for `/delegate`. */
  | { kind: "confirm"; command: string; line: string; summary: string; agent?: string }
  /** Never run from the topic. `known` is false for a name no command has. */
  | { kind: "refuse"; command: string; reason: string; known: boolean };

const MENU_NAME = /^[a-z0-9_]{1,32}$/;

/** The menu spelling of a command: hyphens become underscores. */
export function menuName(name: string): string {
  return name.replace(/-/g, "_");
}

const BY_NAME = new Map(REMOTE_COMMANDS.map((spec) => [spec.name, spec]));
const BY_MENU = new Map(REMOTE_COMMANDS.map((spec) => [menuName(spec.name), spec]));

/** `/Help@my_bot args` becomes `{ token: "help", args: "args" }`. */
function split(line: string): { token: string; args: string } {
  const trimmed = line.trim();
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const args = space === -1 ? "" : trimmed.slice(space).trim();
  const at = head.indexOf("@");
  const bare = (at === -1 ? head : head.slice(0, at)).replace(/^\/+/, "").toLowerCase();
  return { token: bare, args };
}

function refuse(command: string, reason: string, known: boolean): GatewayDecision {
  return { kind: "refuse", command, reason, known };
}

/** The sentence the topic gets for a refusal. */
export function refusalText(command: string, reason: string): string {
  return `Not available remotely: /${command}. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? "" : "."}`;
}

/** Classify a line that starts with "/". Pure. */
export function classifyRemoteCommand(line: string): GatewayDecision {
  const { token, args } = split(line);
  if (token.length === 0) {
    return refuse("", "an empty command", false);
  }
  const canonical = token.replace(/_/g, "-");
  const refusedReason = REMOTE_REFUSED[canonical] ?? REMOTE_REFUSED[token];
  const spec = BY_NAME.get(canonical) ?? BY_MENU.get(token);

  if (canonical === "remote-control") {
    const sub = args.split(/\s+/)[0]?.toLowerCase() ?? "";
    return refuse(canonical, sub === "off" ? "it would delete this topic; turn it off in the shell" : (refusedReason ?? "its panel is local"), true);
  }
  if (spec === undefined) {
    if (refusedReason !== undefined) {
      return refuse(canonical, refusedReason, true);
    }
    return refuse(canonical, "it is not on the list of commands a topic may run; /help shows the list", false);
  }
  const name = spec.name;
  const rest = args.trim();
  const first = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
  const asTyped = rest.length === 0 ? `/${name}` : `/${name} ${rest}`;

  switch (name) {
    case "mode":
      if (first === "trust" || first === "auto") {
        return { kind: "confirm", command: name, line: `/mode ${first}`, summary: `Switch the permission mode to ${first}?` };
      }
      if (first === "" || first === "ask") {
        return { kind: "run", command: name, line: asTyped };
      }
      return refuse(name, "the mode is ask, trust or auto", true);
    case "plan":
      if (first === "off") {
        return { kind: "confirm", command: name, line: "/plan off", summary: "Turn read-only mode off?" };
      }
      if (first === "") {
        // Bare `/plan` only shows the state in the shell, so it needs no confirmation.
        return { kind: "run", command: name, line: "/plan" };
      }
      return first === "on" ? { kind: "run", command: name, line: "/plan on" } : refuse(name, "use /plan on or /plan off", true);
    case "theme":
      return first === "" ? refuse(name, "bare /theme opens a picker in the shell; use /theme <name>", true) : { kind: "run", command: name, line: asTyped };
    case "think":
      return first === "auto" || first === "expand" || first === "hide"
        ? { kind: "run", command: name, line: `/think ${first}` }
        : refuse(name, "bare /think and /think collapse only flip the view in the shell; use /think auto, expand or hide", true);
    case "delegate":
      // The agent and the task are shown as the shell would read them; a line the shell would
      // refuse as malformed is refused here too, so nobody confirms something that cannot run.
      return confirmDelegate(rest);
    case "external":
      if (first === "on" || first === "off") {
        return {
          kind: "confirm",
          command: name,
          line: `/external ${first}`,
          summary: `Switch sending private work to external providers ${first}? This changes what leaves this machine.`,
        };
      }
      return first === "" ? { kind: "run", command: name, line: "/external" } : refuse(name, "use /external, /external on or /external off", true);
    case "external-agents":
      if (first === "on" || first === "off") {
        return {
          kind: "confirm",
          command: name,
          line: `/external-agents ${first}`,
          summary: `Turn the external agent runtime ${first}? External agents are paid and run outside keryx.`,
        };
      }
      return first === "" ? { kind: "run", command: name, line: "/external-agents" } : refuse(name, "use /external_agents, /external_agents on or /external_agents off", true);
    default:
      break;
  }
  switch (spec.kind) {
    case "builtin":
      return { kind: "builtin", command: name, args: rest };
    case "picker":
      return { kind: "picker", command: name, args: rest };
    default:
      return { kind: "run", command: name, line: name === "new" || name === "clear" ? `/${name}` : asTyped };
  }
}

/** Matches the shell's own `/delegate <agent> <task>` shape; the agent is named in the question. */
function confirmDelegate(rest: string): GatewayDecision {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  if (match === null) {
    return refuse("delegate", "it needs an agent and a task: /delegate <agent> <task>", true);
  }
  const agent = (match[1] ?? "").toLowerCase();
  const task = (match[2] ?? "").trim();
  const shown = task.length > 200 ? `${task.slice(0, 200)}... [shortened for this question: the full task is ${task.length} characters and runs as typed]` : task;
  return {
    kind: "confirm",
    command: "delegate",
    line: `/delegate ${match[1] ?? ""} ${task}`,
    agent,
    summary: `Hand this task to ${agent}? It is an external agent and runs outside keryx; the run is paid.\nTask: ${shown}`,
  };
}

/** The bot's command menu: exactly the allowed commands, in the menu's spelling. */
export function remoteMenu(): BotCommandMenuEntry[] {
  return REMOTE_COMMANDS.map((spec) => ({ command: menuName(spec.name), description: spec.description.slice(0, 256) }));
}

/** The text `/help` prints in the topic: the same set as the menu, one line each. */
export function remoteHelpText(): string {
  const lines = ["Commands you can use from this topic:"];
  for (const spec of REMOTE_COMMANDS) {
    lines.push(`/${menuName(spec.name)} - ${spec.description}`);
  }
  lines.push("", "Anything else typed here goes to the model as a message. Other commands run in the shell.");
  return lines.join("\n");
}

/** Whether `name` (shell spelling) needs the shell idle. Used when the host gives no answer. */
export function isBusyDeferred(name: string): boolean {
  return BUSY_DEFERRED_COMMANDS.includes(name);
}

/** Every menu name is valid for Telegram; the test holds this. */
export function menuNamesAreValid(): boolean {
  return REMOTE_COMMANDS.every((spec) => MENU_NAME.test(menuName(spec.name)));
}
