// Flow 400 (AC5): the ask_user schema carries a top-level recommendationReason and
// rejects a question that marks more than one option recommended.
import { expect, test } from "bun:test";
import { ASK_USER_DESCRIPTION, createAskUserTool } from "../harness/tool/builtin/ask-user-tool";
import type { AskUserRequest } from "../harness/tool/builtin/ask-user-tool";

const REASON = "it is the reversible one";

function options(recommended: string[]): Array<{ id: string; label: string; description: string; recommended?: boolean }> {
  return ["a", "b", "c"].map((id) => ({ id, label: `Option ${id}`, description: "", ...(recommended.includes(id) ? { recommended: true } : {}) }));
}

test("AC5: the schema has a top-level recommendationReason string", () => {
  const { definition } = createAskUserTool(async () => "a");
  const properties = (definition.inputSchema as { properties: Record<string, { type: string }> }).properties;
  expect(properties["recommendationReason"]?.type).toBe("string");
  expect(definition.description).toContain("recommendationReason");
});

test("AC5: two recommended options are rejected and the host is never asked", async () => {
  let asked = 0;
  const tool = createAskUserTool(async () => {
    asked += 1;
    return "a";
  });
  const result = await tool.invoke({ question: "Which?", options: options(["a", "b"]), recommendationReason: REASON });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/at most one/);
  expect(asked).toBe(0);
});

test("AC5: one recommended option is accepted and the reason reaches the host", async () => {
  const seen: AskUserRequest[] = [];
  const tool = createAskUserTool(async (req) => {
    seen.push(req);
    return "b";
  });
  const result = await tool.invoke({ question: "Which?", options: options(["b"]), recommendationReason: `  ${REASON}  ` });
  expect(result.isError).toBe(false);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.recommendationReason).toBe(REASON);
});

test("AC5: no recommended option is accepted, and no reason goes to the host", async () => {
  const seen: AskUserRequest[] = [];
  const tool = createAskUserTool(async (req) => {
    seen.push(req);
    return "a";
  });
  const result = await tool.invoke({ question: "Which?", options: options([]), recommendationReason: REASON });
  expect(result.isError).toBe(false);
  expect(seen[0]?.recommendationReason).toBeUndefined();
});

test("AC5: a non-string recommendationReason is ignored, not an error", async () => {
  const seen: AskUserRequest[] = [];
  const tool = createAskUserTool(async (req) => {
    seen.push(req);
    return "b";
  });
  const result = await tool.invoke({ question: "Which?", options: options(["b"]), recommendationReason: 42 });
  expect(result.isError).toBe(false);
  expect(seen[0]?.recommendationReason).toBeUndefined();
});

test("S-1: the tool description says what the fields mean and gives no guidance on how the question is presented", () => {
  const { definition } = createAskUserTool(async () => "a");
  expect(definition.description).toBe(ASK_USER_DESCRIPTION);
  const text = ASK_USER_DESCRIPTION.toLowerCase();
  expect(text).not.toContain("blind");
  expect(text).not.toContain("arm");
  expect(text).not.toContain("hidden");
  // the fields stay documented
  expect(text).toContain("irreversible");
  expect(text).toContain("action");
});
