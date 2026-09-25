// Flow 305 (Flow A), AC1 — `ROUTING_CATEGORIES`, `CategoryAssignment`, and
// `resolveCategory`'s precedence (explicit override > per-project > per-user
// > `default`, PRD §5). Pure — no fs/network.

import { expect, test } from "bun:test";
import {
  describeAssignment,
  flatModelOptions,
  isRoutingCategory,
  parseAssignmentTarget,
  resolveCategory,
  resolveCategoryDetailed,
  ROUTING_CATEGORIES,
  WIRED_ROUTING_CATEGORIES,
} from "./table";

test("ROUTING_CATEGORIES: the full PRD §4 catalogue, in order", () => {
  expect(ROUTING_CATEGORIES).toEqual([
    "default",
    "review",
    "subagents",
    "quick",
    "coding",
    "planning",
    "docs",
    "unattended",
  ]);
});

test("isRoutingCategory rejects an unknown string", () => {
  expect(isRoutingCategory("review")).toBe(true);
  expect(isRoutingCategory("nonsense")).toBe(false);
});

test("WIRED_ROUTING_CATEGORIES: only review and subagents are wired in Flow A", () => {
  expect([...WIRED_ROUTING_CATEGORIES].sort()).toEqual(["review", "subagents"]);
});

test("resolveCategory: nothing configured -> session-default", () => {
  expect(resolveCategory("review", {})).toEqual({ kind: "session-default" });
});

test("resolveCategory: per-user alone answers", () => {
  const user = { review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-x" } };
  expect(resolveCategory("review", { user })).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
});

test("resolveCategory: per-project wins over per-user (PRD §5)", () => {
  const project = { review: { kind: "provider-default" as const, providerId: "deepseek" } };
  const user = { review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-x" } };
  expect(resolveCategory("review", { project, user })).toEqual({ kind: "provider-default", providerId: "deepseek" });
});

test("resolveCategory: an explicit override wins over everything (PRD §9.5)", () => {
  const override = { kind: "model" as const, providerId: "openai", modelId: "gpt-4o" };
  const project = { review: { kind: "provider-default" as const, providerId: "deepseek" } };
  const user = { review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-x" } };
  expect(resolveCategory("review", { override, project, user })).toBe(override);
});

test("resolveCategoryDetailed reports which layer answered", () => {
  expect(resolveCategoryDetailed("subagents", {}).source).toBe("default");
  expect(
    resolveCategoryDetailed("subagents", { user: { subagents: { kind: "session-default" } } }).source,
  ).toBe("user");
  expect(
    resolveCategoryDetailed("subagents", {
      project: { subagents: { kind: "session-default" } },
      user: { subagents: { kind: "session-default" } },
    }).source,
  ).toBe("project");
  expect(
    resolveCategoryDetailed("subagents", { override: { kind: "session-default" }, project: {} }).source,
  ).toBe("override");
});

test("resolveCategory: an unrelated category configured elsewhere never leaks into this one", () => {
  const user = { quick: { kind: "provider-default" as const, providerId: "deepseek" } };
  expect(resolveCategory("review", { user })).toEqual({ kind: "session-default" });
});

test("describeAssignment", () => {
  expect(describeAssignment({ kind: "session-default" })).toBe("session default");
  expect(describeAssignment({ kind: "model", providerId: "anthropic", modelId: "claude-x" })).toBe("anthropic/claude-x");
  expect(describeAssignment({ kind: "provider-default", providerId: "deepseek" })).toBe("deepseek (provider default)");
});

test("parseAssignmentTarget: <provider>/<model> -> model, bare <provider> -> provider-default", () => {
  expect(parseAssignmentTarget("anthropic/claude-x")).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
  expect(parseAssignmentTarget("deepseek")).toEqual({ kind: "provider-default", providerId: "deepseek" });
  // A model id that itself contains a slash (e.g. "openai/gpt-4o-mini" style
  // OpenRouter ids) — the FIRST slash is the provider/model boundary.
  expect(parseAssignmentTarget("openrouter/openai/gpt-4o-mini")).toEqual({
    kind: "model",
    providerId: "openrouter",
    modelId: "openai/gpt-4o-mini",
  });
});

test("parseAssignmentTarget: malformed input is refused, not silently coerced", () => {
  expect(parseAssignmentTarget("")).toBeUndefined();
  expect(parseAssignmentTarget("/no-provider")).toBeUndefined();
  expect(parseAssignmentTarget("no-model/")).toBeUndefined();
});

test("flatModelOptions: session-default first, then a provider-default row per connected provider, then every model — one flat list, never two-step", () => {
  const options = flatModelOptions([
    { name: "anthropic", models: ["claude-x", "claude-y"] },
    { name: "deepseek", models: ["deepseek-chat"] },
  ]);
  expect(options[0]).toEqual({ assignment: { kind: "session-default" }, label: "session default", search: "session default" });
  const labels = options.map((o) => o.label);
  expect(labels).toEqual([
    "session default",
    "anthropic (provider default)",
    "anthropic/claude-x",
    "anthropic/claude-y",
    "deepseek (provider default)",
    "deepseek/deepseek-chat",
  ]);
});

test("flatModelOptions: a provider with no models still gets a provider-default row", () => {
  const options = flatModelOptions([{ name: "ollama" }]);
  expect(options.map((o) => o.label)).toEqual(["session default", "ollama (provider default)"]);
});
