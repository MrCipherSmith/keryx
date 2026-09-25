import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveOAuthGrant } from "../lib/oauth/grants";
import { refreshProviderCatalogFromDetected } from "../harness/provider-catalog";
import { filterConnectedDetectedProviders } from "../tui/tui-shell";
import { configuredProviders, connectionProviderByName, resolveModelsForPicker, testProviderConnection } from "./providers";

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), "keryx-models-subscription-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const subscription = { name: "openai-codex", label: "ChatGPT / Codex", models: ["gpt-5.3-codex"] };
const api = { name: "openai", label: "OpenAI API", models: ["gpt-4o"], envKey: "OPENAI_API_KEY" };
function login(dir: string): void {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } })).toString("base64url");
  saveOAuthGrant("openai-codex", { method: "device-code", access: `header.${payload}.signature`, refresh: "refresh-test", expires: Date.now() + 3600000, obtainedAt: new Date().toISOString() }, dir);
}
function liveFetch(urls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    const headers = new Headers(init?.headers);
    if (url.startsWith("https://chatgpt.com/backend-api/codex/models?client_version=")) {
      expect(headers.get("ChatGPT-Account-ID")).toBe("account-test");
      expect(headers.get("Authorization")).toStartWith("Bearer header.");
      return Response.json({ models: [{ slug: "subscription-live", visibility: "list" }, { slug: "hidden", visibility: "hide" }] });
    }
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(headers.get("Authorization")).toBe("Bearer platform-key");
    return Response.json({ data: [{ id: "platform-live" }] });
  }) as typeof fetch;
}

test("subscription picker resolves live authorized models independently of API key", async () => {
  const dir = root(); login(dir); const urls: string[] = [];
  const result = await resolveModelsForPicker(liveFetch(urls), subscription, { OPENAI_API_KEY: "platform-key" }, { configDir: dir });
  expect(result).toEqual({ source: "live", models: ["subscription-live"] });
  expect(urls).toHaveLength(1);
});

test("catalog offers neither OpenAI identity as connected without its own credential", async () => {
  const dir = root(); const urls: string[] = [];
  const catalog = await refreshProviderCatalogFromDetected([api, subscription], { fetch: liveFetch(urls), env: {}, dir });
  expect(catalog.providers).toEqual({}); expect(urls).toEqual([]);
});

test("catalog and connect show subscription live models without a Platform API key", async () => {
  const dir = root(); login(dir); const urls: string[] = [];
  const fetch = liveFetch(urls);
  const catalog = await refreshProviderCatalogFromDetected([api, subscription], { fetch, env: {}, dir });
  expect(Object.keys(catalog.providers)).toEqual(["openai-codex"]);
  expect(catalog.providers["openai-codex"]?.models).toEqual(["subscription-live"]);
  const connected = await filterConnectedDetectedProviders([api, subscription], { fetch, env: {}, configDir: dir });
  expect(connected.map((p) => p.name)).toEqual(["openai-codex"]);
  expect(connected[0]?.models).toEqual(["subscription-live"]);
});

test("API key alone never marks subscription as connected", async () => {
  const dir = root(); const urls: string[] = [];
  const connected = await filterConnectedDetectedProviders([api, subscription], { fetch: liveFetch(urls), env: { OPENAI_API_KEY: "platform-key" }, configDir: dir });
  expect(connected.map((p) => p.name)).toEqual(["openai"]);
  expect(connected[0]?.models).toEqual(["platform-live"]);
  expect(urls).toEqual(["https://api.openai.com/v1/models"]);
});


test("subscription connection test uses its native model endpoint and configured listing preserves its identity", async () => {
  const dir = root(); login(dir); const urls: string[] = [];
  const provider = connectionProviderByName("openai-codex", dir);
  expect(provider).toBeDefined();
  expect(provider?.envKey).toBeUndefined();
  const result = await testProviderConnection(provider!, liveFetch(urls), {}, { dir });
  expect(result.models).toEqual(["subscription-live"]);
  expect(configuredProviders({}, dir).some((entry) => entry.name === "openai-codex")).toBe(true);
});

test("subscription rejects API-only auth without a network request", async () => {
  const dir = root(); const urls: string[] = [];
  const result = await resolveModelsForPicker(liveFetch(urls), subscription, { OPENAI_API_KEY: "platform-key" }, { configDir: dir });
  expect(result.failure?.kind).toBe("rejected");
  expect(urls).toEqual([]);
});

test("subscription models reject server auth errors without echoing response secrets", async () => {
  const dir = root(); login(dir);
  const fetch = (async () => Response.json({ error: "token=secret-response-value" }, { status: 401 })) as unknown as typeof globalThis.fetch;
  const result = await resolveModelsForPicker(fetch, subscription, {}, { configDir: dir });
  expect(result.failure).toEqual({ kind: "rejected", status: 401 });
  expect(JSON.stringify(result)).not.toContain("secret-response-value");
});
