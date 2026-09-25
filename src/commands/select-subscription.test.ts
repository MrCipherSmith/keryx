import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOAuthGrant } from "../lib/oauth/grants";
import { pickProviderModel } from "./select";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function root(): string { const dir = mkdtempSync(join(tmpdir(), "keryx-readline-subscription-")); roots.push(dir); return dir; }
function io() {
  const output: string[] = [];
  return { output, write: (text: string) => { output.push(text); }, lines: (async function* () { yield "1"; yield "1"; })() };
}
const detected = [{ name: "openai-codex", models: ["curated-guess"] }];

test("readline selection completes device login before requesting authorized models", async () => {
  const dir = root(); const shell = io(); const urls: string[] = []; const opened: string[] = [];
  const access = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } })).toString("base64url")}.s`;
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); urls.push(url);
    if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "device", user_code: "CODE-123", interval: 1 });
    if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: access, expires_in: 3600 });
    return Response.json({ models: [{ slug: "authorized-model", visibility: "list" }] });
  }) as typeof globalThis.fetch;
  const result = await pickProviderModel(shell, detected, { fetch, env: {}, configDir: dir, openVerificationUrl: (url) => { opened.push(url); } });
  expect(result).toEqual({ provider: "openai-codex", model: "authorized-model" });
  expect(loadOAuthGrant("openai-codex", dir)?.access).toBe(access);
  expect(urls[0]).toEndWith("/deviceauth/usercode");
  expect(opened).toEqual(["https://auth.openai.com/codex/device"]);
  expect(shell.output.join("")).toContain("CODE-123");
  expect(shell.output.join("")).toContain("Ctrl+C");
});

test("readline cancelled subscription login never silently selects a guessed model", async () => {
  const dir = root(); const shell = io(); const abort = new AbortController();
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("abort")), { once: true });
      setTimeout(() => abort.abort(), 5);
    });
  }) as typeof globalThis.fetch;
  await expect(pickProviderModel(shell, detected, { fetch, env: {}, configDir: dir, signal: abort.signal, openVerificationUrl: () => {} })).rejects.toThrow("cancel");
  expect(loadOAuthGrant("openai-codex", dir)).toBeUndefined();
});
