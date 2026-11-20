import { expect, test } from "bun:test";
import { parseRuleRequest } from "./review-rules";

const rule = {
  id: "r_1",
  name: "Team review",
  event: "review_requested",
  enabled: true,
  author: "",
  assignee: "",
  reviewer: "@my-org/team",
  requireGreen: true,
  budgetMinutes: 10,
  budgetTokens: 50000,
};

test("rule settings normalize GitHub names and preserve bounded budgets", () => {
  expect(parseRuleRequest(JSON.stringify({ kind: "save", rule }))).toMatchObject({
    rule: { reviewer: "my-org/team", budgetTokens: 50000 },
  });
  for (const patch of [
    { budgetMinutes: 0 },
    { author: "@" },
    { assignee: " @" },
    { reviewer: "@ " },
    { budgetTokens: 0 },
    { budgetTokens: 1.5 },
    { budgetTokens: Number.MAX_SAFE_INTEGER + 1 },
    { reviewer: "org/../../x" },
    { event: "unknown" },
    { name: " " },
  ]) {
    expect(() => parseRuleRequest(JSON.stringify({ kind: "save", rule: { ...rule, ...patch } }))).toThrow();
  }
});

test("card-specific automation must name a rule and target a positive PR", () => {
  for (const [number, choice] of [
    [0, { mode: "project" }],
    [1, { mode: "auto" }],
    [2, { mode: "manual", ruleId: "r" }],
  ]) {
    expect(() => parseRuleRequest(JSON.stringify({ kind: "mode", number, choice }))).toThrow();
  }
  expect(() => parseRuleRequest('{"kind":"tick"}')).toThrow();
});

test("omitted or null token limits are unlimited, explicit limits are preserved even above 250k", () => {
  for (const budgetTokens of [undefined, null, 250000, 500000]) {
    expect(parseRuleRequest(JSON.stringify({ kind: "save", rule: { ...rule, budgetTokens } }))).toMatchObject({
      rule: { budgetTokens: budgetTokens ?? null },
    });
  }
});
