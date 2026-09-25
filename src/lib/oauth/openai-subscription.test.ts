import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyProviderConnection, disconnectProvider } from "../../commands/providers";
import { loadShellConfig, saveApiKey } from "../shell-config";
import { authCatalogEntry } from "./catalog";
import { envWithOAuthAccess, loadOAuthGrant, saveOAuthGrant, type OAuthGrant } from "./grants";
import { refreshSavedGrants } from "./login";

const NOW = Date.parse("2026-09-25T21:00:00Z");
const roots: string[] = [];
function configRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-subscription-"));
  roots.push(root);
  return root;
}
function grant(overrides: Partial<OAuthGrant> = {}): OAuthGrant {
  return { method: "device-code", access: "subscription-access", refresh: "subscription-refresh", expires: NOW - 1000, obtainedAt: new Date(NOW - 3600000).toISOString(), ...overrides };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("AC1: OpenAI API and subscription advertise separate authentication methods", () => {
  expect(authCatalogEntry("openai")?.methods).toEqual(["api-key"]);
  expect(authCatalogEntry("openai-codex")?.methods).toContain("device-code");
  expect(authCatalogEntry("openai-codex")?.methods).not.toContain("api-key");
});

test("AC4: legacy OpenAI OAuth is readable as subscription without becoming an API key", () => {
  const root = configRoot();
  saveOAuthGrant("openai", grant(), root);
  saveApiKey("OPENAI_API_KEY", "platform-key", root);
  expect(loadOAuthGrant("openai-codex", root)?.access).toBe("subscription-access");
  expect(envWithOAuthAccess({}, root).OPENAI_API_KEY).toBeUndefined();
  expect(envWithOAuthAccess({ OPENAI_API_KEY: "platform-key" }, root).OPENAI_API_KEY).toBe("platform-key");
  expect(loadShellConfig(root).apiKeys?.OPENAI_API_KEY).toBe("platform-key");
});

test("AC4: session refresh rotates expired subscription credentials at OpenAI's token endpoint", async () => {
  const root = configRoot();
  saveOAuthGrant("openai-codex", grant(), root);
  const urls: string[] = [];
  const warnings = await refreshSavedGrants({ now: () => NOW, fetch: async (url, init) => {
    urls.push(String(url));
    expect(String(init?.body)).toContain("subscription-refresh");
    return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  } }, root);
  expect(warnings).toEqual([]);
  expect(urls).toEqual(["https://auth.openai.com/oauth/token"]);
  expect(loadOAuthGrant("openai-codex", root)).toMatchObject({ access: "rotated-access", refresh: "rotated-refresh", expires: NOW + 3600000 });
});

test("AC4: failed subscription refresh tells the user to log in without exposing credentials", async () => {
  const root = configRoot();
  saveOAuthGrant("openai-codex", grant(), root);
  const warnings = await refreshSavedGrants({ now: () => NOW, fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) }, root);
  expect(warnings).toHaveLength(1);
  expect(warnings.join()).toContain("keryx auth login openai-codex");
  expect(warnings.join()).not.toContain("subscription-access");
  expect(warnings.join()).not.toContain("subscription-refresh");
  expect(loadOAuthGrant("openai-codex", root)?.access).toBe("subscription-access");
});

test("AC5: disconnecting API auth preserves the legacy subscription and disconnecting subscription preserves API auth", () => {
  const root = configRoot();
  saveApiKey("OPENAI_API_KEY", "platform-key", root);
  saveOAuthGrant("openai", grant(), root);
  expect(classifyProviderConnection("openai", {}, root).kind).toBe("saved-api-key");
  expect(classifyProviderConnection("openai-codex", {}, root).kind).toBe("oauth-grant");
  expect(disconnectProvider("openai", {}, root).kind).toBe("saved-api-key");
  expect(loadShellConfig(root).apiKeys?.OPENAI_API_KEY).toBeUndefined();
  expect(loadOAuthGrant("openai-codex", root)?.access).toBe("subscription-access");
  saveApiKey("OPENAI_API_KEY", "replacement-platform-key", root);
  expect(disconnectProvider("openai-codex", {}, root).kind).toBe("oauth-grant");
  expect(loadOAuthGrant("openai-codex", root)).toBeUndefined();
  expect(loadOAuthGrant("openai", root)).toBeUndefined();
  expect(loadShellConfig(root).apiKeys?.OPENAI_API_KEY).toBe("replacement-platform-key");
});
