import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isCustomCompatProvider,
  loadCustomCompatProviders,
  llmProvidersConfigPath,
  saveCustomCompatProvider,
  type CustomCompatProvider,
} from "./provider-config";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-provider-config-"));
}

describe("llm-providers.json custom provider registry", () => {
  test("roundtrip: save then load returns the same provider (trailing slashes trimmed)", () => {
    const dir = tempDir();
    const provider: CustomCompatProvider = {
      name: "internal-qwen",
      label: "Internal Qwen",
      baseUrl: "http://10.110.43.19:8080/v1/",
      apiKey: "sk-test",
      models: ["Qwen/Qwen3.5-122B-A10B-FP8"],
      requiresApiKey: false,
    };
    saveCustomCompatProvider(provider, dir);
    expect(existsSync(llmProvidersConfigPath(dir))).toBe(true);
    const loaded = loadCustomCompatProviders(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "internal-qwen",
      baseUrl: "http://10.110.43.19:8080/v1",
      apiKey: "sk-test",
      models: ["Qwen/Qwen3.5-122B-A10B-FP8"],
    });
  });

  test("saving a second provider preserves the first (merge)", () => {
    const dir = tempDir();
    saveCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [] }, dir);
    saveCustomCompatProvider({ name: "b", baseUrl: "http://localhost:2", models: [] }, dir);
    expect(
      loadCustomCompatProviders(dir)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  test("absent file loads as an empty list (never throws)", () => {
    expect(loadCustomCompatProviders(tempDir())).toEqual([]);
  });

  test("malformed entries (missing baseUrl) are dropped", () => {
    const dir = tempDir();
    writeFileSync(
      llmProvidersConfigPath(dir),
      JSON.stringify({ schemaVersion: 1, providers: { broken: { name: "broken", models: [] } } }),
    );
    expect(loadCustomCompatProviders(dir)).toEqual([]);
  });

  // flow 268 (AC1)
  test("round-trips temperature/maxOutputTokens/timeoutMs", () => {
    const dir = tempDir();
    const provider: CustomCompatProvider = {
      name: "internal-qwen",
      baseUrl: "http://10.110.43.19:8080",
      models: ["Qwen/Qwen3.5-122B-A10B-FP8"],
      temperature: 0.2,
      maxOutputTokens: 4096,
      timeoutMs: 180_000,
    };
    saveCustomCompatProvider(provider, dir);
    const loaded = loadCustomCompatProviders(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ temperature: 0.2, maxOutputTokens: 4096, timeoutMs: 180_000 });
  });

  test("isCustomCompatProvider does not throw and validates when the three fields are absent", () => {
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [] }),
    ).toBe(true);
  });

  test("isCustomCompatProvider accepts finite numbers for the three optional fields", () => {
    expect(
      isCustomCompatProvider({
        name: "a",
        baseUrl: "http://localhost:1",
        models: [],
        temperature: 0.7,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
      }),
    ).toBe(true);
  });

  test("isCustomCompatProvider rejects a non-finite value for any of the three fields, silently", () => {
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], temperature: "hot" }),
    ).toBe(false);
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], maxOutputTokens: Number.NaN }),
    ).toBe(false);
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], timeoutMs: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });

  test("isCustomCompatProvider rejects zero/negative maxOutputTokens or timeoutMs, but allows temperature 0", () => {
    // A 0/negative output-token cap or timeout is not a real setting (it would
    // request a budget of zero output tokens, or abort every stream
    // instantly) — unlike temperature, where 0 is a meaningful value.
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], maxOutputTokens: 0 }),
    ).toBe(false);
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], maxOutputTokens: -1 }),
    ).toBe(false);
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], timeoutMs: 0 }),
    ).toBe(false);
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], timeoutMs: -60_000 }),
    ).toBe(false);
    expect(
      isCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [], temperature: 0 }),
    ).toBe(true);
  });

  test("a hand-edited file with a bad model-param value drops that entry, never throws", () => {
    const dir = tempDir();
    writeFileSync(
      llmProvidersConfigPath(dir),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          broken: { name: "broken", baseUrl: "http://localhost:1", models: [], temperature: "hot" },
          ok: { name: "ok", baseUrl: "http://localhost:2", models: [] },
        },
      }),
    );
    expect(loadCustomCompatProviders(dir).map((p) => p.name)).toEqual(["ok"]);
  });
});
