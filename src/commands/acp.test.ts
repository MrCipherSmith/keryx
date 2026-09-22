// `keryx acp` provider resolution (flow 287, AC1/AC2).
//
// The defect this pins: `parseArgs` used to default to `provider = "fake"`, so
// an editor launching `keryx acp` with no flags got `FakeProvider` and the
// operator's first real message failed with "no transcript matches request
// hash". Every test here runs against a temp config directory — never the
// developer's own `auth.json`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeProvider } from "../harness/provider/fake-provider";
import { OllamaProvider } from "../harness/provider/ollama/ollama-provider";
import type { ProviderPort } from "../harness/provider/types";
import { parseAcpArgs, resolveAcpProvider, shellGrantRefresh, type ResolveAcpProviderDeps } from "./acp";
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
