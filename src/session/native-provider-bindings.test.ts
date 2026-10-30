import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Control } from "../remote-control/protocol";
import { createNativeProviderServices } from "./native-provider-bindings";
import { createNativeSessionServices } from "./native-services-production";
import { createJobRegistry } from "../harness/tool/builtin/background-job-registry";
import { executeTasksIntegration } from "./commands/tasks-integrations";

const roots: string[] = []; const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const candidate = (candidateId: string, providerId: string, modelId: string, available = true): Control["RoutingCandidate"] => ({ candidateId, providerId, modelId, reasoningEfforts: ["none"], available, reason: available ? "none" : "local-policy", privacyClass: "approved-egress", costClass: "metered" });
const bound = (providerId: string, modelId: string) => ({ providerId, modelId, actualProviderId: providerId, actualModelId: modelId });
const identity = { nativeSessionId: "10000000-0000-4000-8000-000000000001", projectId: "project-one", checkoutId: "checkout-one" };
const config = { configVersion: 1, baselineCandidateId: "local:custom", reasoningEffort: "none" as const, routing: { enabled: false, profileId: "local", candidateIds: ["local:custom"], fallbackCandidateId: "local:custom" }, policyDigest: "a".repeat(64), capabilityDigest: "b".repeat(64) };

async function fixture() {
  const configDir = await mkdtemp(path.join(tmpdir(), "native-provider-bindings-")); roots.push(configDir);
  let requests = 0; let authorization = "";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => { requests++; authorization = request.headers.get("authorization") ?? ""; return Response.json({ data: [{ id: "custom-model" }, { id: "second-model" }] }); } }); cleanup.push(() => server.stop(true));
  await writeFile(path.join(configDir, "llm-providers.json"), JSON.stringify({ schemaVersion: 1, providers: { custom: { name: "fixture-custom", label: "Fixture custom", baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "fixture-custom-secret", models: ["custom-model"] } } }));
  return { configDir, port: server.port, requests: () => requests, authorization: () => authorization };
}
function services(configDir: string, driver: ReturnType<typeof createNativeProviderServices>) {
  const jobs = createJobRegistry({ cwd: configDir });
  const created = createNativeSessionServices({ cwd: configDir, configDir, jobs, identity: () => identity, providers: driver,
    sessionState: () => ({ config, restriction: { enabled: false, configVersion: 1, effectiveFromTurnOrdinal: 1, restrictionDigest: "c".repeat(64) }, permissionMode: "ask", status: "idle" }), routingAvailability: () => ({ candidates: [] }) });
  cleanup.push(() => created.close()); return created;
}

test("only locally allowed candidates bind, through the shared registry and credential resolution; not-configured and not-implemented stay distinct", async () => {
  const f = await fixture();
  const driver = createNativeProviderServices({ configDir: f.configDir, env: {}, fetch: globalThis.fetch,
    candidates: [candidate("local:custom", "fixture-custom", "custom-model"), candidate("cloud:deepseek", "deepseek", "deepseek-chat"), candidate("vendor:anthropic", "anthropic", "claude"), candidate("denied:groq", "groq", "llama", false), candidate("unbound:openrouter", "openrouter", "x")],
    bindings: [bound("fixture-custom", "custom-model"), bound("deepseek", "deepseek-chat"), bound("anthropic", "claude"), bound("groq", "llama")] });
  expect(driver.bindings.map((row) => [row.candidateId, row.provider.name, row.provider.baseUrl])).toEqual([["local:custom", "fixture-custom", `http://127.0.0.1:${f.port}`]]);
  expect(driver.unavailable).toEqual([{ candidateId: "cloud:deepseek", label: "DeepSeek", state: "not-configured" }, { candidateId: "vendor:anthropic", label: "anthropic", state: "implementation-gap" }]);
  expect(driver.selectConfirmed).toBeUndefined();
  const created = services(f.configDir, driver); const providers = created.integrations.providers!;
  expect(providers.select).toBeUndefined();
  const listed = providers.list();
  expect(listed).toEqual([{ candidateId: "local:custom", label: "Fixture custom", state: "configured", selected: true }, { candidateId: "cloud:deepseek", label: "DeepSeek", state: "not-configured", selected: false }, { candidateId: "vendor:anthropic", label: "anthropic", state: "implementation-gap", selected: false }]);
  expect(JSON.stringify(listed)).not.toContain("fixture-custom-secret"); expect(JSON.stringify(listed)).not.toContain(String(f.port));
  expect(await providers.test("local:custom", new AbortController().signal)).toEqual({ source: "live", modelCount: 2 });
  expect(f.requests()).toBe(1); expect(f.authorization()).toBe("Bearer fixture-custom-secret");
  await expect(providers.test("cloud:deepseek", new AbortController().signal)).rejects.toMatchObject({ code: "setup-required" });
  await expect(providers.test("vendor:anthropic", new AbortController().signal)).rejects.toMatchObject({ code: "implementation-gap" });
  for (const id of ["denied:groq", "unbound:openrouter", "foreign"]) await expect(providers.test(id, new AbortController().signal)).rejects.toMatchObject({ code: "not-found" });
  expect(f.requests()).toBe(1);
});

