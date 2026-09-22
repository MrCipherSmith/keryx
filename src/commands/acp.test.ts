// `keryx acp` provider resolution (flow 287, AC1/AC2).
//
// The defect this pins: `parseArgs` used to default to `provider = "fake"`, so
// an editor launching `keryx acp` with no flags got `FakeProvider` and the
// operator's first real message failed with "no transcript matches request
// hash". Every test here runs against a temp config directory — never the
// developer's own `auth.json`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeProvider } from "../harness/provider/fake-provider";
import { OllamaProvider } from "../harness/provider/ollama/ollama-provider";
import type { ProviderPort } from "../harness/provider/types";
import {
  parseAcpArgs,
  resolveAcpProvider,
  shellGrantRefresh,
  shellModelSource,
  type ResolveAcpProviderDeps,
} from "./acp";
import type { DetectedProvider } from "./select";
import { resolveTuiStartup } from "./shell";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A config dir holding `auth.json` with `config`, or none at all. */
function configDir(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-acp-provider-"));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(path.join(dir, "auth.json"), JSON.stringify(config));
  return dir;
}

/** A provider stand-in that is NOT the fake, plus a record of what was built. */
function recordingFactory(): {
  calls: { name: string; model: string; baseUrl: string | undefined }[];
  make: NonNullable<ResolveAcpProviderDeps["makeProvider"]>;
} {
  const calls: { name: string; model: string; baseUrl: string | undefined }[] = [];
  return {
    calls,
    make: (name, model, baseUrl) => {
      calls.push({ name, model, baseUrl });
      return { describe: () => ({}) } as unknown as ProviderPort;
    },
  };
}

const neverFixture = (): ProviderPort => {
  throw new Error("the fixture provider must not be reachable without --fixture");
};

describe("parseAcpArgs", () => {
  test("no flags means no provider and no model — not a fake default", () => {
    expect(parseAcpArgs([])).toEqual({});
  });

  test("flags are read as given", () => {
    expect(parseAcpArgs(["--provider", "ollama", "--model", "llama3.1", "--data-dir", "/d"])).toEqual({
      provider: "ollama",
      model: "llama3.1",
      dataDir: "/d",
    });
  });
});

