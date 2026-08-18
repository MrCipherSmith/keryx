import { expect, test } from "bun:test";
import {
  AGENT_SLASH_COMMANDS,
  SHELL_MODES,
  commandsForMode,
  describeCommand,
  describeUnavailableCommand,
  filterCommands,
  findAgentCommand,
  isCommandInMode,
  renderCommandHelp,
} from "./agent-commands";

// SLATE-15 (flow 161, T10 — AC1/AC2): `/goal` is added to the registry
// AGENT_ONLY (mirrors `/expand`/`/think`/`/copy` — deterministic entry is a
// TUI/readline agent-mode concept, not a chat-mode one), positioned right
// after `/new` (session-lifecycle grouping: `/new`, `/goal`, `/resume`,
// `/sessions`). RED until T11 adds this entry — the exact-order lists below
// (and `filterCommands("/", "agent")`, further down this file) are the
// pinned target shape, not yet true of the real registry.
test("AGENT_SLASH_COMMANDS lists the expected commands", () => {
  expect(AGENT_SLASH_COMMANDS.map((c) => c.name)).toEqual([
    "/help",
    "/model",
    "/models",
    "/connect",
    "/search-provider",
    "/search-connect",
    "/provider",
    "/think",
    "/expand",
    "/copy",
    "/new",
    "/goal",
    "/resume",
    "/sessions",
    "/status",
    "/flows",
    "/workspace",
    "/review",
    "/compact",
    "/theme",
    "/mode",
    "/clear",
    "/interrupt",
    "/queue",
    "/exit",
  ]);
});

test("SLATE-15: /goal is agent-only (deterministic entry has no chat-mode meaning)", () => {
  const goal = AGENT_SLASH_COMMANDS.find((c) => c.name === "/goal");
  expect(goal).toBeDefined();
  expect(goal?.modes).toEqual(["agent"]);
  expect(goal && goal.description.length).toBeGreaterThan(0);
});

test("SLATE-15: findAgentCommand resolves /goal (with args) in agent mode, never in chat mode", () => {
  expect(findAgentCommand("/goal do the thing --workspace w1", "agent")?.name).toBe("/goal");
  expect(findAgentCommand("/goal", "chat")).toBeUndefined();
});

test("SLATE-15: filterCommands('/g', 'agent') resolves to /goal", () => {
  expect(filterCommands("/g", "agent").map((c) => c.name)).toEqual(["/goal"]);
});

test("flow 167: /queue is agent-only (main-queue remove/edit/force has no chat-mode meaning)", () => {
  const queue = AGENT_SLASH_COMMANDS.find((c) => c.name === "/queue");
  expect(queue).toBeDefined();
  expect(queue?.modes).toEqual(["agent"]);
  expect(queue && queue.description.length).toBeGreaterThan(0);
});

test("flow 167: findAgentCommand resolves /queue (with args) in agent mode, never in chat mode", () => {
  expect(findAgentCommand("/queue remove 2", "agent")?.name).toBe("/queue");
  expect(findAgentCommand("/queue", "chat")).toBeUndefined();
});

test("flow 167: filterCommands('/q', 'agent') resolves to /queue", () => {
  expect(filterCommands("/q", "agent").map((c) => c.name)).toEqual(["/queue"]);
});

test("every command declares at least one mode, and every mode resolves a description", () => {
  for (const command of AGENT_SLASH_COMMANDS) {
    expect(command.modes.length).toBeGreaterThan(0);
    for (const mode of command.modes) {
      expect(SHELL_MODES).toContain(mode);
      expect(describeCommand(command, mode).length).toBeGreaterThan(0);
    }
  }
});

test("commandsForMode: agent lists its commands in stable order", () => {
  expect(commandsForMode("agent").map((c) => c.name)).toEqual([
    "/help",
    "/model",
    "/connect",
    "/search-provider",
    "/search-connect",
    "/provider",
    "/think",
    "/expand",
    "/copy",
    "/new",
    "/goal",
    "/resume",
    "/sessions",
    "/status",
    "/flows",
    "/workspace",
    "/review",
    "/compact",
    "/theme",
    "/mode",
    "/clear",
    "/interrupt",
    "/queue",
    "/exit",
  ]);
});

test("commandsForMode: chat gets its commands and none of the agent-only trio", () => {
  const chat = commandsForMode("chat").map((c) => c.name);
  expect(chat).toEqual([
    "/help",
    "/model",
    "/models",
    "/connect",
    "/provider",
    "/new",
    "/status",
    "/flows",
    "/compact",
    "/theme",
    "/clear",
    "/exit",
  ]);
  expect(chat).not.toContain("/think");
  expect(chat).not.toContain("/expand");
  expect(chat).not.toContain("/copy");
});

