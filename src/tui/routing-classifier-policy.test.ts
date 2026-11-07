// Flow 411 P1: production provider factory with hermetic HTTP transport.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRoutingClassifierForTurn } from "./routing-classifier-source";
import { writeProjectExternalSetting, writeUserExternalSetting } from "../lib/external-switch";
import { replaceRoutingLayer } from "../harness/routing/settings";
import { setModelProfileField } from "../harness/routing/model-profile";

/**
 * Explicit auto routing: every turn is classified by the configured model
 * classifier target (the default assignment now never classifies on its own).
 * Both models carry a proven context length.
 */
async function classifyWith(cwd: string, modelId: string): Promise<void> {
  for (const id of ["claude-sonnet-5", "claude-opus-4-8"]) await setModelProfileField("anthropic", id, { field: "contextLength", value: 200_000 }, cwd);
  await replaceRoutingLayer("user", { cwd, configDir: cwd }, { schemaVersion: 2,
    categories: { default: { mode: "auto" } },
    classifier: { chain: [{ adapterId: "model", target: { providerId: "anthropic", modelId } }], timeoutMs: 2500, minConfidence: 0.7, onFailure: { mode: "baseline" } } });
}
function fixture(block: "provider" | "model") {
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-classifier-policy-"));
  const setList = (kind: "provider" | "model") => writeFileSync(path.join(cwd, "external-providers.json"), JSON.stringify({
    version: 1, providers: kind === "provider" ? [{ id: "anthropic", reason: "private fixture" }] : [],
    modelPatterns: kind === "model" ? [{ pattern: "claude-sonnet-*", reason: "private fixture" }] : [], notes: "fixture",
  }));
  setList(block);
  const calls: string[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    calls.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return new Response("fixture refusal", { status: 503 });
  }) as typeof fetch;
  const run = (models: string[], classifierAllowed?: (provider: string, model: string) => boolean) =>
    runRoutingClassifierForTurn("implement a retry loop", {
      enabled: true, jevEnabled: false, cwd, userConfigDir: cwd,
      env: { ANTHROPIC_API_KEY: "fixture-not-a-real-key" },
      detected: [{ name: "anthropic", models }],
      sessionProvider: "anthropic", sessionModel: "claude-sonnet-5", fetch: fetchFn,
      ...(classifierAllowed === undefined ? {} : { classifierAllowed }),
    });
  return { cwd, calls, run, setList };
}
for (const block of ["provider", "model"] as const) {
  test(`P1: external off blocks credentialed ${block} without caller hook`, async () => {
    const { cwd, calls, run } = fixture(block);
    await classifyWith(cwd, "claude-sonnet-5");
    await writeProjectExternalSetting(cwd, "off");
    const result = await run(["claude-sonnet-5"]);
    expect(calls).toEqual([]);
    expect(result?.classification.result.ok).toBe(false);
    expect(result?.routed).toBeUndefined();
    expect(result?.baseline?.modelId).toBe("claude-sonnet-5");
    expect(result?.fallbackReason).toBeDefined();
    // A caller hook that allows everything cannot widen the external policy.
    expect((await run(["claude-sonnet-5"], () => true))?.classification.result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
}
test("P1: a blocked classifier target makes no call; switch and list changes are re-read every turn", async () => {
  const { cwd, calls, run, setList } = fixture("model");
  writeUserExternalSetting("on", cwd);
  await writeProjectExternalSetting(cwd, "off");
  // Positive control: an unblocked target is really called over HTTP.
  await classifyWith(cwd, "claude-opus-4-8");
  await run(["claude-sonnet-5", "claude-opus-4-8"]);
  expect(calls).toEqual(["claude-opus-4-8"]);
  // The blocked standard model is never called while the project switch is off.
  await classifyWith(cwd, "claude-sonnet-5");
  await run(["claude-sonnet-5", "claude-opus-4-8"]);
  expect(calls).toEqual(["claude-opus-4-8"]);
  // Switch reload: turning the project switch on makes it callable.
  await writeProjectExternalSetting(cwd, "on");
  await run(["claude-sonnet-5"]);
  expect(calls).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
  // The caller hook can only restrict.
  await run(["claude-sonnet-5"], () => false);
  expect(calls).toHaveLength(2);
  await writeProjectExternalSetting(cwd, "off");
  await run(["claude-sonnet-5"], () => true);
  expect(calls).toHaveLength(2);
  // List reload: blocking the whole provider stops the previously callable target.
  setList("provider");
  await classifyWith(cwd, "claude-opus-4-8");
  await run(["claude-opus-4-8"]);
  expect(calls).toHaveLength(2);
});
test("P1: user external off is enforced without a project override", async () => {
  const { cwd, calls, run } = fixture("provider");
  await classifyWith(cwd, "claude-sonnet-5");
  writeUserExternalSetting("off", cwd);
  await run(["claude-sonnet-5"], () => true);
  expect(calls).toEqual([]);
});
