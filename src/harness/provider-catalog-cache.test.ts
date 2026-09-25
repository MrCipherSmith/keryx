// Flow 309 — the on-disk provider catalog cache: round-trip, sanitization,
// freshness, single-entry patching, status classification, and age
// formatting. No network anywhere in this file.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CATALOG_CACHE_TTL_MS,
  classifyModelsStatus,
  formatCatalogAge,
  isCatalogFresh,
  loadProviderCatalogCache,
  saveProviderCatalogCache,
  updateProviderCatalogEntry,
  type ProviderCatalog,
  type ProviderCatalogEntry,
} from "./provider-catalog-cache";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-provider-catalog-cache-"));
  roots.push(dir);
  return dir;
}

const OK_ENTRY: ProviderCatalogEntry = {
  name: "deepseek",
  label: "DeepSeek",
  status: "ok",
  models: ["deepseek-chat", "deepseek-reasoner"],
  fallbackModels: ["deepseek-chat"],
  fetchedAt: "2026-09-25T10:00:00.000Z",
  balance: { currency: "USD", total: 6.19, exact: true },
};

test("saveProviderCatalogCache + loadProviderCatalogCache: round-trips a whole catalog", async () => {
  const dir = tempDir();
  const catalog: ProviderCatalog = { fetchedAt: OK_ENTRY.fetchedAt, providers: { deepseek: OK_ENTRY } };
  await saveProviderCatalogCache(catalog, dir);
  const loaded = loadProviderCatalogCache(dir);
  expect(loaded).toEqual(catalog);
});

test("saveProviderCatalogCache: writes the cache file mode 0600 (AC3)", async () => {
  const dir = tempDir();
  await saveProviderCatalogCache({ fetchedAt: OK_ENTRY.fetchedAt, providers: { deepseek: OK_ENTRY } }, dir);
  const stats = statSync(path.join(dir, "provider-catalog.json"));
  expect(stats.mode & 0o777).toBe(0o600);
});

test("saveProviderCatalogCache: the file never contains a credential-shaped field, even hand-added", async () => {
  const dir = tempDir();
  await saveProviderCatalogCache({ fetchedAt: OK_ENTRY.fetchedAt, providers: { deepseek: OK_ENTRY } }, dir);
  const raw = readFileSync(path.join(dir, "provider-catalog.json"), "utf8");
  expect(raw).not.toMatch(/apiKey|Bearer|api_key|secret/i);
});

test("loadProviderCatalogCache: absent file returns undefined", () => {
  const dir = tempDir();
  expect(loadProviderCatalogCache(dir)).toBeUndefined();
});

test("loadProviderCatalogCache: malformed JSON returns undefined rather than throwing", () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "provider-catalog.json"), "{not json", { mode: 0o600 });
  expect(loadProviderCatalogCache(dir)).toBeUndefined();
});

test("loadProviderCatalogCache: drops an entry with an invalid status rather than trusting a hand-edited file", () => {
  const dir = tempDir();
  writeFileSync(
    path.join(dir, "provider-catalog.json"),
    JSON.stringify({
      fetchedAt: OK_ENTRY.fetchedAt,
      providers: {
        deepseek: OK_ENTRY,
        bogus: { name: "bogus", status: "definitely-not-real", models: [], fallbackModels: [], fetchedAt: OK_ENTRY.fetchedAt },
      },
    }),
    { mode: 0o600 },
  );
  const loaded = loadProviderCatalogCache(dir);
  expect(loaded?.providers.deepseek).toEqual(OK_ENTRY);
  expect(loaded?.providers.bogus).toBeUndefined();
});

test("loadProviderCatalogCache: strips an unexpected extra field (e.g. a hand-added apiKey) rather than round-tripping it", () => {
  const dir = tempDir();
  writeFileSync(
    path.join(dir, "provider-catalog.json"),
    JSON.stringify({
      fetchedAt: OK_ENTRY.fetchedAt,
      providers: { deepseek: { ...OK_ENTRY, apiKey: "sk-should-never-survive" } },
    }),
    { mode: 0o600 },
  );
  const loaded = loadProviderCatalogCache(dir);
  expect(loaded?.providers.deepseek).toEqual(OK_ENTRY);
  expect(JSON.stringify(loaded)).not.toContain("sk-should-never-survive");
});

test("isCatalogFresh: within the TTL is fresh, at/after it is not, and undefined/unparseable is never fresh", () => {
  const now = () => Date.parse("2026-09-25T10:04:00.000Z");
  expect(isCatalogFresh({ fetchedAt: "2026-09-25T10:00:00.000Z", providers: {} }, now)).toBe(true);
  expect(isCatalogFresh({ fetchedAt: "2026-09-25T09:50:00.000Z", providers: {} }, now)).toBe(false);
  expect(isCatalogFresh({ fetchedAt: "2026-09-25T10:04:00.000Z", providers: {} }, now, CATALOG_CACHE_TTL_MS)).toBe(true);
  expect(isCatalogFresh(undefined, now)).toBe(false);
  expect(isCatalogFresh({ fetchedAt: "not-a-date", providers: {} }, now)).toBe(false);
  // A cache "from the future" (clock skew) is treated as not fresh, never negative-age-fresh.
  expect(isCatalogFresh({ fetchedAt: "2026-09-25T10:10:00.000Z", providers: {} }, now)).toBe(false);
});

