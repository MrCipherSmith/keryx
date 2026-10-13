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

// Flow 425 (AC4/AC8): a policy tag travels from the model's input to the host, and the loop's own
// untrusted-content flag, never the model's, is what marks a question as shaped by outside content.
test("flow 425: a well-formed policy tag reaches the host as given", async () => {
  const seen: AskUserRequest[] = [];
  const tool = createAskUserTool(async (req) => {
    seen.push(req);
    return "a";
  });
  const policy = { kind: "budget", facts: { budgetUsedPercent: 20, raisesBudget: false } };
  await tool.invoke({ question: "Which?", options: options(["a"]), policy });
  expect(seen[0]?.policy).toEqual(policy);
});

test("flow 425: a malformed policy tag is dropped, and the question is still asked", async () => {
  const seen: AskUserRequest[] = [];
  const tool = createAskUserTool(async (req) => {
    seen.push(req);
    return "a";
  });
  const bad = ["budget", [], null, { kind: "", facts: {} }, { kind: "budget" }, { kind: "budget", facts: [] }, { kind: "x".repeat(65), facts: {} }];
  for (const policy of bad) {
    const result = await tool.invoke({ question: "Which?", options: options(["a"]), policy });
    expect(result.isError).toBe(false);
  }
  expect(seen).toHaveLength(bad.length);
  for (const request of seen) expect(request.policy).toBeUndefined();
});

test("flow 425: untrustedContent is set from the loop's context, not from the model's input", async () => {
  const seen: AskUserRequest[] = [];
  const tool = createAskUserTool(async (req) => {
    seen.push(req);
    return "a";
  });
  await tool.invoke({ question: "Which?", options: options(["a"]), untrustedContent: true });
  await tool.invoke({ question: "Which?", options: options(["a"]) }, { untrustedContentSeen: true } as never);
  expect(seen[0]?.untrustedContent).toBeUndefined();
  expect(seen[1]?.untrustedContent).toBe(true);
});

test("flow 425: the description names the policy field and the closed kinds", () => {
  expect(ASK_USER_DESCRIPTION).toContain("policy");
  expect(ASK_USER_DESCRIPTION).toContain("slice_order");
});
