import { expect, test } from "bun:test";
import { AGENT_SLASH_COMMANDS, filterCommands, findAgentCommand } from "./agent-commands";

test("AGENT_SLASH_COMMANDS lists the expected commands", () => {
  expect(AGENT_SLASH_COMMANDS.map((c) => c.name)).toEqual(["/help", "/model", "/connect", "/think", "/clear", "/exit"]);
});

test("filterCommands: `/` returns all commands", () => {
  expect(filterCommands("/").map((c) => c.name)).toEqual(["/help", "/model", "/connect", "/think", "/clear", "/exit"]);
});

test("filterCommands: prefix narrows the set", () => {
  expect(filterCommands("/h").map((c) => c.name)).toEqual(["/help"]);
  expect(filterCommands("/c").map((c) => c.name)).toEqual(["/connect", "/clear"]);
  expect(filterCommands("/m").map((c) => c.name)).toEqual(["/model"]);
});

test("filterCommands: no match → empty; non-slash → empty", () => {
  expect(filterCommands("/zzz")).toEqual([]);
  expect(filterCommands("hello")).toEqual([]);
  expect(filterCommands("")).toEqual([]);
});

test("findAgentCommand resolves the first token, aliases /quit to /exit", () => {
  expect(findAgentCommand("/clear")?.name).toBe("/clear");
  expect(findAgentCommand("/help extra args")?.name).toBe("/help");
  expect(findAgentCommand("/quit")?.name).toBe("/exit");
  expect(findAgentCommand("/nope")).toBeUndefined();
  expect(findAgentCommand("just text")).toBeUndefined();
});
