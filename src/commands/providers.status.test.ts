// Flow 309 (AC7) — `keryx providers status [--json] [--refresh]`. No real
// network anywhere: every provider here is connected only because the test
// injects both `env` (the credential) and `fetch` (the live probe).

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { providersCommand } from "./providers";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-providers-status-cli-"));
}

async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = orig;
  }
}

const fetchOk = (async (url: string) => {
  if (url.includes("/api/tags")) return { ok: false } as Response;
  if (url.includes("/user/balance")) {
    return { ok: true, json: async () => ({ balance_infos: [{ currency: "USD", total_balance: "6.19" }] }) } as Response;
  }
  return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) } as Response;
}) as unknown as typeof fetch;

test("keryx providers status --json: reports a connected provider's status, model count, balance and fetchedAt", async () => {
  const dir = tempDir();
  const { logs } = await withCapturedLogs(async () => {
    await providersCommand(["status", "--json"], { fetch: fetchOk, env: { DEEPSEEK_API_KEY: "sk-test" }, dir });
  });
  const parsed = JSON.parse(logs.join("\n")) as { fetchedAt: string; providers: Array<{ name: string; status: string; models: string[]; balance?: { total: number } }> };
  expect(Number.isFinite(Date.parse(parsed.fetchedAt))).toBe(true);
  const deepseek = parsed.providers.find((p) => p.name === "deepseek");
  expect(deepseek?.status).toBe("ok");
  expect(deepseek?.models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  expect(deepseek?.balance?.total).toBe(6.19);
  // An unconnected provider (no key anywhere in `env`) never appears.
  expect(parsed.providers.some((p) => p.name === "openrouter")).toBe(false);
});

test("keryx providers status (human): names the provider, status, model count and age", async () => {
  const dir = tempDir();
  const { logs } = await withCapturedLogs(async () => {
    await providersCommand(["status"], { fetch: fetchOk, env: { DEEPSEEK_API_KEY: "sk-test" }, dir });
  });
  const text = logs.join("\n");
  expect(text).toContain("deepseek");
  expect(text).toContain("ok");
  expect(text).toContain("2 model(s)");
  expect(text).toContain("fetched");
});

test("keryx providers status: with no credential configured, nothing shows — the synthetic fake provider is excluded and never a guessed real one", async () => {
  const dir = tempDir();
  const { logs } = await withCapturedLogs(async () => {
    await providersCommand(["status"], { fetch: fetchOk, env: {}, dir });
  });
  const text = logs.join("\n");
  expect(text).toContain("none — no provider is connected");
  expect(text).not.toContain("fake");
  expect(text).not.toContain("deepseek");
});

test("keryx providers status --refresh: bypasses a fresh cache and re-probes", async () => {
  const dir = tempDir();
  let calls = 0;
  const countingFetch = (async (url: string, init?: RequestInit) => {
    if (!url.includes("/api/tags")) calls += 1;
    return fetchOk(url, init);
  }) as unknown as typeof fetch;

  await providersCommand(["status", "--json"], { fetch: countingFetch, env: { DEEPSEEK_API_KEY: "sk-test" }, dir });
  const afterFirst = calls;
  expect(afterFirst).toBeGreaterThan(0);

  // Without --refresh, the just-written FRESH cache answers with no new call.
  await providersCommand(["status", "--json"], { fetch: countingFetch, env: { DEEPSEEK_API_KEY: "sk-test" }, dir });
  expect(calls).toBe(afterFirst);

  // --refresh forces a new probe.
  await providersCommand(["status", "--json", "--refresh"], { fetch: countingFetch, env: { DEEPSEEK_API_KEY: "sk-test" }, dir });
  expect(calls).toBeGreaterThan(afterFirst);
});

test("keryx providers test also updates the SAME catalog cache `providers status` reads (AC3)", async () => {
  const dir = tempDir();
  await providersCommand(["test", "deepseek", "--json"], { fetch: fetchOk, env: { DEEPSEEK_API_KEY: "sk-test" }, dir });

  const { logs } = await withCapturedLogs(async () => {
    // No key in `env` this time — proves the STATUS command is reading the
    // cache `test` just wrote, not re-deriving connectedness from `env`.
    await providersCommand(["status", "--json"], { fetch: fetchOk, env: {}, dir });
  });
  const parsed = JSON.parse(logs.join("\n")) as { providers: Array<{ name: string; status: string }> };
  expect(parsed.providers.find((p) => p.name === "deepseek")?.status).toBe("ok");
});
