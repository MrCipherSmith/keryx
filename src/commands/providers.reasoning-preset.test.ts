// Unit tests for `resolveCompatReasoningPreset` (flow 268 T24): pure host
// matching + explicit-config precedence, independent of the file system and
// of `makeProvider`'s grant construction (covered end-to-end separately in
// `../harness/provider/make-provider.test.ts`).
import { describe, expect, test } from "bun:test";
import { resolveCompatReasoningPreset } from "./providers";

describe("resolveCompatReasoningPreset", () => {
  test("no explicit config, host api.minimax.io (bare path): returns the split preset", () => {
    expect(resolveCompatReasoningPreset(undefined, "https://api.minimax.io")).toEqual({
      format: "split",
      requestParams: { reasoning_split: true },
      replay: "minimax",
    });
  });

  test("no explicit config, host api.minimaxi.com: returns the split preset", () => {
    expect(resolveCompatReasoningPreset(undefined, "https://api.minimaxi.com")).toEqual({
      format: "split",
      requestParams: { reasoning_split: true },
      replay: "minimax",
    });
  });

  test("the preset applies regardless of path", () => {
    expect(resolveCompatReasoningPreset(undefined, "https://api.minimax.io/v1")).toEqual({
      format: "split",
      requestParams: { reasoning_split: true },
      replay: "minimax",
    });
    expect(resolveCompatReasoningPreset(undefined, "https://api.minimax.io/v1/chat")).toEqual({
      format: "split",
      requestParams: { reasoning_split: true },
      replay: "minimax",
    });
  });

  test("a host match must be exact — a subdomain or lookalike host is NOT preset", () => {
    expect(resolveCompatReasoningPreset(undefined, "https://sub.api.minimax.io")).toBeUndefined();
    expect(resolveCompatReasoningPreset(undefined, "https://notapi.minimax.io")).toBeUndefined();
    expect(resolveCompatReasoningPreset(undefined, "https://api.minimax.io.evil.com")).toBeUndefined();
  });

  test("no explicit config, any other host: stays undefined (pre-existing behaviour)", () => {
    expect(resolveCompatReasoningPreset(undefined, "https://api.deepseek.com")).toBeUndefined();
    expect(resolveCompatReasoningPreset(undefined, "http://127.0.0.1:8080")).toBeUndefined();
  });

  test("an explicit config on a MiniMax host wins, verbatim, over the preset", () => {
    const explicit = { format: "inline-tags" as const };
    expect(resolveCompatReasoningPreset(explicit, "https://api.minimax.io")).toBe(explicit);
  });

  test("an explicit config on a MiniMax host wins even when it re-selects a known-buggy shape", () => {
    const explicit = { replay: "deepseek" as const };
    expect(resolveCompatReasoningPreset(explicit, "https://api.minimax.io")).toEqual(explicit);
  });

  test("an unparsable baseUrl resolves to undefined rather than throwing", () => {
    expect(resolveCompatReasoningPreset(undefined, "not a url")).toBeUndefined();
  });
});