test("a built-in provider redirected to a loopback endpoint is refused by the shared egress predicate before any request", async () => {
  const f = await fixture();
  const driver = createNativeProviderServices({ configDir: f.configDir, fetch: globalThis.fetch, env: { DEEPSEEK_API_KEY: "fixture-deepseek-secret", KERYX_DEEPSEEK_BASE_URL: `http://127.0.0.1:${f.port}` },
    candidates: [candidate("cloud:deepseek", "deepseek", "deepseek-chat")], bindings: [bound("deepseek", "deepseek-chat")] });
  expect(driver.bindings.map((row) => row.provider.baseUrl)).toEqual([`http://127.0.0.1:${f.port}`]);
  await expect(driver.beforeRequest("cloud:deepseek", new AbortController().signal)).rejects.toMatchObject({ code: "policy-denied" });
  const created = services(f.configDir, driver);
  await expect(created.integrations.providers!.test("cloud:deepseek", new AbortController().signal)).rejects.toMatchObject({ code: "policy-denied" });
  expect(f.requests()).toBe(0);
  const aborted = new AbortController(); aborted.abort();
  await expect(driver.beforeRequest("cloud:deepseek", aborted.signal)).rejects.toThrow();
});

test("the admitted command path keeps the owner's typed outcome and never reports a not-configured provider as a denial", async () => {
  const f = await fixture();
  const driver = createNativeProviderServices({ configDir: f.configDir, env: {}, fetch: globalThis.fetch, candidates: [candidate("local:custom", "fixture-custom", "custom-model"), candidate("cloud:deepseek", "deepseek", "deepseek-chat")], bindings: [bound("fixture-custom", "custom-model"), bound("deepseek", "deepseek-chat")] });
  const created = services(f.configDir, driver); let authorized = 0;
  const context = { cwd: f.configDir, jobs: createJobRegistry({ cwd: f.configDir }), sessionId: "s", policyDigest: "a".repeat(64), actorId: "human", integrations: created.integrations, execution: { runId: "run", turnId: "turn" }, signal: new AbortController().signal, authorize: async (action: string) => { expect(action).toBe("connect.test"); authorized++; } };
  expect(await executeTasksIntegration(context, "connect.test", { id: "local:custom" })).toEqual({ ok: true, data: { source: "live", modelCount: 2 } });
  expect(await executeTasksIntegration(context, "connect.test", { id: "cloud:deepseek" })).toMatchObject({ ok: false, error: { code: "setup-required" } });
  // Selection belongs to the host's session config transaction: refused here before any authorization or request.
  expect(await executeTasksIntegration(context, "connect.select", { id: "local:custom" })).toMatchObject({ ok: false, error: { code: "domain-refused" } });
  expect(authorized).toBe(2); expect(f.requests()).toBe(1);
});