test("/status and /flows are available in both modes; old aliases are gone", () => {
  for (const name of ["/status", "/flows"]) {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === name);
    expect(command?.modes).toEqual(["chat", "agent"]);
    expect(findAgentCommand(name, "chat")?.name).toBe(name);
    expect(findAgentCommand(name, "agent")?.name).toBe(name);
  }
  expect(findAgentCommand("/session-info", "agent")).toBeUndefined();
  expect(findAgentCommand("/info", "agent")).toBeUndefined();
});

test("/expand, /think and /copy are agent-only; /models is chat-only; /provider is available in both modes", () => {
  for (const name of ["/expand", "/think", "/copy"]) {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === name);
    expect(command?.modes).toEqual(["agent"]);
  }
  for (const name of ["/models"]) {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === name);
    expect(command?.modes).toEqual(["chat"]);
  }
  const provider = AGENT_SLASH_COMMANDS.find((c) => c.name === "/provider");
  expect(provider?.modes).toEqual(["chat", "agent"]);
});

test("/model and /connect carry PER-MODE descriptions, not one flattened entry (R4)", () => {
  const model = AGENT_SLASH_COMMANDS.find((c) => c.name === "/model");
  const connect = AGENT_SLASH_COMMANDS.find((c) => c.name === "/connect");
  expect(model).toBeDefined();
  expect(connect).toBeDefined();
  if (model === undefined || connect === undefined) {
    return;
  }
  expect(describeCommand(model, "chat")).not.toBe(describeCommand(model, "agent"));
  expect(describeCommand(connect, "chat")).not.toBe(describeCommand(connect, "agent"));
  // chat's /model takes an argument and opens no picker; the TUI's opens one.
  expect(describeCommand(model, "chat")).toContain("<name>");
  expect(describeCommand(model, "agent")).toContain("picker");
  // chat's /connect is a connected-only switch; agent wording names the picker.
  expect(describeCommand(connect, "chat")).toContain("connected");
  expect(describeCommand(connect, "agent")).toContain("picker");
});

test("isCommandInMode reflects the declared modes", () => {
  const expand = AGENT_SLASH_COMMANDS.find((c) => c.name === "/expand");
  expect(expand).toBeDefined();
  if (expand === undefined) {
    return;
  }
  expect(isCommandInMode(expand, "agent")).toBe(true);
  expect(isCommandInMode(expand, "chat")).toBe(false);
});

test("filterCommands: `/` returns all of the mode's commands", () => {
  expect(filterCommands("/", "agent").map((c) => c.name)).toEqual([
    "/help",
    "/model",
    "/connect",
    "/search-provider",
    "/search-connect",
    "/provider",
    "/think",
    "/expand",
    "/copy",
    "/new",
    "/goal",
    "/resume",
    "/sessions",
    "/status",
    "/flows",
    "/workspace",
    "/review",
    "/compact",
    "/theme",
    "/mode",
    "/clear",
    "/interrupt",
    "/queue",
    "/exit",
  ]);
  expect(filterCommands("/", "chat").map((c) => c.name)).toEqual([
    "/help",
    "/model",
    "/models",
    "/connect",
    "/provider",
    "/new",
    "/status",
    "/flows",
    "/compact",
    "/theme",
    "/clear",
    "/exit",
  ]);
});

test("filterCommands: prefix narrows the set (agent)", () => {
  expect(filterCommands("/h", "agent").map((c) => c.name)).toEqual(["/help"]);
  expect(filterCommands("/c", "agent").map((c) => c.name)).toEqual([
    "/connect",
    "/copy",
    "/compact",
    "/clear",
  ]);
  expect(filterCommands("/e", "agent").map((c) => c.name)).toEqual(["/expand", "/exit"]);
  expect(filterCommands("/co", "agent").map((c) => c.name)).toEqual([
    "/connect",
    "/copy",
    "/compact",
  ]);
  expect(filterCommands("/m", "agent").map((c) => c.name)).toEqual(["/model", "/mode"]);
  expect(filterCommands("/re", "agent").map((c) => c.name)).toEqual(["/resume", "/review"]);
  expect(filterCommands("/int", "agent").map((c) => c.name)).toEqual(["/interrupt"]);
  expect(filterCommands("/s", "agent").map((c) => c.name)).toEqual([
    "/search-provider",
    "/search-connect",
    "/sessions",
    "/status",
  ]);
  expect(filterCommands("/i", "agent").map((c) => c.name)).toEqual(["/interrupt"]);
  expect(filterCommands("/f", "agent").map((c) => c.name)).toEqual(["/flows"]);
  expect(filterCommands("/n", "agent").map((c) => c.name)).toEqual(["/new"]);
  expect(filterCommands("/comp", "agent").map((c) => c.name)).toEqual(["/compact"]);
});

