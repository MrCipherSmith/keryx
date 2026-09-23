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
  acpCommandInputProblem,
  parseAcpSlashCommand,
  parseAcpSlashPrompt,
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

  test("flow 300: /governance and /triggers are TUI-only — pinned, never advertised to an editor", () => {
    expect(ACP_TUI_ONLY_COMMANDS).toContain("governance");
    expect(ACP_TUI_ONLY_COMMANDS).toContain("triggers");
    expect(acpAvailableCommands().map((command) => command.name)).not.toContain("governance");
    expect(acpAvailableCommands().map((command) => command.name)).not.toContain("triggers");
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
    expect(parseAcpSlashCommand("/help  ")).toEqual({ name: "help", args: "" });
  });

  test("a leading space sends slash-led text to the model — the documented escape", () => {
    expect(parseAcpSlashCommand(" /explain this")).toBeUndefined();
  });

  test("text with a second line is not a command, so nothing after the command is dropped (T14)", () => {
    expect(parseAcpSlashCommand("/status\n\nalso fix X")).toBeUndefined();
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

describe("a command sent with more than it takes (flow 288, T14)", () => {
  test("the argument comes from the first block alone — an attachment never becomes part of it", () => {
    const parsed = parseAcpSlashPrompt([
      { type: "text", text: "/model foo" },
      { type: "resource", resource: { uri: "file:///secret.txt", text: "SECRET-CONTENT" } },
    ]);
    expect(parsed).toEqual({ name: "model", args: "foo", extraBlocks: true });
    const problem = acpCommandInputProblem(parsed!);
    expect(problem).toContain("takes no attachments");
    expect(problem).not.toContain("SECRET");
  });

  test("a command that takes no argument refuses extra text instead of dropping it", () => {
    const parsed = parseAcpSlashPrompt([{ type: "text", text: "/status please" }]);
    expect(acpCommandInputProblem(parsed!)).toContain("/status takes no arguments; nothing was done");
    expect(acpCommandInputProblem(parseAcpSlashPrompt([{ type: "text", text: "/status" }])!)).toBeUndefined();
    expect(acpCommandInputProblem(parseAcpSlashPrompt([{ type: "text", text: "/model a/b" }])!)).toBeUndefined();
  });

  test("a first block that is not text is not a command", () => {
    expect(parseAcpSlashPrompt([{ type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "/help" }])).toBeUndefined();
  });
});
