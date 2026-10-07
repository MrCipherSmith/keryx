// Flow 411 P1: production provider factory with hermetic HTTP transport.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRoutingClassifierForTurn } from "./routing-classifier-source";
import { writeProjectExternalSetting, writeUserExternalSetting } from "../lib/external-switch";
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
    await writeProjectExternalSetting(cwd, "off");
    const result = await run(["claude-sonnet-5"]);
    expect(calls).toEqual([]);
    expect(result?.classification.result.ok).toBe(false);
    expect(result?.routed).toBeUndefined();
    expect(result?.baseline?.modelId).toBe("claude-sonnet-5");
    expect(result?.fallbackReason).toContain("no available authorized sufficient classifier");
    expect((await run(["claude-sonnet-5"], () => true))?.classification.result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
}
test("P1: exclude blocked standard before ranking, reload switch and list", async () => {
  const { cwd, calls, run, setList } = fixture("model");
  writeUserExternalSetting("on", cwd);
  await writeProjectExternalSetting(cwd, "off");
  await run(["claude-sonnet-5", "claude-opus-4-8"]);
  expect(calls).toEqual(["claude-opus-4-8"]);
  await writeProjectExternalSetting(cwd, "on");
  await run(["claude-sonnet-5"]);
  expect(calls).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
  await run(["claude-sonnet-5"], () => false);
  expect(calls).toHaveLength(2);
  await writeProjectExternalSetting(cwd, "off");
  await run(["claude-sonnet-5"], () => true);
  expect(calls).toHaveLength(2);
  setList("provider");
  await run(["claude-opus-4-8"]);
  expect(calls).toHaveLength(2);
});
test("P1: user external off is enforced without a project override", async () => {
  const { cwd, calls, run } = fixture("provider");
  writeUserExternalSetting("off", cwd);
  await run(["claude-sonnet-5"], () => true);
  expect(calls).toEqual([]);
});
