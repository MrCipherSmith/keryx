import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveCustomCompatProvider } from "../lib/provider-config";
import { allOpenAiCompatProviders, customCompatProviders } from "./providers";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-custom-providers-"));
}

describe("custom file providers merge into the registry", () => {
  test("customCompatProviders maps file entries with loopback + private-LAN grants", () => {
    const dir = tempDir();
    saveCustomCompatProvider(
      {
        name: "internal-qwen",
        label: "Internal Qwen",
        baseUrl: "http://10.110.43.19:8080",
        apiKey: "sk-test",
        models: ["Qwen/Qwen3.5-122B-A10B-FP8"],
        requiresApiKey: false,
      },
      dir,
    );
    const mapped = customCompatProviders(dir);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      name: "internal-qwen",
      baseUrl: "http://10.110.43.19:8080",
      apiKey: "sk-test",
      allowLoopback: true,
      allowPrivateLan: true,
      requiresApiKey: false,
      models: ["Qwen/Qwen3.5-122B-A10B-FP8"],
    });
  });

  test("a custom provider colliding with a built-in name is excluded (built-ins win)", () => {
    const dir = tempDir();
    saveCustomCompatProvider({ name: "deepseek", baseUrl: "http://localhost:1", models: [] }, dir);
    expect(customCompatProviders(dir).find((p) => p.name === "deepseek")).toBeUndefined();
  });

  test("allOpenAiCompatProviders includes built-ins plus customs", () => {
    const dir = tempDir();
    saveCustomCompatProvider({ name: "internal-qwen", baseUrl: "http://10.0.0.5:8080", models: ["m1"] }, dir);
    const all = allOpenAiCompatProviders(dir);
    expect(all.some((p) => p.name === "deepseek")).toBe(true);
    expect(all.find((p) => p.name === "internal-qwen")?.models).toEqual(["m1"]);
  });
});
