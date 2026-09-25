// Flow 305 (Flow A), AC6 — mapping a resolved `CategoryAssignment` to a
// `ChildModelRequest`, BEFORE `resolveChildModel`'s gates (untouched by this
// flow, AC7) ever see it.

import { expect, test } from "bun:test";
import { categoryAssignmentToChildModelRequest } from "./child-model-request";

test("session-default -> undefined (inherit the parent, same as an omitted request)", () => {
  expect(categoryAssignmentToChildModelRequest({ kind: "session-default" })).toBeUndefined();
});

test("model -> an explicit request naming exactly that provider/model", () => {
  expect(categoryAssignmentToChildModelRequest({ kind: "model", providerId: "anthropic", modelId: "claude-x" })).toEqual({
    kind: "explicit",
    providerId: "anthropic",
    modelId: "claude-x",
  });
});

test("provider-default -> an explicit request naming the provider's resolved default model", () => {
  expect(categoryAssignmentToChildModelRequest({ kind: "provider-default", providerId: "ollama" })).toEqual({
    kind: "explicit",
    providerId: "ollama",
    modelId: "llama3.1:latest",
  });
});

test("provider-default for an unknown provider -> undefined (inherit), never an explicit request naming an empty modelId", () => {
  expect(categoryAssignmentToChildModelRequest({ kind: "provider-default", providerId: "not-a-real-provider" })).toBeUndefined();
});
