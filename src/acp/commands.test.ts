// Which slash commands keryx advertises over ACP, and how a prompt is read as
// one (flow 288, AC4). The wire behaviour — the update after session/new, a
// command answered without reaching the model — is in
// `project-tools.process.test.ts`.

import { describe, expect, test } from "bun:test";
import { AGENT_SLASH_COMMANDS } from "../commands/agent-commands";
import {
  ACP_SLASH_COMMANDS,
  ACP_TUI_ONLY_COMMANDS,
  acpAvailableCommands,
  parseAcpSlashCommand,
  unknownAcpCommandText,
} from "./commands";

describe("advertised commands", () => {
  test("every one is a real keryx shell command in agent mode — the registry narrowed, not a second vocabulary", () => {
    const agentCommands = new Set(
      AGENT_SLASH_COMMANDS.filter((command) => command.modes.includes("agent")).map((command) => command.name),
    );
    expect(ACP_SLASH_COMMANDS.map((command) => `/${command.name}`).filter((name) => !agentCommands.has(name))).toEqual(
      [],
    );
  });

  test("no TUI-only command is advertised, and each TUI-only one really is a shell command", () => {
    const names = ACP_SLASH_COMMANDS.map((command) => command.name);
    expect(names.filter((name) => ACP_TUI_ONLY_COMMANDS.includes(name))).toEqual([]);
    const registry = new Set(AGENT_SLASH_COMMANDS.map((command) => command.name));
    expect(ACP_TUI_ONLY_COMMANDS.filter((name) => !registry.has(`/${name}`))).toEqual([]);
  });

  test("the payload has the published shape: name without a slash, description, optional input.hint", () => {
    const commands = acpAvailableCommands();
    expect(commands.map((command) => command.name)).toEqual(["help", "model", "reasoning", "status"]);
    for (const command of commands) {
      expect(Object.keys(command).sort()).toEqual(
        command.input === undefined ? ["description", "name"] : ["description", "input", "name"],
      );
      expect(command.name.startsWith("/")).toBe(false);
      expect(command.description.length).toBeGreaterThan(0);
      if (command.input !== undefined && command.input !== null) {
        expect(Object.keys(command.input)).toEqual(["hint"]);
      }
    }
  });
});

describe("reading a prompt as a command", () => {
  test("a slash word is a command, with its argument", () => {
    expect(parseAcpSlashCommand("/model anthropic/claude-sonnet-5")).toEqual({
      name: "model",
      args: "anthropic/claude-sonnet-5",
    });
    expect(parseAcpSlashCommand("  /help  ")).toEqual({ name: "help", args: "" });
  });

  test("a prompt that only starts with a path is not a command", () => {
    expect(parseAcpSlashCommand("/src/cli.ts fails to start")).toBeUndefined();
    expect(parseAcpSlashCommand("why does /model not work?")).toBeUndefined();
  });

  test("an unlisted command is answered with the list", () => {
    const text = unknownAcpCommandText("workspace");
    expect(text).toContain("/workspace");
    for (const command of ACP_SLASH_COMMANDS) {
      expect(text).toContain(`/${command.name}`);
    }
  });
});
