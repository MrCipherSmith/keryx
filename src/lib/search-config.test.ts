import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSearchConfig,
  readSearchCredential,
  saveSearchConfig,
  saveSearchCredential,
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

  test("does not expose malformed or missing credential data", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-config-"));
    try {
      expect(readSearchCredential("tavily", dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
