import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveOAuthGrant, loadOAuthGrant } from "./grants";
import { ensureOpenAiCodexGrant } from "./openai-subscription";
import { loginDeviceCode, logoutProvider } from "./login";
import { pollCodexDeviceToken } from "./openai-codex";
const roots: string[] = [];
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const now = 1900000000000;
function setup() { const dir = mkdtempSync(join(tmpdir(), "codex-oauth-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0))
  rmSync(dir, { recursive: true, force: true }); });
test("legacy JWT supplies account and expiry without network", async () => {
  const configDir = setup();
  const access = jwt({ exp: now / 1000 + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct" } });
  saveOAuthGrant("openai", { method: "device-code", access, obtainedAt: new Date(now).toISOString() }, configDir);
  const g = await ensureOpenAiCodexGrant({ configDir, now: () => now, fetch: async () => { throw new Error("network unexpected"); } });
  expect(g.accountId).toBe("acct");
  expect(g.access).toBe(access);
});
test("concurrent refresh rotates once and preserves omitted metadata", async () => {
  const configDir = setup();
  saveOAuthGrant("openai-codex", { method: "device-code", access: "old", refresh: "refresh-secret", accountId: "acct", expires: now - 1, obtainedAt: "2026-01-01T00:00:00.000Z" }, configDir);
  let calls = 0;
  const input = { configDir, now: () => now, fetch: async () => { calls++; await Promise.resolve(); return Response.json({ access_token: jwt({ exp: now / 1000 + 3600 }) }); } };
  const [a, b] = await Promise.all([ensureOpenAiCodexGrant(input), ensureOpenAiCodexGrant(input)]);
  expect(calls).toBe(1);
  expect(a).toEqual(b);
  expect(a.refresh).toBe("refresh-secret");
  expect(a.accountId).toBe("acct");
  expect(a.obtainedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(a.expires).toBe(now + 3600000);
});
test("subscription logout removes canonical and legacy grants", () => { const dir = setup(); for (const id of ["openai", "openai-codex"])
  saveOAuthGrant(id, { method: "device-code", access: "x", obtainedAt: "today" }, dir); logoutProvider("openai-codex", dir); expect(loadOAuthGrant("openai-codex", dir)).toBeUndefined(); expect(loadOAuthGrant("openai", dir)).toBeUndefined(); });
test("missing account fails safely without revealing opaque credentials", async () => { const configDir = setup(); saveOAuthGrant("openai-codex", { method: "device-code", access: "private-access", expires: now + 3600000, obtainedAt: "today" }, configDir); await expect(ensureOpenAiCodexGrant({ configDir, now: () => now, fetch: async () => Response.json({}) })).rejects.toThrow("keryx auth login openai-codex"); });
test("device login saves id-token identity and access-token expiry", async () => {
  const dir = setup();
  const result = await loginDeviceCode({ provider: "openai-codex", dir, now: () => now, onChallenge: () => { }, fetch: async (url) => {
      if (url.endsWith("/usercode"))
        return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: 1 });
      if (url.endsWith("/deviceauth/token"))
        return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      return Response.json({ access_token: jwt({ exp: now / 1000 + 3600 }), id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "id-account" } }), refresh_token: "rotate" });
    } });
  expect(result.ok).toBe(true);
  expect(loadOAuthGrant("openai-codex", dir)).toMatchObject({ accountId: "id-account", expires: now + 3600000 });
  expect(loadOAuthGrant("openai", dir)).toBeUndefined();
});
test("abort interrupts device polling sleep without waiting for interval", async () => {
  const controller = new AbortController();
  const pending = pollCodexDeviceToken({ deviceAuthId: "d", userCode: "C", verificationUri: "https://auth.openai.com/codex/device", intervalMs: 10000 }, { signal: controller.signal, fetch: async () => new Response(null, { status: 403 }), sleep: () => { controller.abort(); return new Promise(() => { }); } });
  await expect(pending).rejects.toThrow("cancelled");
});
test("refresh transport errors never echo credential-bearing messages", async () => {
  const configDir = setup();
  saveOAuthGrant("openai-codex", { method: "device-code", access: "access-secret", refresh: "refresh-secret", expires: now - 1, obtainedAt: "today" }, configDir);
  try {
    await ensureOpenAiCodexGrant({ configDir, now: () => now, fetch: async () => { throw new Error("ChatGPT subscription: access-secret refresh-secret"); } });
    throw new Error("expected failure");
  }
  catch (error) {
    expect(String(error)).toContain("token refresh failed");
    expect(String(error)).not.toContain("access-secret");
    expect(String(error)).not.toContain("refresh-secret");
  }
});
test("logout during refresh cannot resurrect credentials", async () => {
  const configDir = setup();
  saveOAuthGrant("openai-codex", { method: "device-code", access: "old", refresh: "refresh", accountId: "acct", expires: now - 1, obtainedAt: "today" }, configDir);
  await expect(ensureOpenAiCodexGrant({ configDir, now: () => now, fetch: async () => { logoutProvider("openai-codex", configDir); return Response.json({ access_token: "new", expires_in: 3600 }); } })).rejects.toThrow("login changed");
  expect(loadOAuthGrant("openai-codex", configDir)).toBeUndefined();
});
test("two Shell processes refresh one rotated token only once", async () => {
  const configDir = setup();
  const countFile = join(configDir, "refresh-count");
  saveOAuthGrant("openai-codex", { method: "device-code", access: "old", refresh: "single-use", accountId: "acct", expires: now - 1, obtainedAt: "today" }, configDir);
  const modulePath = new URL("./openai-subscription.ts", import.meta.url).pathname;
  const script = `import { ensureOpenAiCodexGrant } from ${JSON.stringify(modulePath)};
import {appendFileSync} from "node:fs";
const grant=await ensureOpenAiCodexGrant({configDir:${JSON.stringify(configDir)},now:()=>${now},fetch:async()=>{appendFileSync(${JSON.stringify(countFile)},"called\\n");await Bun.sleep(150);return Response.json({access_token:"rotated",refresh_token:"next",expires_in:3600});}});
console.log(grant.access);`;
  const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async (child) => ({ exit: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
  expect(results).toEqual([{ exit: 0, stdout: "rotated\n", stderr: "" }, { exit: 0, stdout: "rotated\n", stderr: "" }]);
  expect(readFileSync(countFile, "utf8").split("called").length - 1).toBe(1);
});

test("cancelled default device wait does not keep the CLI process alive", async () => {
  const modulePath = new URL("./openai-codex.ts", import.meta.url).pathname;
  const script = `import {pollCodexDeviceToken} from ${JSON.stringify(modulePath)};
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    try { await pollCodexDeviceToken({deviceAuthId:"d",userCode:"C",verificationUri:"https://auth.openai.com/codex/device",intervalMs:2000},{signal:controller.signal,fetch:async()=>new Response(null,{status:403})}); }
    catch { console.log("cancelled"); }`;
  const started = Date.now();
  const child = Bun.spawn([process.execPath,"--eval",script],{stdout:"pipe",stderr:"pipe"});
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("cancelled\n");
  expect(Date.now()-started).toBeLessThan(1500);
});