test("filterCommands: prefix narrows the set (chat)", () => {
  expect(filterCommands("/m", "chat").map((c) => c.name)).toEqual(["/model", "/models"]);
  expect(filterCommands("/p", "chat").map((c) => c.name)).toEqual(["/provider"]);
  expect(filterCommands("/p", "agent").map((c) => c.name)).toEqual(["/provider"]);
  expect(filterCommands("/e", "chat").map((c) => c.name)).toEqual(["/exit"]);
  expect(filterCommands("/c", "chat").map((c) => c.name)).toEqual([
    "/connect",
    "/compact",
    "/clear",
  ]);
  expect(filterCommands("/s", "chat").map((c) => c.name)).toEqual(["/status"]);
  expect(filterCommands("/f", "chat").map((c) => c.name)).toEqual(["/flows"]);
  expect(filterCommands("/re", "chat")).toEqual([]);
});

test("filterCommands: options carry the mode's own wording", () => {
  const chatModel = filterCommands("/model", "chat")[0];
  const agentModel = filterCommands("/model", "agent")[0];
  expect(chatModel?.description).toContain("<name>");
  expect(agentModel?.description).toContain("picker");
});

test("filterCommands: no match → empty; non-slash → empty", () => {
  expect(filterCommands("/zzz", "agent")).toEqual([]);
  expect(filterCommands("hello", "agent")).toEqual([]);
  expect(filterCommands("", "agent")).toEqual([]);
  expect(filterCommands("/zzz", "chat")).toEqual([]);
});

test("findAgentCommand resolves the first token, aliases /quit to /exit", () => {
  expect(findAgentCommand("/clear", "agent")?.name).toBe("/clear");
  expect(findAgentCommand("/help extra args", "agent")?.name).toBe("/help");
  expect(findAgentCommand("/quit", "agent")?.name).toBe("/exit");
  expect(findAgentCommand("/quit", "chat")?.name).toBe("/exit");
  expect(findAgentCommand("/nope", "agent")).toBeUndefined();
  expect(findAgentCommand("just text", "agent")).toBeUndefined();
});

test("findAgentCommand is mode-scoped: another mode's command does NOT resolve", () => {
  expect(findAgentCommand("/expand", "agent")?.name).toBe("/expand");
  expect(findAgentCommand("/expand", "chat")).toBeUndefined();
  expect(findAgentCommand("/models", "chat")?.name).toBe("/models");
  expect(findAgentCommand("/models", "agent")).toBeUndefined();
});

test("describeUnavailableCommand explains a wrong-mode command and stays quiet otherwise", () => {
  const message = describeUnavailableCommand("/expand", "chat");
  expect(message).toBeDefined();
  expect(message).toContain("/expand");
  expect(message).toContain("agent mode");
  expect(message).toContain("chat mode");
  expect(describeUnavailableCommand("/models", "agent")).toContain("chat mode");
  // Available here, or not a command at all → nothing to explain.
  expect(describeUnavailableCommand("/expand", "agent")).toBeUndefined();
  expect(describeUnavailableCommand("/help", "chat")).toBeUndefined();
  expect(describeUnavailableCommand("/nope", "chat")).toBeUndefined();
  expect(describeUnavailableCommand("just text", "chat")).toBeUndefined();
});

test("renderCommandHelp lists the mode's commands with the mode's descriptions", () => {
  const chat = renderCommandHelp("chat");
  expect(chat.startsWith("Commands:\n")).toBe(true);
  for (const option of commandsForMode("chat")) {
    expect(chat).toContain(option.name);
    expect(chat).toContain(option.description);
  }
  expect(chat).not.toContain("/expand");
  const agent = renderCommandHelp("agent");
  expect(agent).toContain("/expand");
  expect(agent).toContain("/provider");
});

test("renderCommandHelp `only` restricts the list to a surface's subset", () => {
  const help = renderCommandHelp("agent", ["/help", "/expand"]);
  expect(help).toContain("/help");
  expect(help).toContain("/expand");
  expect(help).not.toContain("/compact");
});
