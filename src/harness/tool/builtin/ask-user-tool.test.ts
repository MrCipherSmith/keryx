import { expect, test } from "bun:test";
import { createAskUserTool } from "./ask-user-tool";

test("ask_user returns chosen option from host callback", async () => {
  const tool = createAskUserTool(async (req) => {
    expect(req.question).toContain("scope");
    expect(req.options.length).toBe(2);
    return req.options[0]!.id;
  });
  const result = await tool.invoke({
    question: "What is the scope?",
    options: [
      { id: "a", label: "MVP", description: "Smallest ship", recommended: true },
      { id: "b", label: "Full", description: "Everything" },
    ],
  });
  expect(result.isError).toBe(false);
  expect(result.output).toContain('id="a"');
  expect(result.output).toContain("recommended");
});

test("ask_user rejects bad input", async () => {
  const tool = createAskUserTool(async () => "x");
  expect((await tool.invoke({ question: "", options: [] })).isError).toBe(true);
  expect(
    (
      await tool.invoke({
        question: "q",
        options: [{ id: "only", label: "One" }],
      })
    ).isError,
  ).toBe(true);
});

test("ask_user surfaces cancel", async () => {
  const tool = createAskUserTool(async () => "__cancel__");
  const result = await tool.invoke({
    question: "Continue?",
    options: [
      { id: "y", label: "Yes", description: "" },
      { id: "n", label: "No", description: "" },
    ],
  });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/cancel/i);
});

test("ask_user passes the irreversible flag and the action tag to the host (flow 392, round 3)", async () => {
  const seen: Array<{ action?: string; irreversible?: boolean }> = [];
  const tool = createAskUserTool(async (req) => {
    seen.push({
      ...(req.action === undefined ? {} : { action: req.action }),
      ...(req.irreversible === undefined ? {} : { irreversible: req.irreversible }),
    });
    return req.options[0]!.id;
  });
  const options = [
    { id: "a", label: "Yes", description: "" },
    { id: "b", label: "No", description: "" },
  ];
  await tool.invoke({ question: "Go?", options, action: "  release  ", irreversible: true });
  await tool.invoke({ question: "Go?", options });
  await tool.invoke({ question: "Go?", options, action: "   ", irreversible: false });
  expect(seen).toEqual([{ action: "release", irreversible: true }, {}, {}]);
});

test("the ask_user definition tells the agent it must set irreversible or action", () => {
  const { definition } = createAskUserTool(async () => "x");
  expect(definition.description).toMatch(/MUST set irreversible: true, or name it in action/);
  for (const word of ["release", "publish", "deploy", "delete", "push"]) expect(definition.description).toContain(word);
  const properties = (definition.inputSchema as { properties: Record<string, { type: string }> }).properties;
  expect(properties["action"]?.type).toBe("string");
  expect(properties["irreversible"]?.type).toBe("boolean");
});
