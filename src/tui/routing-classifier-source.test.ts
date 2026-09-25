// Flow 338, AC6/AC8. Hermetic: fake `fetch` for Jev, a temp dir for the
// routing config layers, no real network.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRoutingClassifierForTurn, renderRoutingTagLine, renderRoutingSidebarValue, renderRoutingUsageLine } from "./routing-classifier-source";
import { saveRoutingConfig } from "../harness/routing/config";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-routing-classifier-source-"));
}

const ENV_WITH_KEY = { OPENROUTER_API_KEY: "sk-or-test" } as const;

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

test("runRoutingClassifierForTurn: disabled routing never classifies", async () => {
  const cwd = tmpDir();
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: false,
    jevEnabled: true,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-x"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: ENV_WITH_KEY,
    userConfigDir: cwd,
  });
  expect(result).toBeUndefined();
});

test("runRoutingClassifierForTurn: a deterministic 'review' shortcut resolves through the routing table to the configured model", async () => {
  const cwd = tmpDir();
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "model", providerId: "anthropic", modelId: "claude-strong" } });
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true,
    jevEnabled: false,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-x", "claude-strong"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: {},
    userConfigDir: cwd,
  });
  expect(result?.category).toBe("review");
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-strong" });
  const tag = result !== undefined ? renderRoutingTagLine(result) : undefined;
  expect(tag).toBe("[review -> anthropic/claude-strong] (deterministic 100%)");
});

test("runRoutingClassifierForTurn: no table entry resolves to session-default — nothing routed", async () => {
  const cwd = tmpDir();
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true,
    jevEnabled: false,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-x"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: {},
    userConfigDir: cwd,
  });
  expect(result?.category).toBe("review");
  expect(result?.routed).toBeUndefined();
  expect(result !== undefined ? renderRoutingTagLine(result) : undefined).toBeUndefined();
});

test("runRoutingClassifierForTurn: Jev enabled and credentialed drives the resolution", async () => {
  const cwd = tmpDir();
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { coding: { kind: "model", providerId: "anthropic", modelId: "claude-code" } });
  const fetchFn = fakeFetch({
    answers: { category: { type: "choice", choice: "coding" }, confidence: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 40, output_tokens: 0, cost: 0.0012 },
  });
  const result = await runRoutingClassifierForTurn("add a retry loop to the fetch call in providers.ts", {
    enabled: true,
    jevEnabled: true,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-x", "claude-code"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: ENV_WITH_KEY,
    userConfigDir: cwd,
    fetch: fetchFn,
  });
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-code" });
  const usage = result?.classification.result.ok ? result.classification.result.usage : undefined;
  expect(renderRoutingUsageLine(usage)).toBe("usage: ↑40 ↓0 $0.0012");
});

test("renderRoutingSidebarValue: off/on text", () => {
  expect(renderRoutingSidebarValue(false, 0)).toBe("off");
  expect(renderRoutingSidebarValue(true, 3, "quick")).toBe("on · 3 routed (last: quick)");
  expect(renderRoutingSidebarValue(true, 0)).toBe("on · 0 routed");
});
