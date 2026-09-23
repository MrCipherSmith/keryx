import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isCustomCompatProvider,
  loadCustomCompatProviders,
  llmProvidersConfigPath,
  removeCustomCompatProvider,
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

  // flow 304 (AC5): the `/connect` Disconnect button + `keryx providers remove`.
  test("removeCustomCompatProvider deletes exactly the named entry, leaving siblings intact", () => {
    const dir = tempDir();
    saveCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [] }, dir);
    saveCustomCompatProvider({ name: "b", baseUrl: "http://localhost:2", models: [] }, dir);
    removeCustomCompatProvider("a", dir);
    expect(loadCustomCompatProviders(dir).map((p) => p.name)).toEqual(["b"]);
  });

  test("removeCustomCompatProvider on an unknown name is a no-op, not an error", () => {
    const dir = tempDir();
    saveCustomCompatProvider({ name: "a", baseUrl: "http://localhost:1", models: [] }, dir);
    removeCustomCompatProvider("never-existed", dir);
    expect(loadCustomCompatProviders(dir).map((p) => p.name)).toEqual(["a"]);
  });

  test("removeCustomCompatProvider against an absent file never throws", () => {
    expect(() => removeCustomCompatProvider("a", tempDir())).not.toThrow();
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
