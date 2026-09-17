import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
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

  test("maxOutputTokens: a positive integer round-trips", () => {
    const dir = tempDir();
    const provider: CustomCompatProvider = {
      name: "internal-qwen",
      baseUrl: "http://localhost:1",
      models: [],
      maxOutputTokens: 4096,
    };
    saveCustomCompatProvider(provider, dir);
    expect(loadCustomCompatProviders(dir)).toHaveLength(1);
    expect(loadCustomCompatProviders(dir)[0]?.maxOutputTokens).toBe(4096);
  });

  test("maxOutputTokens: absent is valid (undefined, not dropped)", () => {
    const dir = tempDir();
    saveCustomCompatProvider({ name: "no-override", baseUrl: "http://localhost:1", models: [] }, dir);
    const loaded = loadCustomCompatProviders(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.maxOutputTokens).toBeUndefined();
  });

  test("maxOutputTokens: a non-positive-integer entry is dropped (whole provider invalid)", () => {
    for (const bad of [0, -1, 1.5, "8192"]) {
      const dir = tempDir();
      writeFileSync(
        llmProvidersConfigPath(dir),
        JSON.stringify({
          schemaVersion: 1,
          providers: { bad: { name: "bad", baseUrl: "http://localhost:1", models: [], maxOutputTokens: bad } },
        }),
      );
      expect(loadCustomCompatProviders(dir)).toEqual([]);
    }
  });

  // flow 268 T10 / AC4: `reasoning` config, validated on load.
  describe("reasoning config validation (flow 268 T10)", () => {
    test("a full valid reasoning config round-trips", () => {
      const dir = tempDir();
      const provider: CustomCompatProvider = {
        name: "minimax",
        baseUrl: "http://localhost:1",
        models: [],
        reasoning: { format: "inline-tags", requestParams: { reasoning_split: true }, replay: "minimax" },
      };
      saveCustomCompatProvider(provider, dir);
      const loaded = loadCustomCompatProviders(dir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.reasoning).toEqual({
        format: "inline-tags",
        requestParams: { reasoning_split: true },
        replay: "minimax",
      });
    });

    test("absent reasoning is valid (undefined, not dropped)", () => {
      const dir = tempDir();
      saveCustomCompatProvider({ name: "plain", baseUrl: "http://localhost:1", models: [] }, dir);
      const loaded = loadCustomCompatProviders(dir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.reasoning).toBeUndefined();
    });

    test("each of the three formats round-trips on its own", () => {
      for (const format of ["field", "inline-tags", "split"] as const) {
        const dir = tempDir();
        saveCustomCompatProvider(
          { name: "p", baseUrl: "http://localhost:1", models: [], reasoning: { format } },
          dir,
        );
        expect(loadCustomCompatProviders(dir)[0]?.reasoning).toEqual({ format });
      }
    });

    test("an unknown format value drops the whole provider entry", () => {
      const dir = tempDir();
      writeFileSync(
        llmProvidersConfigPath(dir),
        JSON.stringify({
          schemaVersion: 1,
          providers: {
            bad: { name: "bad", baseUrl: "http://localhost:1", models: [], reasoning: { format: "bogus" } },
          },
        }),
      );
      expect(loadCustomCompatProviders(dir)).toEqual([]);
    });

    test("an unknown replay value drops the whole provider entry", () => {
      const dir = tempDir();
      writeFileSync(
        llmProvidersConfigPath(dir),
        JSON.stringify({
          schemaVersion: 1,
          providers: {
            bad: { name: "bad", baseUrl: "http://localhost:1", models: [], reasoning: { replay: "bogus" } },
          },
        }),
      );
      expect(loadCustomCompatProviders(dir)).toEqual([]);
    });

    test("a non-object requestParams drops the whole provider entry", () => {
      for (const bad of ["nope", 1, true, ["a"], null]) {
        const dir = tempDir();
        writeFileSync(
          llmProvidersConfigPath(dir),
          JSON.stringify({
            schemaVersion: 1,
            providers: {
              bad: { name: "bad", baseUrl: "http://localhost:1", models: [], reasoning: { requestParams: bad } },
            },
          }),
        );
        expect(loadCustomCompatProviders(dir)).toEqual([]);
      }
    });

    test("a non-object reasoning value (string, array) drops the whole provider entry", () => {
      for (const bad of ["field", ["field"]]) {
        const dir = tempDir();
        writeFileSync(
          llmProvidersConfigPath(dir),
          JSON.stringify({
            schemaVersion: 1,
            providers: { bad: { name: "bad", baseUrl: "http://localhost:1", models: [], reasoning: bad } },
          }),
        );
        expect(loadCustomCompatProviders(dir)).toEqual([]);
      }
    });
  });
});
