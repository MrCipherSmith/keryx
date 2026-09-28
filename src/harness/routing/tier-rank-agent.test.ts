// Flow 358 — the host side of the tier-ranking fallback: the file cache, the profile
// prices and the provider-backed agent. Everything runs against a temp config dir and
// an injected turn runner; nothing here opens a socket or reads a real credential.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveTierModelWithAgent, type TierRankRequest } from "../../gdskills/model-tier";
import type { ModelProfile } from "./model-profile";
import {
  createTierRankAgent,
  createTierRankFileCache,
  modelPricesFromProfiles,
  RANK_FAILURE_MEMO_MS,
  tierRankCacheFilePath,
} from "./tier-rank-agent";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "keryx-tier-rank-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const REQUEST: TierRankRequest = {
  providerId: "acme",
  sessionModel: "acme-terra",
  trigger: "refused",
  candidates: [{ modelId: "acme-luna" }, { modelId: "acme-terra", inputPerMillion: 1 }],
  runOn: { providerId: "acme", modelId: "acme-luna" },
  prompt: "PROMPT",
};

describe("the file cache", () => {
  test("round-trips an order, owner-only, next to the profiles file", async () => {
    const cache = createTierRankFileCache(dir);
    expect(await cache.get("k")).toBeUndefined();
    await cache.set("k", ["a", "b"]);
    expect(await cache.get("k")).toEqual(["a", "b"]);
    expect(path.dirname(tierRankCacheFilePath(dir))).toBe(dir);
    expect(statSync(tierRankCacheFilePath(dir)).mode & 0o777).toBe(0o600);
  });

  test("a damaged or foreign file is a miss, never a throw", async () => {
    writeFileSync(tierRankCacheFilePath(dir), "{not json");
    const cache = createTierRankFileCache(dir);
    expect(await cache.get("k")).toBeUndefined();
    writeFileSync(tierRankCacheFilePath(dir), JSON.stringify({ version: 99, entries: { k: { order: ["a"], at: "x" } } }));
    expect(await cache.get("k")).toBeUndefined();
    writeFileSync(tierRankCacheFilePath(dir), JSON.stringify({ version: 1, entries: { k: { order: [1], at: "x" } } }));
    expect(await cache.get("k")).toBeUndefined();
    // …and a later write repairs it.
    await cache.set("k", ["a"]);
    expect(await cache.get("k")).toEqual(["a"]);
  });

  test("the oldest entries are dropped past the cap", async () => {
    let clock = 0;
    const cache = createTierRankFileCache(dir, () => (clock += 1000));
    for (let i = 0; i < 70; i += 1) await cache.set(`k${i}`, ["a"]);
    expect(await cache.get("k0")).toBeUndefined();
    expect(await cache.get("k69")).toEqual(["a"]);
  });

  test("drives the resolver: the second identical catalogue asks the agent zero times", async () => {
    const cache = createTierRankFileCache(dir);
    const session = { providerId: "openai", modelId: "gpt-5.6-terra" };
    const catalog = [{ name: "openai", models: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"] }];
    let calls = 0;
    const agent = async () => {
      calls += 1;
      return JSON.stringify({ order: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"] });
    };
    const first = await resolveTierModelWithAgent(session, "deep", catalog, { agent, cache });
    const second = await resolveTierModelWithAgent(session, "light", catalog, { agent, cache });
    expect(calls).toBe(1);
    expect(first.modelId).toBe("gpt-5.6");
    expect(second.modelId).toBe("gpt-5.6-luna");
    expect(second.agent?.cacheHit).toBe(true);
  });
});

describe("prices from profiles", () => {
  const profile = (modelId: string, input: number | "unknown", output: number | "unknown", providerId = "acme"): ModelProfile =>
    ({
      providerId,
      modelId,
      priceInputPerMillion: input === "unknown" ? { value: "unknown", source: "unknown" } : { value: input, source: "operator" },
      priceOutputPerMillion: output === "unknown" ? { value: "unknown", source: "unknown" } : { value: output, source: "operator" },
    }) as unknown as ModelProfile;

  test("numeric prices only, this provider only, unknown is absent and never zero", () => {
    const prices = modelPricesFromProfiles("acme", {
      "acme/a": profile("a", 3, 15),
      "acme/b": profile("b", "unknown", 9),
      "acme/c": profile("c", "unknown", "unknown"),
      "other/d": profile("d", 1, 1, "other"),
    });
    expect(prices).toEqual({ a: { inputPerMillion: 3, outputPerMillion: 15 }, b: { outputPerMillion: 9 } });
  });
});

describe("the provider-backed agent", () => {
  const ok = (text: string) => ({ text, credentialAvailable: true });

  test("runs one turn on the request's runOn model with the request's prompt, and returns the text", async () => {
    const seen: { provider?: string | undefined; model?: string | undefined; user?: string | undefined; system?: string | undefined }[] = [];
    const agent = createTierRankAgent({
      runTurn: async (input) => {
        seen.push({ provider: input.provider, model: input.model, user: input.user, system: input.system });
        return ok('{"order":["acme-terra","acme-luna"]}');
      },
    });
    expect(await agent(REQUEST)).toBe('{"order":["acme-terra","acme-luna"]}');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.provider).toBe("acme");
    expect(seen[0]!.model).toBe("acme-luna");
    expect(seen[0]!.user).toBe("PROMPT");
    expect(seen[0]!.system).toContain("never see or judge any task");
  });

  test("a missing credential, a provider error and an empty answer all throw", async () => {
    for (const result of [
      { text: "", credentialAvailable: false },
      { text: "", credentialAvailable: true, error: { message: "boom" } },
      { text: "   ", credentialAvailable: true },
    ]) {
      const agent = createTierRankAgent({ runTurn: async () => result });
      await expect(agent(REQUEST)).rejects.toThrow();
    }
  });

  test("a failure is remembered in this process, then retried once the memo expires", async () => {
    let calls = 0;
    let clock = 1_000;
    const agent = createTierRankAgent({
      now: () => clock,
      runTurn: async () => {
        calls += 1;
        throw new Error("down");
      },
    });
    await expect(agent(REQUEST)).rejects.toThrow("down");
    await expect(agent(REQUEST)).rejects.toThrow("remembered");
    expect(calls).toBe(1);
    clock += RANK_FAILURE_MEMO_MS + 1;
    await expect(agent(REQUEST)).rejects.toThrow("down");
    expect(calls).toBe(2);
  });

  test("a different catalogue is not blocked by another catalogue's failure", async () => {
    let calls = 0;
    const agent = createTierRankAgent({
      runTurn: async () => {
        calls += 1;
        if (calls === 1) throw new Error("down");
        return ok('{"order":["acme-terra","acme-luna","acme-sol"]}');
      },
    });
    await expect(agent(REQUEST)).rejects.toThrow("down");
    await expect(agent({ ...REQUEST, candidates: [...REQUEST.candidates, { modelId: "acme-sol" }] })).resolves.toContain("acme-sol");
  });

  test("two concurrent calls for one catalogue run one turn", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = createTierRankAgent({
      runTurn: async () => {
        calls += 1;
        await gate;
        return ok('{"order":["acme-terra","acme-luna"]}');
      },
    });
    const first = agent(REQUEST);
    const second = agent(REQUEST);
    release();
    expect(await first).toBe(await second);
    expect(calls).toBe(1);
  });

  test("an unusable answer is remembered like a failure and not re-requested inside the window", async () => {
    for (const text of ['{"order": ["acme-terra", "acme-lu', "not json at all", '{"order":["acme-luna"]}', '{"order":["ghost-1","ghost-2"]}']) {
      let calls = 0;
      let clock = 1_000;
      const agent = createTierRankAgent({
        now: () => clock,
        runTurn: async () => {
          calls += 1;
          return ok(text);
        },
      });
      await expect(agent(REQUEST)).rejects.toThrow("unusable answer");
      await expect(agent(REQUEST)).rejects.toThrow("remembered");
      expect(calls).toBe(1);
      clock += RANK_FAILURE_MEMO_MS + 1;
      await expect(agent(REQUEST)).rejects.toThrow("unusable answer");
      expect(calls).toBe(2);
    }
  });

  test("the request's signal and base URL reach the turn", async () => {
    const seen: { signal?: AbortSignal | undefined; baseUrl?: string | undefined }[] = [];
    const agent = createTierRankAgent({
      runTurn: async (input) => {
        seen.push({ signal: input.signal, baseUrl: input.baseUrl });
        return ok('{"order":["acme-terra","acme-luna"]}');
      },
    });
    const controller = new AbortController();
    await agent({ ...REQUEST, signal: controller.signal, baseUrl: "http://localhost:9/v1" });
    expect(seen[0]!.signal).toBe(controller.signal);
    expect(seen[0]!.baseUrl).toBe("http://localhost:9/v1");
  });
});
