import { describe, expect, test } from "bun:test";
import type { AvailableCommand, InitializeResult } from "./types";
import { fillTemplate, findCommand, flattenGroups, groupCommands, hasCommandExtension, initialValues, parseCommandLine, SECRET_MASK } from "./commands";

const cmd = (name: string, group?: string, description = `does ${name}`): AvailableCommand => ({
  name,
  description,
  _meta: group ? { keryx: { group, surface: "text", busy: "run" } } : undefined,
});

describe("command lines", () => {
  test("a line splits into name and trimmed args", () => {
    expect(parseCommandLine("/tasks kill  t3 ")).toEqual({ name: "tasks", args: "kill  t3" });
    expect(parseCommandLine("/new")).toEqual({ name: "new", args: "" });
  });

  test("text that is not a command line does not parse, a leading space included", () => {
    expect(parseCommandLine("hello")).toBeNull();
    expect(parseCommandLine(" /new")).toBeNull();
    expect(parseCommandLine("/")).toBeNull();
  });

  test("only an advertised command is found, case-insensitively", () => {
    const list = [cmd("tasks"), cmd("new")];
    expect(findCommand(list, "/TASKS x")?.command.name).toBe("tasks");
    expect(findCommand(list, "/nope")).toBeUndefined();
  });
});

describe("palette grouping", () => {
  const many = Array.from({ length: 30 }, (_, i) => cmd(`cmd${i}`, i % 2 ? "Odd" : "Even"));

  test("all commands are listed, not capped at eight, grouped in first-seen order", () => {
    const groups = groupCommands(many, "");
    expect(groups.map((g) => g.group)).toEqual(["Even", "Odd"]);
    expect(flattenGroups(groups)).toHaveLength(30);
  });

  test("a query keeps name prefix matches before substring and description matches", () => {
    const list = [cmd("a-tasks", "G"), cmd("tasks", "G"), cmd("other", "H", "shows tasks")];
    expect(flattenGroups(groupCommands(list, "tas")).map((c) => c.name)).toEqual(["tasks", "a-tasks", "other"]);
    expect(flattenGroups(groupCommands(list, "zzz"))).toHaveLength(0);
  });

  test("a command without metadata lands in a default group", () => {
    expect(groupCommands([cmd("x")], "")[0]?.group).toBe("Commands");
  });
});

describe("view form templates", () => {
  const fields = [
    { id: "name", label: "Name", kind: "text" },
    { id: "key", label: "Key", kind: "secret" },
    { id: "on", label: "On", kind: "toggle" },
  ];

  test("placeholders are filled; a secret is masked only for display", () => {
    const values = { name: "openai", key: "sk-123", on: true };
    expect(fillTemplate("/connect {name} {key} {on}", fields, values)).toBe("/connect openai sk-123 true");
    const shown = fillTemplate("/connect {name} {key}", fields, values, true);
    expect(shown).toBe(`/connect openai ${SECRET_MASK}`);
    expect(shown.includes("sk-123")).toBe(false);
  });

  test("initial values follow the field kinds", () => {
    expect(initialValues([{ id: "c", label: "C", kind: "choice", options: ["a", "b"] }, { id: "t", label: "T", kind: "toggle" }])).toEqual({ c: "a", t: false });
  });
});

describe("capability", () => {
  test("the command method is read from initialize extensions", () => {
    const init = (extensions?: string[]) => ({ protocolVersion: 1, _meta: { keryx: { extensions } } }) as InitializeResult;
    expect(hasCommandExtension(init(["_keryx/command"]))).toBe(true);
    expect(hasCommandExtension(init(["other"]))).toBe(false);
    expect(hasCommandExtension(init())).toBe(false);
  });
});
