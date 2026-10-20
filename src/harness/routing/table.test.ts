// Flow 305 (Flow A), AC1 — `ROUTING_CATEGORIES`, `CategoryAssignment`, and
// `resolveCategory`'s precedence (explicit override > per-project > per-user
// > `default`, PRD §5). Pure — no fs/network.

import { expect, test } from "bun:test";
import {
  connectedPredicateFrom,
  connectVerdict,
  describeAssignment,
  describeFallbackNotice,
  describeNotConnectedReason,
  describeRejectionNotice,
  flatModelOptions,
  isRoutingCategory,
  parseAssignmentTarget,
  resolveCategory,
  resolveCategoryDetailed,
  ROUTING_CATEGORIES,
  sessionDerivationModels,
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

// ---------------------------------------------------------------------------
// Flow 305 AC10 — an assignment naming an unconnected provider/model is
// unresolved at its layer and falls through.
// ---------------------------------------------------------------------------

test("connectedPredicateFrom: a provider absent from the list is not connected", () => {
  const connected = connectedPredicateFrom([{ name: "anthropic", models: ["claude-x"] }]);
  expect(connected("anthropic")).toBe(true);
  expect(connected("anthropic", "claude-x")).toBe(true);
  expect(connected("anthropic", "claude-y")).toBe(false);
  expect(connected("deepseek")).toBe(false);
});

test("connectedPredicateFrom: a provider with NO reported model list cannot refute a specific model id, so it is treated as connected", () => {
  const connected = connectedPredicateFrom([{ name: "ollama" }]);
  expect(connected("ollama", "llama3.1:latest")).toBe(true);
});

test("resolveCategory/resolveCategoryDetailed: omitting `connected` is byte-identical to before AC10 (default = everything connected)", () => {
  const user = { review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-x" } };
  expect(resolveCategory("review", { user })).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
  expect(resolveCategoryDetailed("review", { user }).rejected).toBeUndefined();
});

test("resolveCategoryDetailed: a user-layer assignment naming an unconnected provider falls through to default, and reports the rejection", () => {
  const user = { review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-x" } };
  const connected = connectedPredicateFrom([]); // nothing connected
  const result = resolveCategoryDetailed("review", { user }, connected);
  expect(result.assignment).toEqual({ kind: "session-default" });
  expect(result.source).toBe("default");
  expect(result.rejected).toEqual({ assignment: { kind: "model", providerId: "anthropic", modelId: "claude-x" }, source: "user" });
});

test("resolveCategoryDetailed: an unconnected project layer falls through to a CONNECTED user layer", () => {
  const project = { review: { kind: "model" as const, providerId: "anthropic", modelId: "claude-x" } };
  const user = { review: { kind: "model" as const, providerId: "deepseek", modelId: "deepseek-chat" } };
  const connected = connectedPredicateFrom([{ name: "deepseek", models: ["deepseek-chat"] }]);
  const result = resolveCategoryDetailed("review", { project, user }, connected);
  expect(result.assignment).toEqual({ kind: "model", providerId: "deepseek", modelId: "deepseek-chat" });
  expect(result.source).toBe("user");
  expect(result.rejected).toEqual({ assignment: { kind: "model", providerId: "anthropic", modelId: "claude-x" }, source: "project" });
});

test("resolveCategoryDetailed: an unconnected explicit override also falls through (AC10 applies at every layer)", () => {
  const override = { kind: "model" as const, providerId: "anthropic", modelId: "claude-x" };
  const user = { review: { kind: "model" as const, providerId: "deepseek", modelId: "deepseek-chat" } };
  const connected = connectedPredicateFrom([{ name: "deepseek", models: ["deepseek-chat"] }]);
  const result = resolveCategoryDetailed("review", { override, user }, connected);
  expect(result.source).toBe("user");
  expect(result.rejected?.source).toBe("override");
});

test("resolveCategoryDetailed: a provider-default assignment only needs the PROVIDER connected, not a specific model", () => {
  const user = { review: { kind: "provider-default" as const, providerId: "deepseek" } };
  const connected = connectedPredicateFrom([{ name: "deepseek", models: ["deepseek-chat"] }]);
  const result = resolveCategoryDetailed("review", { user }, connected);
  expect(result.assignment).toEqual({ kind: "provider-default", providerId: "deepseek" });
  expect(result.rejected).toBeUndefined();
});

test("resolveCategoryDetailed: session-default is always resolvable (never rejected by `connected`)", () => {
  const user = { review: { kind: "session-default" as const } };
  const connected = connectedPredicateFrom([]);
  const result = resolveCategoryDetailed("review", { user }, connected);
  expect(result.assignment).toEqual({ kind: "session-default" });
  expect(result.source).toBe("user");
  expect(result.rejected).toBeUndefined();
});

test("describeFallbackNotice: AC10's exact wording", () => {
  expect(
    describeFallbackNotice(
      { kind: "model", providerId: "anthropic", modelId: "claude-x" },
      { kind: "session-default" },
    ),
  ).toBe("anthropic/claude-x - not connected, falling back to session default");
});

// --- flow 468 AC3: the session's own provider/model is always connected and pickable ---
// `connectedPredicateFrom` and `flatModelOptions` take an optional trailing `session: {providerId, modelId}`.

const SESSION = { providerId: "openai-codex", modelId: "gpt-test" } as const;

test("flow 468 AC3: connectedPredicateFrom counts the session's provider (and model) as connected even when the list lacks it", () => {
  const connected = connectedPredicateFrom([{ name: "deepseek", models: ["deepseek-chat"] }], SESSION);
  expect(connected("openai-codex", "gpt-test")).toBe(true);
  expect(connected("openai-codex")).toBe(true);
  // Only the session's own provider is added, not everything.
  expect(connected("anthropic", "claude-x")).toBe(false);
  expect(connected("deepseek", "deepseek-chat")).toBe(true);
});

test("flow 468 AC3: resolution keeps an assignment to the session's model when the provider list is empty", () => {
  const user = { coding: { kind: "model" as const, providerId: "openai-codex", modelId: "gpt-test" } };
  const connected = connectedPredicateFrom([], SESSION);
  const result = resolveCategoryDetailed("coding", { user }, connected);
  expect(result.assignment).toEqual({ kind: "model", providerId: "openai-codex", modelId: "gpt-test" });
  expect(result.source).toBe("user");
  expect(result.rejected).toBeUndefined();
});

test("flow 468 AC3: flatModelOptions lists the session's provider/model labelled `(current session)` even when the catalog lacks it", () => {
  const options = flatModelOptions([{ name: "deepseek", models: ["deepseek-chat"] }], SESSION);
  const row = options.find((o) => o.label.includes("openai-codex/gpt-test"));
  expect(row).toBeDefined();
  expect(row?.label).toContain("(current session)");
  expect(row?.assignment).toEqual({ kind: "model", providerId: "openai-codex", modelId: "gpt-test" });
  // The ordinary rows are untouched.
  expect(options.map((o) => o.label)).toContain("deepseek/deepseek-chat");
  expect(options[0]?.label).toBe("session default");
});

test("flow 468 AC3: flatModelOptions does not list the session's model twice when the catalog already has it", () => {
  const options = flatModelOptions([{ name: "openai-codex", models: ["gpt-test", "gpt-other"] }], SESSION);
  const rows = options.filter((o) => o.assignment.kind === "model" && o.assignment.providerId === "openai-codex" && o.assignment.modelId === "gpt-test");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.label).toContain("(current session)");
  expect(options.map((o) => o.label)).toContain("openai-codex/gpt-other");
});

test("flow 468 AC3: the session provider is listed but lacks the session model — the session model is still a `(current session)` row, once", () => {
  const options = flatModelOptions([{ name: "openai-codex", models: ["gpt-other"] }], SESSION);
  const rows = options.filter((o) => o.assignment.kind === "model" && o.assignment.providerId === "openai-codex" && o.assignment.modelId === "gpt-test");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.label).toContain("(current session)");
  // The provider's own listed model is untouched.
  expect(options.map((o) => o.label)).toContain("openai-codex/gpt-other");
});

test("flow 468 AC3: connectedPredicateFrom — the session provider is connected for the session model only, never for another model it lacks", () => {
  const connected = connectedPredicateFrom([{ name: "openai-codex", models: ["gpt-other"] }], SESSION);
  expect(connected("openai-codex", "gpt-test")).toBe(true);
  expect(connected("openai-codex", "gpt-other")).toBe(true);
  // A different model id of the session provider falls to the list: absent from it, so not connected.
  expect(connected("openai-codex", "gpt-missing")).toBe(false);
  // With no list entry at all the provider is connected for itself and the session model, not for others.
  const bare = connectedPredicateFrom([], SESSION);
  expect(bare("openai-codex", "gpt-test")).toBe(true);
  expect(bare("openai-codex", "gpt-missing")).toBe(false);
});

test("flow 468 AC3: connectedPredicateFrom — the session provider stays connected when the list holds it only as auth-failed", () => {
  const connected = connectedPredicateFrom([{ name: "openai-codex", models: [], authFailed: true }], SESSION);
  expect(connected("openai-codex", "gpt-test")).toBe(true);
  expect(connected("openai-codex")).toBe(true);
  // Another model of that provider is not rescued by the session shortcut.
  expect(connected("openai-codex", "gpt-other")).toBe(false);
});

test("flow 468 AC3: sessionDerivationModels falls back to the session model for an auth-failed, unlisted or absent session provider", () => {
  expect(sessionDerivationModels([{ name: "openai-codex", models: [], authFailed: true }], SESSION)).toEqual(["gpt-test"]);
  expect(sessionDerivationModels([{ name: "openai-codex", models: [], listUnavailable: "unreachable" }], SESSION)).toEqual(["gpt-test"]);
  expect(sessionDerivationModels([], SESSION)).toEqual(["gpt-test"]);
  // A connectable provider keeps its own list, as before.
  expect(sessionDerivationModels([{ name: "openai-codex", models: ["gpt-a", "gpt-b"] }], SESSION)).toEqual(["gpt-a", "gpt-b"]);
});

// --- flow 468 AC4: one verdict decides connected, the reason text and the picker rows ---

test("flow 468 AC4: connectVerdict names each way a provider/model is not connected", () => {
  const providers = [
    { name: "alpha", models: ["a1"] },
    { name: "beta", models: [], authFailed: true },
    { name: "gamma", models: [], listUnavailable: "timed out" },
  ];
  expect(connectVerdict(providers, "alpha", "a1")).toBe("connected");
  expect(connectVerdict(providers, "alpha")).toBe("connected");
  expect(connectVerdict(providers, "alpha", "gone")).toBe("model-absent");
  expect(connectVerdict(providers, "alpha", "gpt-6-astra")).toBe("model-denied");
  expect(connectVerdict(providers, "beta")).toBe("provider-auth-failed");
  expect(connectVerdict(providers, "gamma", "g1")).toBe("provider-unlisted");
  expect(connectVerdict(providers, "delta")).toBe("provider-absent");
});

test("flow 468 AC4: describeNotConnectedReason uses the Model tab's five words, by the load state", () => {
  const model = (providerId: string, modelId: string) => ({ kind: "model" as const, providerId, modelId });
  const listed = { providers: [{ name: "alpha", models: ["a1"] }, { name: "beta", models: [], authFailed: true }] };
  // The load failed or timed out: the list says nothing.
  expect(describeNotConnectedReason(model("alpha", "a1"), { providers: [], unavailable: true })).toBe("provider list unavailable");
  // The load succeeded and found nothing.
  expect(describeNotConnectedReason(model("alpha", "a1"), { providers: [] })).toBe("no providers connected");
  expect(describeNotConnectedReason(model("delta", "d1"), listed)).toBe("provider not connected");
  expect(describeNotConnectedReason(model("beta", "b1"), listed)).toBe("provider auth failed");
  expect(describeNotConnectedReason({ kind: "provider-default", providerId: "beta" }, listed)).toBe("provider auth failed");
  expect(describeNotConnectedReason(model("alpha", "gone"), listed)).toBe("model not in alpha's list");
  // A list holding only auth-failed providers is loaded and non-empty: an assignment to another provider is "not connected", not "unavailable".
  expect(describeNotConnectedReason(model("alpha", "a1"), { providers: [{ name: "beta", models: [], authFailed: true }] })).toBe("provider not connected");
  // A provider shown on the Model tab as "model list unavailable (<reason>)" falls back with those words.
  expect(describeNotConnectedReason(model("gamma", "g1"), { providers: [{ name: "gamma", models: [], listUnavailable: "unreachable" }] })).toBe("model list unavailable (unreachable)");
  // A denied model and a session default have no word of their own: the generic text.
  expect(describeNotConnectedReason(model("alpha", "gpt-6-astra"), listed)).toBe("not connected");
  expect(describeNotConnectedReason({ kind: "session-default" }, listed)).toBe("not connected");
});

test("flow 468 AC4: describeRejectionNotice without a list keeps the plain `not connected` wording; with one it carries the reason", () => {
  const rejected = { assignment: { kind: "model" as const, providerId: "alpha", modelId: "gone" } };
  const resolved = { kind: "session-default" as const };
  expect(describeRejectionNotice(rejected, resolved)).toBe("alpha/gone - not connected, falling back to session default");
  expect(describeRejectionNotice(rejected, resolved, { providers: [{ name: "alpha", models: ["a1"] }] })).toBe(
    "alpha/gone - model not in alpha's list, falling back to session default",
  );
});

test("flow 468 AC4: the picker never offers what resolution would reject — auth-failed, list-unavailable providers and denied models are skipped", () => {
  const providers = [
    { name: "alpha", models: ["a1", "gpt-6-astra"] },
    { name: "beta", models: [], authFailed: true },
    { name: "gamma", models: [], listUnavailable: "timed out" },
  ];
  const options = flatModelOptions(providers);
  const labels = options.map((o) => o.label);
  expect(labels).toEqual(["session default", "alpha (provider default)", "alpha/a1"]);
  // Every offered row is one the shared predicate accepts.
  const connected = connectedPredicateFrom(providers);
  for (const option of options) {
    if (option.assignment.kind === "model") expect(connected(option.assignment.providerId, option.assignment.modelId)).toBe(true);
    if (option.assignment.kind === "provider-default") expect(connected(option.assignment.providerId)).toBe(true);
  }
});

test("flow 468 AC3: the injected session row sits right after `session default`, ahead of every provider row", () => {
  const options = flatModelOptions([{ name: "deepseek", models: ["deepseek-chat"] }], SESSION);
  expect(options.map((o) => o.label)).toEqual([
    "session default",
    "openai-codex/gpt-test (current session)",
    "deepseek (provider default)",
    "deepseek/deepseek-chat",
  ]);
});