test("updateProviderCatalogEntry: patches ONE provider without touching a sibling entry already in the cache", async () => {
  const dir = tempDir();
  const other: ProviderCatalogEntry = { name: "openrouter", status: "ok", models: ["a"], fallbackModels: [], fetchedAt: "2026-09-25T09:00:00.000Z" };
  await saveProviderCatalogCache({ fetchedAt: "2026-09-25T09:00:00.000Z", providers: { openrouter: other } }, dir);

  const updated: ProviderCatalogEntry = { ...OK_ENTRY, status: "auth-failed", models: [] };
  await updateProviderCatalogEntry(updated, dir);

  const loaded = loadProviderCatalogCache(dir);
  expect(loaded?.providers.openrouter).toEqual(other);
  expect(loaded?.providers.deepseek).toEqual(updated);
});

test("updateProviderCatalogEntry: creates the cache when none exists yet", async () => {
  const dir = tempDir();
  await updateProviderCatalogEntry(OK_ENTRY, dir);
  expect(loadProviderCatalogCache(dir)?.providers.deepseek).toEqual(OK_ENTRY);
});

test("saveProviderCatalogCache: a concurrent updateProviderCatalogEntry patch mid-refresh is not lost (flow 309 review, finding 2 — the lost-update race)", async () => {
  const dir = tempDir();
  const refreshStartedAt = "2026-09-25T10:00:00.000Z";
  // The full refresh READ this provider at its own start time, before either
  // write below happens — this is the value it will eventually try to save.
  const staleFromRefresh: ProviderCatalogEntry = {
    name: "deepseek",
    status: "ok",
    models: ["deepseek-chat"],
    fallbackModels: [],
    fetchedAt: refreshStartedAt,
  };
  // Interleaving under test: WHILE that refresh is still in flight (its own
  // fetch can take up to CATALOG_FETCH_TIMEOUT_MS per provider), a `providers
  // test`/`[Test]` row patch lands on disk for the SAME provider, strictly
  // AFTER the refresh started.
  const freshFromTest: ProviderCatalogEntry = {
    name: "deepseek",
    status: "auth-failed",
    models: [],
    fallbackModels: [],
    fetchedAt: "2026-09-25T10:00:02.000Z",
  };
  await updateProviderCatalogEntry(freshFromTest, dir);

  // The refresh finally finishes and writes its OLDER read for the same
  // provider. Before the fix, `saveProviderCatalogCache` overwrote the whole
  // file unconditionally and without a lock — clobbering the newer
  // `providers test` patch with this staler refresh read.
  await saveProviderCatalogCache({ fetchedAt: refreshStartedAt, providers: { deepseek: staleFromRefresh } }, dir);

  const loaded = loadProviderCatalogCache(dir);
  // The NEWER single-provider patch survives the OLDER full-refresh write.
  expect(loaded?.providers.deepseek).toEqual(freshFromTest);
});

test("saveProviderCatalogCache: a refresh's OWN (newer) read still wins over an older on-disk entry — the merge only protects entries NEWER than the refresh start", async () => {
  const dir = tempDir();
  const older: ProviderCatalogEntry = { ...OK_ENTRY, fetchedAt: "2026-09-25T09:00:00.000Z", status: "auth-failed", models: [] };
  await saveProviderCatalogCache({ fetchedAt: older.fetchedAt, providers: { deepseek: older } }, dir);

  const refreshed: ProviderCatalogEntry = { ...OK_ENTRY, fetchedAt: "2026-09-25T10:00:00.000Z" };
  await saveProviderCatalogCache({ fetchedAt: refreshed.fetchedAt, providers: { deepseek: refreshed } }, dir);

  expect(loadProviderCatalogCache(dir)?.providers.deepseek).toEqual(refreshed);
});

// --- classifyModelsStatus (AC1's five states from a live probe result) -----

test("classifyModelsStatus: live -> ok", () => {
  expect(classifyModelsStatus({ models: ["m"], source: "live" })).toBe("ok");
});

test("classifyModelsStatus: a rejected credential (401/403) -> auth-failed", () => {
  expect(classifyModelsStatus({ models: [], source: "fallback", failure: { kind: "rejected", status: 401 } })).toBe("auth-failed");
});

test("classifyModelsStatus: any other non-2xx -> unreachable", () => {
  expect(classifyModelsStatus({ models: [], source: "fallback", failure: { kind: "http", status: 500 } })).toBe("unreachable");
});

test("classifyModelsStatus: a well-formed genuinely empty list -> ok (reached fine, nothing to offer)", () => {
  expect(classifyModelsStatus({ models: [], source: "fallback", failure: { kind: "empty" } })).toBe("ok");
});

test("classifyModelsStatus: an abort whose detail says it timed out -> timeout, distinct from a plain network failure", () => {
  expect(classifyModelsStatus({ models: [], source: "fallback", failure: { kind: "unreachable", detail: "timed out after 8000ms" } })).toBe("timeout");
  expect(classifyModelsStatus({ models: [], source: "fallback", failure: { kind: "unreachable", detail: "fetch failed" } })).toBe("unreachable");
  expect(classifyModelsStatus({ models: [], source: "fallback", failure: { kind: "unreachable" } })).toBe("unreachable");
});

// --- formatCatalogAge -------------------------------------------------------

test("formatCatalogAge: just now, minutes, hours, days", () => {
  const base = Date.parse("2026-09-25T12:00:00.000Z");
  const now = (offsetMs: number) => () => base + offsetMs;
  expect(formatCatalogAge("2026-09-25T12:00:00.000Z", now(0))).toBe("just now");
  expect(formatCatalogAge("2026-09-25T12:00:00.000Z", now(3 * 60_000))).toBe("3m ago");
  expect(formatCatalogAge("2026-09-25T12:00:00.000Z", now(2 * 3_600_000))).toBe("2h ago");
  expect(formatCatalogAge("2026-09-25T12:00:00.000Z", now(5 * 86_400_000))).toBe("5d ago");
  expect(formatCatalogAge("not-a-date")).toBe("unknown age");
});