describe("AC1 — no flags resolves what keryx shell would use, through its own path", () => {
  test("the saved keryx shell selection is used, and it is exactly what resolveTuiStartup answers", async () => {
    const dir = configDir({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434" });
    const factory = recordingFactory();
    const resolution = await resolveAcpProvider({}, { configDir: dir, makeProvider: factory.make, loadFixture: neverFixture });

    const shell = await resolveTuiStartup({ detect: async () => [], configDir: dir });
    expect(resolution.kind).toBe("ready");
    if (resolution.kind !== "ready") return;
    expect(resolution.source).toBe("shell-config");
    // Narrowed first: comparing against `shell.initial?.x` would let an
    // absent shell selection pass as `undefined === undefined`.
    const initial = shell.initial;
    expect(initial).toBeDefined();
    if (initial === undefined) return;
    expect({ provider: resolution.providerId, model: resolution.modelId }).toEqual({
      provider: initial.provider,
      model: initial.model,
    });
    expect(factory.calls).toEqual([{ name: "ollama", model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434" }]);
  });

  test("the default path builds a real provider through the shell's factory — never FakeProvider", async () => {
    // No `makeProvider` injected: this is `realMakeProvider` itself. Ollama
    // needs no credential, so construction is offline and deterministic.
    const dir = configDir({ provider: "ollama", model: "qwen3:8b" });
    const resolution = await resolveAcpProvider({}, { configDir: dir, loadFixture: neverFixture });
    expect(resolution.kind).toBe("ready");
    if (resolution.kind !== "ready") return;
    expect(resolution.provider).toBeInstanceOf(OllamaProvider);
    expect(resolution.provider).not.toBeInstanceOf(FakeProvider);
  });

  test("explicit --provider/--model override the saved selection", async () => {
    const dir = configDir({ provider: "ollama", model: "qwen3:8b" });
    const factory = recordingFactory();
    const resolution = await resolveAcpProvider(
      { provider: "deepseek", model: "deepseek-chat" },
      { configDir: dir, makeProvider: factory.make, loadFixture: neverFixture },
    );
    expect(resolution.kind).toBe("ready");
    if (resolution.kind !== "ready") return;
    expect(resolution.source).toBe("flags");
    expect([resolution.providerId, resolution.modelId]).toEqual(["deepseek", "deepseek-chat"]);
    expect(factory.calls.map((call) => call.name)).toEqual(["deepseek"]);
  });

  test("a factory result that is FakeProvider (no credential, unknown name) is refused, never run", async () => {
    const dir = configDir({ provider: "anthropic", model: "claude-x" });
    const resolution = await resolveAcpProvider(
      {},
      { configDir: dir, makeProvider: () => new FakeProvider([]), loadFixture: neverFixture },
    );
    expect(resolution.kind).toBe("unconfigured");
    if (resolution.kind !== "unconfigured") return;
    expect(resolution.message).toContain('provider "anthropic"');
    expect(resolution.message).toContain("credential");
  });

  test("--provider fake is refused: the scripted provider is reachable only through --fixture", async () => {
    const factory = recordingFactory();
    const resolution = await resolveAcpProvider(
      { provider: "fake", model: "fake-model" },
      { configDir: configDir(), makeProvider: factory.make, loadFixture: neverFixture },
    );
    expect(resolution.kind).toBe("unconfigured");
    expect(factory.calls).toEqual([]);
  });

  test("--fixture is the one way to the scripted provider", async () => {
    const scripted = { describe: () => ({}) } as unknown as ProviderPort;
    const factory = recordingFactory();
    const resolution = await resolveAcpProvider(
      { fixture: "/fixture.json" },
      { configDir: configDir(), makeProvider: factory.make, loadFixture: () => scripted },
    );
    expect(resolution).toMatchObject({ kind: "ready", provider: scripted, source: "fixture" });
    expect(factory.calls).toEqual([]);
  });
});

describe("AC2 — nothing configured is an answer that says what to configure", () => {
  test("no saved selection and no flags: unconfigured, naming keryx shell and --provider/--model", async () => {
    const dir = configDir();
    const factory = recordingFactory();
    const resolution = await resolveAcpProvider({}, { configDir: dir, makeProvider: factory.make, loadFixture: neverFixture });
    expect(resolution.kind).toBe("unconfigured");
    if (resolution.kind !== "unconfigured") return;
    expect(resolution.message).toContain("no provider is configured");
    expect(resolution.message).toContain("keryx shell");
    expect(resolution.message).toContain("--provider <name> --model <model>");
    expect(resolution.message).toContain(path.join(dir, "auth.json"));
    expect(factory.calls).toEqual([]);
  });

  test("half a pair is refused rather than silently ignored", async () => {
    const dir = configDir({ provider: "ollama", model: "qwen3:8b" });
    const resolution = await resolveAcpProvider({ provider: "deepseek" }, { configDir: dir, loadFixture: neverFixture });
    expect(resolution.kind).toBe("unconfigured");
    if (resolution.kind !== "unconfigured") return;
    expect(resolution.message).toContain("--provider was given without --model");
  });
});

describe("T13 — the shell's order: saved grants are refreshed BEFORE the selection is resolved", () => {
  test("an expiring grok grant: the provider is built with the REFRESHED token, not the stale one", async () => {
    // The chain this pins: `resolveTuiStartup` runs `applySavedApiKeys`, which
    // copies the saved grok access token into `process.env.XAI_API_KEY`. If
    // the refresh ran after that, the new token went only to auth.json and
    // the provider factory — reading the non-empty env key — used the stale one.
    const previous = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    const now = Date.parse("2026-09-22T12:00:00Z");
    const dir = configDir({
      provider: "grok",
      model: "grok-4",
      oauthGrants: {
        grok: { method: "device-code", access: "stale-access", refresh: "the-refresh", expires: now - 60_000, obtainedAt: "2026-09-22T00:00:00Z" },
      },
    });
    const tokenCalls: string[] = [];
    const tokenEndpoint = async (url: string): Promise<Response> => {
      tokenCalls.push(url);
      return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "next", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const seenKeys: (string | undefined)[] = [];
    try {
      const resolution = await resolveAcpProvider(
        {},
        {
          configDir: dir,
          refreshGrants: shellGrantRefresh(tokenEndpoint, () => now),
          // What `makeProvider` reads for grok: `XAI_API_KEY` from the env.
          makeProvider: () => {
            seenKeys.push(process.env.XAI_API_KEY);
            return { describe: () => ({}) } as unknown as ProviderPort;
          },
          loadFixture: neverFixture,
        },
      );
      expect(resolution.kind).toBe("ready");
      expect(tokenCalls).toHaveLength(1);
      expect(seenKeys).toEqual(["fresh-access"]);
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previous;
    }
  });
});

describe("T13 — per-turn settings resolved the way keryx shell resolves them", () => {
  test("saved modelParams, maxOutputTokens and reasoningEffort reach the turn settings", async () => {
    const envMax = process.env.KERYX_MAX_OUTPUT_TOKENS;
    const envEffort = process.env.KERYX_REASONING_EFFORT;
    delete process.env.KERYX_MAX_OUTPUT_TOKENS;
    delete process.env.KERYX_REASONING_EFFORT;
    try {
      const dir = configDir({
        provider: "deepseek",
        model: "deepseek-chat",
        modelParams: { deepseek: { temperature: 0.3, maxOutputTokens: 1234 } },
        reasoningEffort: "high",
      });
      const resolution = await resolveAcpProvider(
        {},
        { configDir: dir, makeProvider: recordingFactory().make, loadFixture: neverFixture },
      );
      expect(resolution.kind).toBe("ready");
      if (resolution.kind !== "ready") return;
      expect(resolution.turnSettings.modelParams?.temperature).toBe(0.3);
      expect(resolution.turnSettings.maxOutputTokens).toBe(1234);
      expect(resolution.turnSettings.reasoningEffort).toBe("high");
    } finally {
      if (envMax !== undefined) process.env.KERYX_MAX_OUTPUT_TOKENS = envMax;
      if (envEffort !== undefined) process.env.KERYX_REASONING_EFFORT = envEffort;
    }
  });
});

// Flow 288, AC5/AC6: the models an editor may switch to are keryx shell's own
// picker source narrowed to what can run, and a switch is built through the
// shell's provider path — refresh first, the shell factory, no fake — without
// touching the shell's saved selection.
describe("flow 288 — model choices and switching come from keryx shell's sources", () => {
  const detected: DetectedProvider[] = [
    { name: "ollama", models: ["qwen3:8b", "llama3:8b"], baseUrl: "http://127.0.0.1:11434" },
    { name: "deepseek", models: ["deepseek-chat"], baseUrl: "https://api.deepseek.com" },
    { name: "groq", models: ["llama-3.3-70b"], baseUrl: "https://api.groq.com/openai" },
    { name: "fake", models: ["fake-echo"] },
  ];
  /** groq has no credential here: the shell factory would hand back the offline fake. */
  const make: NonNullable<ResolveAcpProviderDeps["makeProvider"]> = (name) =>
    name === "groq" ? new FakeProvider([]) : ({ describe: () => ({}) } as unknown as ProviderPort);

  test("choices: the launch model first, every runnable provider's picker list, never fake or a provider with no credential", async () => {
    const source = shellModelSource(
      { providerId: "ollama", modelId: "qwen3:8b" },
      {
        makeProvider: make,
        detect: async () => detected,
        // The picker's live list, stood in: what `resolveModelsForPicker` would answer.
        modelsFor: async (provider) => (provider.name === "deepseek" ? ["deepseek-chat", "deepseek-reasoner"] : provider.models),
      },
    );
    expect((await source.choices()).map((choice) => choice.value)).toEqual([
      "ollama/qwen3:8b",
      "ollama/llama3:8b",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
    ]);
  });

  test("choices: the launch provider is offered even when detection does not list it (an OAuth-only login)", async () => {
    const source = shellModelSource(
      { providerId: "grok", modelId: "grok-5" },
      { makeProvider: make, detect: async () => [], modelsFor: async (provider) => provider.models },
    );
    expect((await source.choices()).map((choice) => choice.value)).toEqual(["grok/grok-5"]);
  });

  test("bind: grants refreshed for the chosen provider BEFORE it is built, settings resolved for it, nothing saved", async () => {
    const dir = configDir({ provider: "ollama", model: "qwen3:8b", modelParams: { deepseek: { maxOutputTokens: 1234 } } });
    const before = readFileSync(path.join(dir, "auth.json"), "utf8");
    const order: string[] = [];
    const source = shellModelSource(
      { providerId: "ollama", modelId: "qwen3:8b" },
      {
        configDir: dir,
        makeProvider: (name, model, baseUrl) => {
          order.push(`make ${name} ${model} ${baseUrl ?? "-"}`);
          return make(name, model, baseUrl);
        },
        refreshGrants: async (provider) => {
          order.push(`refresh ${provider ?? "*"}`);
          return [];
        },
        detect: async () => detected,
        modelsFor: async (provider) => provider.models,
      },
    );
    const choice = (await source.choices()).find((entry) => entry.value === "deepseek/deepseek-chat");
    expect(choice).toBeDefined();
    order.length = 0;
    const bound = await source.bind(choice!);
    expect(typeof bound).not.toBe("string");
    if (typeof bound === "string") return;
    expect(order).toEqual(["refresh deepseek", "make deepseek deepseek-chat https://api.deepseek.com"]);
    expect({ providerId: bound.providerId, modelId: bound.modelId }).toEqual({ providerId: "deepseek", modelId: "deepseek-chat" });
    // The NEW provider's settings, not the launch provider's.
    expect(bound.turnSettings.maxOutputTokens).toBe(1234);
    // keryx shell's saved selection is untouched.
    expect(readFileSync(path.join(dir, "auth.json"), "utf8")).toBe(before);
  });

  test("bind: a provider the factory can only build as the offline fake is refused with the reason", async () => {
    const source = shellModelSource(
      { providerId: "ollama", modelId: "qwen3:8b" },
      { makeProvider: make, detect: async () => detected, modelsFor: async (provider) => provider.models },
    );
    const refused = await source.bind({ value: "groq/llama-3.3-70b", name: "llama-3.3-70b", providerId: "groq", modelId: "llama-3.3-70b" });
    expect(refused).toContain('provider "groq" has no usable credential');
  });

  test("a ready resolution carries the model source", async () => {
    const dir = configDir({ provider: "ollama", model: "qwen3:8b" });
    const resolution = await resolveAcpProvider({}, { configDir: dir, makeProvider: make, loadFixture: neverFixture });
    expect(resolution.kind === "ready" && resolution.models !== undefined).toBe(true);
  });
});

// Flow 288, T14 — the review's two endpoint findings.
describe("flow 288 T14 — model choices use the endpoints keryx shell would", () => {
  const make: NonNullable<ResolveAcpProviderDeps["makeProvider"]> = () =>
    ({ describe: () => ({}) } as unknown as ProviderPort);

  test("a saved per-provider endpoint (auth.json baseUrls) is what a switch is built against", async () => {
    const dir = configDir({ provider: "ollama", model: "qwen3:8b", baseUrls: { deepseek: "https://deepseek.internal.example" } });
    const built: (string | undefined)[] = [];
    const source = shellModelSource(
      { providerId: "ollama", modelId: "qwen3:8b" },
      {
        configDir: dir,
        makeProvider: (name, model, baseUrl) => {
          if (name === "deepseek") built.push(baseUrl);
          return make(name, model, baseUrl);
        },
        detect: async () => [{ name: "deepseek", models: ["deepseek-chat"], baseUrl: "https://api.deepseek.com" }],
        modelsFor: async (provider) => provider.models,
      },
    );
    const choice = (await source.choices()).find((entry) => entry.value === "deepseek/deepseek-chat");
    expect(choice?.baseUrl).toBe("https://deepseek.internal.example");
    built.length = 0;
    await source.bind(choice!);
    expect(built).toEqual(["https://deepseek.internal.example"]);
  });

  test("the Ollama probe uses the --base-url flag only — never the saved launch provider's endpoint — and is bounded", async () => {
    const dir = configDir({});
    const probed: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      probed.push(String(input));
      signals.push(init?.signal ?? undefined);
      throw new Error("offline");
    }) as unknown as typeof fetch;
    try {
      const launch = { providerId: "deepseek", modelId: "deepseek-chat", baseUrl: "https://gateway.example" };
      const deps = { configDir: dir, makeProvider: make, modelsFor: async () => [] as string[] };
      await shellModelSource(launch, deps).choices();
      expect(probed.filter((url) => url.endsWith("/api/tags"))).toEqual(["http://localhost:11434/api/tags"]);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      probed.length = 0;
      await shellModelSource(launch, { ...deps, probeBaseUrl: "http://127.0.0.1:9" }).choices();
      expect(probed.filter((url) => url.endsWith("/api/tags"))).toEqual(["http://127.0.0.1:9/api/tags"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
