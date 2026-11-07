// The interactive turn's routing source. Hermetic: a temp dir holds the routing
// settings, the model profiles and the trust store; no provider is called.
// Every turn resolves through the one routing engine: there is no engine to
// fall back to, so an assignment that cannot be honoured blocks the turn with
// its reason rather than running on the baseline.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRoutingClassifierForTurn, renderRoutingSidebarValue, type RoutingClassifierTurnOptions } from "./routing-classifier-source";
import { approveProjectRouting, replaceRoutingLayer } from "../harness/routing/settings";
import { setModelProfileField } from "../harness/routing/model-profile";
import type { RoutingAssignment } from "../harness/routing/config";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-routing-classifier-source-"));
}

const ENV_WITH_KEY = { ANTHROPIC_API_KEY: "test-only" } as const;
const MODELS = ["claude-x", "claude-strong", "claude-user"];

/** Profiles that prove each model's context, so routing can verify a switch to it. */
async function profiled(dir: string): Promise<void> {
  for (const modelId of MODELS) {
    await setModelProfileField("anthropic", modelId, { field: "contextLength", value: 200_000 }, dir);
  }
}

function turn(cwd: string, overrides: Partial<RoutingClassifierTurnOptions> = {}): RoutingClassifierTurnOptions {
  return {
    enabled: true,
    jevEnabled: false,
    cwd,
    detected: [{ name: "anthropic", models: MODELS }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: ENV_WITH_KEY,
    userConfigDir: cwd,
    ...overrides,
  };
}

function model(modelId: string): RoutingAssignment {
  return { mode: "model", target: { providerId: "anthropic", modelId } };
}

test("runRoutingClassifierForTurn: disabled routing never classifies", async () => {
  const cwd = tmpDir();
  expect(await runRoutingClassifierForTurn("please review this PR", turn(cwd, { enabled: false }))).toBeUndefined();
});

test("renderRoutingSidebarValue: off/on text", () => {
  expect(renderRoutingSidebarValue(false, 0)).toBe("off");
  expect(renderRoutingSidebarValue(true, 3, "quick")).toBe("on · 3 routed (last: quick)");
  expect(renderRoutingSidebarValue(true, 0)).toBe("on · 0 routed");
});

test("an unconfigured operator runs the turn on the session model — routing is on by default, with no activation step", async () => {
  const cwd = tmpDir();
  const result = await runRoutingClassifierForTurn("hello there", turn(cwd));
  expect(result?.blockTurn).not.toBe(true);
  expect(result?.routed ?? { providerId: "anthropic", modelId: "claude-x" }).toEqual({ providerId: "anthropic", modelId: "claude-x" });
});

test("a user-layer assignment routes the turn to the configured model", async () => {
  const cwd = tmpDir();
  await profiled(cwd);
  await replaceRoutingLayer("user", { cwd, configDir: cwd }, { schemaVersion: 2, categories: { default: model("claude-strong") } });
  const result = await runRoutingClassifierForTurn("please look at this", turn(cwd));
  expect(result?.blockTurn).not.toBe(true);
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-strong" });
  expect(result?.routingExecution).toBeDefined();
});

test("an unapproved project assignment is ignored; once approved it wins over the user layer", async () => {
  const cwd = tmpDir();
  await profiled(cwd);
  await replaceRoutingLayer("user", { cwd, configDir: cwd }, { schemaVersion: 2, categories: { default: model("claude-user") } });
  await replaceRoutingLayer("project", { cwd, configDir: cwd }, { schemaVersion: 2, categories: { default: model("claude-strong") } });

  const unapproved = await runRoutingClassifierForTurn("please look at this", turn(cwd));
  expect(unapproved?.routed).toEqual({ providerId: "anthropic", modelId: "claude-user" });

  expect(approveProjectRouting({ cwd, configDir: cwd }).ok).toBe(true);
  const approved = await runRoutingClassifierForTurn("please look at this", turn(cwd));
  expect(approved?.routed).toEqual({ providerId: "anthropic", modelId: "claude-strong" });
});

test("an assignment that cannot be verified blocks the turn with its reason, never reverting to the baseline", async () => {
  const cwd = tmpDir();
  // No profile for claude-strong: its availability and context are unproven.
  await replaceRoutingLayer("user", { cwd, configDir: cwd }, { schemaVersion: 2, categories: { default: model("claude-strong") } });
  const result = await runRoutingClassifierForTurn("please look at this", turn(cwd));
  expect(result?.blockTurn).toBe(true);
  expect(result?.routed).toBeUndefined();
  expect(result?.fallbackReason).toMatch(/candidate-unverified|context-insufficient/);
});

test("an executor the caller's policy denies blocks the turn rather than falling through to another layer", async () => {
  const cwd = tmpDir();
  await profiled(cwd);
  await replaceRoutingLayer("user", { cwd, configDir: cwd }, { schemaVersion: 2, categories: { default: model("claude-strong") } });
  const result = await runRoutingClassifierForTurn("please look at this", turn(cwd, {
    executorAllowed: (_providerId, modelId) => modelId !== "claude-strong",
  }));
  expect(result?.blockTurn).toBe(true);
  expect(result?.routed).toBeUndefined();
  expect(result?.fallbackReason).toContain("policy-denied");
});

test("malformed routing settings block the turn with the reason, never routing on the baseline", async () => {
  const cwd = tmpDir();
  writeFileSync(path.join(cwd, "auth.json"), JSON.stringify({ modelRouting: { schemaVersion: 2, categories: { default: { mode: "sideways" } } } }));
  const result = await runRoutingClassifierForTurn("please look at this", turn(cwd));
  expect(result?.blockTurn).toBe(true);
  expect(result?.fallbackReason).toContain("routing configuration is invalid");
  expect(result?.fallbackReason).toContain("categories.default.mode is invalid");
});

test("a legacy category table keeps routing the turn without any migration step", async () => {
  const cwd = tmpDir();
  await profiled(cwd);
  writeFileSync(path.join(cwd, "auth.json"), JSON.stringify({
    apiKeys: { ANTHROPIC_API_KEY: "test-only" },
    routing: { default: { kind: "model", providerId: "anthropic", modelId: "claude-strong" } },
  }));
  const result = await runRoutingClassifierForTurn("please look at this", turn(cwd));
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-strong" });
});
