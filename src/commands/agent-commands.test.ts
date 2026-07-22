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

test("AGENT_SLASH_COMMANDS lists the expected commands", () => {
  expect(AGENT_SLASH_COMMANDS.map((c) => c.name)).toEqual([
    "/help",
    "/model",
    "/models",
    "/connect",
    "/provider",
    "/think",
    "/expand",
    "/copy",
    "/new",
    "/resume",
    "/compact",
    "/clear",
    "/exit",
  ]);
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

test("commandsForMode: agent keeps the pre-flow-112 menu, in order", () => {
  expect(commandsForMode("agent").map((c) => c.name)).toEqual([
    "/help",
    "/model",
    "/connect",
    "/think",
    "/expand",
    "/copy",
    "/new",
    "/resume",
    "/compact",
    "/clear",
    "/exit",
  ]);
});

test("commandsForMode: chat gets /models + /provider and none of the agent-only trio", () => {
  const chat = commandsForMode("chat").map((c) => c.name);
  expect(chat).toEqual([
    "/help",
    "/model",
    "/models",
    "/connect",
    "/provider",
    "/new",
    "/compact",
    "/clear",
    "/exit",
  ]);
  expect(chat).not.toContain("/think");
  expect(chat).not.toContain("/expand");
  expect(chat).not.toContain("/copy");
});

test("/expand, /think and /copy are agent-only; /models and /provider are chat-only", () => {
  for (const name of ["/expand", "/think", "/copy"]) {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === name);
    expect(command?.modes).toEqual(["agent"]);
  }
  for (const name of ["/models", "/provider"]) {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === name);
    expect(command?.modes).toEqual(["chat"]);
  }
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
  // chat's /connect is static env guidance; the TUI's is a picker + key entry.
  expect(describeCommand(connect, "chat")).toContain("environment");
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
    "/think",
    "/expand",
    "/copy",
    "/new",
    "/resume",
    "/compact",
    "/clear",
    "/exit",
  ]);
  expect(filterCommands("/", "chat").map((c) => c.name)).toEqual([
    "/help",
    "/model",
    "/models",
    "/connect",
    "/provider",
    "/new",
    "/compact",
    "/clear",
    "/exit",
  ]);
});

test("filterCommands: prefix narrows the set (agent, unchanged from flow 062)", () => {
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
  expect(filterCommands("/m", "agent").map((c) => c.name)).toEqual(["/model"]);
  expect(filterCommands("/re", "agent").map((c) => c.name)).toEqual(["/resume"]);
  expect(filterCommands("/n", "agent").map((c) => c.name)).toEqual(["/new"]);
  expect(filterCommands("/comp", "agent").map((c) => c.name)).toEqual(["/compact"]);
});

test("filterCommands: prefix narrows the set (chat)", () => {
  expect(filterCommands("/m", "chat").map((c) => c.name)).toEqual(["/model", "/models"]);
  expect(filterCommands("/p", "chat").map((c) => c.name)).toEqual(["/provider"]);
  expect(filterCommands("/e", "chat").map((c) => c.name)).toEqual(["/exit"]);
  expect(filterCommands("/c", "chat").map((c) => c.name)).toEqual([
    "/connect",
    "/compact",
    "/clear",
  ]);
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
  expect(agent).not.toContain("/provider");
});

test("renderCommandHelp `only` restricts the list to a surface's subset", () => {
  const help = renderCommandHelp("agent", ["/help", "/expand"]);
  expect(help).toContain("/help");
  expect(help).toContain("/expand");
  expect(help).not.toContain("/compact");
});
