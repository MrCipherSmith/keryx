import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSearchConfig,
  migrateSearchConfig,
  readSearchCredential,
  saveSearchConfig,
  saveSearchCredential,
  SEARCH_CONFIG_SCHEMA,
  searchConfigPath,
  searchCredentialPath,
} from "./search-config";

describe("search config", () => {
  test("stores non-secret provider configuration separately from owner-only credentials", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-config-"));
    try {
      saveSearchConfig({ activeProviderId: "searxng", providers: { searxng: { fields: { baseUrl: "http://localhost", port: "8080" }, status: "connected" } } }, dir);
      saveSearchCredential("brave", "do-not-leak", dir);

      expect(loadSearchConfig(dir)).toMatchObject({ activeProviderId: "searxng" });
      expect(readSearchCredential("brave", dir)).toBe("do-not-leak");
      expect(existsSync(searchConfigPath(dir))).toBe(true);
      expect(existsSync(searchCredentialPath(dir))).toBe(true);
      expect(readFileSync(searchConfigPath(dir), "utf8")).not.toContain("do-not-leak");
      expect(statSync(searchCredentialPath(dir)).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops a leftover searxng selection from pre-DuckDuckGo configs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-migrate-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        activeProviderId: "searxng",
        providers: { searxng: { fields: { baseUrl: "http://localhost", port: "8080" }, status: "connected", lastTestedAt: "2026-08-22T23:50:00.000Z" } },
      })}\n`);

      const loaded = loadSearchConfig(dir);
      expect(loaded.schemaVersion).toBe(SEARCH_CONFIG_SCHEMA);
      expect(loaded.activeProviderId).toBeUndefined();
      expect(loaded.providers?.searxng?.status).toBe("connected");
      expect(JSON.parse(readFileSync(searchConfigPath(dir), "utf8")).activeProviderId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps an explicit Brave selection when migrating to the DuckDuckGo default schema", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-keep-brave-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        activeProviderId: "brave",
        providers: { brave: { fields: {}, status: "connected" } },
      })}\n`);

      expect(loadSearchConfig(dir)).toMatchObject({ schemaVersion: SEARCH_CONFIG_SCHEMA, activeProviderId: "brave" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a schema-2 searxng selection is kept — the user re-selected it after the default", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-keep-searxng-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        schemaVersion: SEARCH_CONFIG_SCHEMA,
        activeProviderId: "searxng",
        providers: { searxng: { fields: { baseUrl: "http://localhost", port: "8080" }, status: "connected" } },
      })}\n`);
      expect(loadSearchConfig(dir).activeProviderId).toBe("searxng");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migrateSearchConfig drops only searxng as the leftover default", () => {
    expect(migrateSearchConfig({ activeProviderId: "searxng" }).activeProviderId).toBeUndefined();
    expect(migrateSearchConfig({ activeProviderId: "brave" }).activeProviderId).toBe("brave");
  });

  test("does not expose malformed or missing credential data", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-config-"));
    try {
      expect(readSearchCredential("tavily", dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
