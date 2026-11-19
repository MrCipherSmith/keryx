import { expect, test } from "bun:test";
import { contextUnknownGuidance, contextUnknownLines, contextUnknownPinNotice } from "./context-guidance";
import type { RoutingDecision } from "./decision";

const sol = { providerId: "openai-codex", modelId: "gpt-6.1-sol" };
const base = {
  schemaVersion: 2 as const,
  decisionId: "d1",
  requestId: "r1",
  configDigest: "c",
  snapshotDigest: "s",
  assignmentSource: "user" as const,
  recommendationSource: "none" as const,
};

test("the unknown-context refusal names the model and both fixes", () => {
  const text = contextUnknownGuidance(sol, "review");
  expect(text).toContain("openai-codex/gpt-6.1-sol has no known context length");
  expect(text).toContain("keryx routing profile set openai-codex/gpt-6.1-sol --context <tokens>");
  expect(text).toContain("keryx routing set review baseline");
});

test("the honoured-pin notice says the pin was kept and how to have it checked", () => {
  const text = contextUnknownPinNotice(sol, "review");
  expect(text).toContain("review uses openai-codex/gpt-6.1-sol, pinned by you");
  expect(text).toContain("keryx routing profile set openai-codex/gpt-6.1-sol --context <tokens>");
});

test("contextUnknownLines reads exclusions once per model and every notice, and ignores other reasons", () => {
  const blocked: RoutingDecision = {
    ...base,
    status: "blocked",
    reason: "context-unknown",
    exclusions: [
      { target: sol, reason: "context-unknown" },
      { target: sol, modelClass: "expert", reason: "context-unknown" },
      { target: { providerId: "x", modelId: "y" }, reason: "context-insufficient" },
    ],
  };
  expect(contextUnknownLines(blocked, "review")).toEqual([contextUnknownGuidance(sol, "review")]);
  const selected: RoutingDecision = { ...base, status: "selected", selection: sol, exclusions: [], notices: [{ target: sol, reason: "context-unknown" }] };
  expect(contextUnknownLines(selected, "review")).toEqual([contextUnknownPinNotice(sol, "review")]);
});
