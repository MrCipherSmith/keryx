import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_VERSION_CACHE_TTL_MS, CODEX_VERSION_REGISTRY_URL, resolveCodexCatalogVersion } from "./codex-catalog-version";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "keryx-codex-version-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function metadata(version: string): Response { return Response.json({ name: "@openai/codex", version }); }
function mockFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return fn as typeof fetch;
}

test("discovers a stable Codex version without credentials and reuses its persistent daily cache", async () => {
  const dir = root(); let calls = 0; const timestamp = 1_000_000;
  const fetch = mockFetch(async (input, init) => {
    calls++;
    expect(String(input)).toBe(CODEX_VERSION_REGISTRY_URL);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("ChatGPT-Account-ID")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    return metadata("0.200.0");
  });
  expect(await resolveCodexCatalogVersion(fetch, { configDir: dir, now: () => timestamp })).toBe("0.200.0");
  expect(await resolveCodexCatalogVersion(fetch, { configDir: dir, now: () => timestamp + CODEX_VERSION_CACHE_TTL_MS - 1 })).toBe("0.200.0");
  expect(calls).toBe(1);
  const file = join(dir, "codex-catalog-version.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: "0.200.0", fetchedAt: timestamp });
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("refreshes after expiry, keeps a discovered version during an outage, and retries on recovery", async () => {
  const dir = root(); let timestamp = 1_000_000;
  const options = { configDir: dir, now: () => timestamp };
  expect(await resolveCodexCatalogVersion(mockFetch(async () => metadata("0.159.2")), options)).toBe("0.159.2");
  timestamp += CODEX_VERSION_CACHE_TTL_MS;
  expect(await resolveCodexCatalogVersion(mockFetch(async () => { throw new Error("network failed"); }), options)).toBe("0.159.2");
  expect(await resolveCodexCatalogVersion(mockFetch(async () => metadata("0.200.0")), options)).toBe("0.200.0");
});

test.each([
  { name: "other-package", version: "0.200.0" },
  { name: "@openai/codex", version: "latest" },
  { name: "@openai/codex", version: "0.200.0-beta.1" },
  { name: "@openai/codex", version: "0.200.0&injected=value" },
  { name: "@openai/codex", version: "01.200.0" },
  { name: "@openai/codex", version: 123 },
])("rejects invalid registry metadata %j without inventing a version", async (body) => {
  const dir = root();
  expect(await resolveCodexCatalogVersion(mockFetch(async () => Response.json(body)), { configDir: dir })).toBeUndefined();
});

test("rejects oversized or invalid JSON responses and HTTP failures", async () => {
  const dir = root();
  for (const response of [
    new Response("invalid-json"),
    new Response(" ".repeat(65 * 1024)),
    new Response("{}", { headers: { "content-length": String(65 * 1024) } }),
    Response.json({ detail: "remote secret" }, { status: 503 }),
  ]) {
    expect(await resolveCodexCatalogVersion(mockFetch(async () => response), { configDir: dir })).toBeUndefined();
  }
});

test("ignores corrupt or future-dated caches and fetches metadata again", async () => {
  const dir = root(); let calls = 0;
  const fetch = mockFetch(async () => { calls++; return metadata("0.200.0"); });
  for (const value of ["not-json", JSON.stringify({ version: "0.159.2", fetchedAt: 2_000 }), JSON.stringify({ version: "latest", fetchedAt: 500 })]) {
    writeFileSync(join(dir, "codex-catalog-version.json"), value);
    expect(await resolveCodexCatalogVersion(fetch, { configDir: dir, now: () => 1_000 })).toBe("0.200.0");
  }
  expect(calls).toBe(3);
});

test("cache write failure preserves the valid live version", async () => {
  const dir = root(); const file = join(dir, "not-a-directory"); writeFileSync(file, "fixture");
  expect(await resolveCodexCatalogVersion(mockFetch(async () => metadata("0.200.0")), { configDir: file })).toBe("0.200.0");
});

test("cancellation neither starts a request nor falls back to a stale cache", async () => {
  const dir = root(); const controller = new AbortController(); controller.abort();
  let calls = 0;
  const fetch = mockFetch(async () => { calls++; return metadata("0.200.0"); });
  expect(await resolveCodexCatalogVersion(fetch, { configDir: dir, signal: controller.signal })).toBeUndefined();
  expect(calls).toBe(0);
  writeFileSync(join(dir, "codex-catalog-version.json"), JSON.stringify({ version: "0.159.2", fetchedAt: 0 }));
  const active = new AbortController();
  expect(await resolveCodexCatalogVersion(mockFetch(async () => { active.abort(); throw new Error("aborted"); }), {
    configDir: dir, signal: active.signal,
  })).toBeUndefined();
});
