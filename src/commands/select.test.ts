// RED tests for provider/model detection + the interactive numbered picker
// (flow 022, T5 / AC1-AC2, R2-4 interactive CLI/TUI).
//
// Pins `src/commands/select.ts`'s `detectProviders` + `pickProviderModel`
// surface (T6 implements it to make this suite GREEN). See
// `.metaproject/flows/022-2026-07-13-keryx-r2-4-tui/{context.md,
// acceptance-criteria.md}` (AC1-AC2) for the frozen scope.
//
// `src/commands/select.ts` does NOT exist yet; until then the missing-module
// import is the expected RED failure for the WHOLE file (every test below
// fails identically at import time — this is NOT a per-test bug).
//
// PINNED API (T6 implements exactly this surface):
//   export interface DetectedProvider { name: "ollama" | "anthropic" | "fake"; models: string[]; baseUrl?: string }
//   export interface DetectProvidersDeps { fetch: typeof fetch; env: Record<string, string | undefined>; baseUrl?: string }
//   export async function detectProviders(deps: DetectProvidersDeps): Promise<DetectedProvider[]>;
//   export async function pickProviderModel(io: ShellIO, detected: DetectedProvider[]): Promise<{ provider: string; model: string; baseUrl?: string }>;
//
// PINNED CONTRACT (unpinned before this dispatch; fixed here so T6 and this
// suite agree):
//
//   detectProviders:
//     - ollama: `GET {deps.baseUrl ?? "http://localhost:11434"}/api/tags`
//       (mirrors `OllamaProvider`'s `DEFAULT_BASE_URL`). Parses the recorded
//       `{ models: [{ name, details: { family, ... } }] }` shape. A model is
//       an EMBEDDING model (excluded from the returned chat `models` list)
//       when its `details.family` (case-insensitive) contains "embed" or
//       "bert", OR its `name` (case-insensitive) contains "embed"; every
//       other model is a chat model. If `deps.fetch` THROWS (connection
//       refused) or resolves non-2xx, `ollama` is simply OMITTED from the
//       result — fail-SOFT, `detectProviders` never throws.
//     - anthropic: present ONLY when `deps.env.ANTHROPIC_API_KEY` is a
//       non-empty string; its `models` is a non-empty STATIC list of
//       "claude-*" ids. No network call is made for anthropic detection (no
//       key-authenticated live lookup) — the credential is read from `env`
//       only, never placed on the returned `DetectedProvider` (whose shape
//       has no field for it), never logged.
//     - fake: ALWAYS present with a non-empty static `models` list.
//     - Deterministic: two calls with equivalent deps (fresh `Response`
//       instances supplying the SAME body) deep-equal.
//
//   pickProviderModel:
//     - Renders a numbered provider menu to `io.write`, reads a choice line
//       from `io.lines`; then renders a numbered model menu for the chosen
//       provider and reads a choice line. A non-numeric / out-of-range
//       choice at EITHER stage writes a visible "invalid" message to
//       `io.write` and RE-PROMPTS (reads the next `io.lines` line) — it never
//       throws.
//     - SAFE FALLBACK: if `io.lines` reaches EOF before a valid choice is
//       made at any stage, `pickProviderModel` resolves deterministically to
//       `detected[0]`'s provider and `detected[0].models[0]` (this assumes
//       `detected` is non-empty, which AC1 guarantees since `fake` is always
//       present) rather than throwing or hanging.
//     - Resolves `{ provider, model, baseUrl }`, with `baseUrl` carried from
//       the chosen `DetectedProvider` and OMITTED (not set to `undefined`)
//       when that provider has none.
//
// OFFLINE / DETERMINISTIC: `fetch` and `env` are always injected; no real
// network, no real TTY/stdin, no `Date.now`/`Math.random` anywhere in this
// file.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
// PINNED API (RED: module does not exist until T6).
import type { DetectedProvider, DetectProvidersDeps } from "./select";
import { detectProviders, fetchOpenRouterModels, pickAgentMode, pickProviderModel } from "./select";
import type { ShellIO } from "./shell";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "ollama-api-tags.recorded.json");
const FIXTURE_BODY = readFileSync(FIXTURE_PATH, "utf8");

/** Guarded lookup — throws with a clear message instead of an undefined access. */
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** An async iterable of input lines, in order, then EOF (mirrors shell.test.ts). */
async function* linesFrom(...lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}

/** A `fetch` stub returning a FRESH `Response` (body/status fixed) on every call. */
function fixedFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

/** A `fetch` stub that always throws (simulates connection refused / DNS failure). */
function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** A `fetch` stub that records every requested URL and returns a fixed `Response`. */
function capturingFetch(body: string, status = 200): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    urls.push(String(input));
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, urls };
}

describe("AC1 — detectProviders: ollama /api/tags, env-gated anthropic, always-on fake", () => {
  test("ollama lists ONLY chat models from the recorded /api/tags fixture (embedding excluded)", async () => {
    const deps: DetectProvidersDeps = { fetch: fixedFetch(FIXTURE_BODY), env: {} };
    const detected = await detectProviders(deps);
    const ollama = must(
      detected.find((d) => d.name === "ollama"),
      "expected an ollama entry when /api/tags succeeds",
    );
    expect(ollama.models).toEqual(["llama3.1:latest"]);
  });

  test("ollama is omitted (fail-SOFT, never throws) when fetch throws — connection refused", async () => {
    const deps: DetectProvidersDeps = { fetch: throwingFetch("ECONNREFUSED"), env: {} };
    const detected = await detectProviders(deps);
    expect(detected.find((d) => d.name === "ollama")).toBeUndefined();
  });

  test("ollama is omitted (fail-SOFT, never throws) when /api/tags resolves non-2xx", async () => {
    const deps: DetectProvidersDeps = { fetch: fixedFetch("", 500), env: {} };
    const detected = await detectProviders(deps);
    expect(detected.find((d) => d.name === "ollama")).toBeUndefined();
  });

  test("ollama probe targets the configured baseUrl's /api/tags", async () => {
    const { fetch: fetchFn, urls } = capturingFetch(FIXTURE_BODY);
    const detected = await detectProviders({ fetch: fetchFn, env: {}, baseUrl: "http://localhost:9999" });
    expect(urls).toEqual(["http://localhost:9999/api/tags"]);
    const ollama = must(
      detected.find((d) => d.name === "ollama"),
      "expected an ollama entry",
    );
    expect(ollama.baseUrl).toBe("http://localhost:9999");
  });

  test("ollama probe defaults to http://localhost:11434 when no baseUrl is configured", async () => {
    const { fetch: fetchFn, urls } = capturingFetch(FIXTURE_BODY);
    await detectProviders({ fetch: fetchFn, env: {} });
    expect(urls).toEqual(["http://localhost:11434/api/tags"]);
  });

  test("anthropic is present with a non-empty claude-* model list when ANTHROPIC_API_KEY is set", async () => {
    const deps: DetectProvidersDeps = {
      fetch: fixedFetch("", 500), // ollama unreachable — irrelevant to this assertion
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
    };
    const detected = await detectProviders(deps);
    const anthropic = must(
      detected.find((d) => d.name === "anthropic"),
      "expected an anthropic entry when ANTHROPIC_API_KEY is set",
    );
    expect(anthropic.models.length).toBeGreaterThan(0);
    expect(anthropic.models.every((m) => m.startsWith("claude-"))).toBe(true);
  });

  test("anthropic is absent when ANTHROPIC_API_KEY is unset", async () => {
    const deps: DetectProvidersDeps = { fetch: fixedFetch("", 500), env: {} };
    const detected = await detectProviders(deps);
    expect(detected.find((d) => d.name === "anthropic")).toBeUndefined();
  });

  test("anthropic detection makes NO network call — static list only, credential never leaves env", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    const deps: DetectProvidersDeps = { fetch: fetchFn, env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" } };
    const detected = await detectProviders(deps);
    // Exactly one fetch call total — the ollama /api/tags probe. Anthropic
    // detection itself issues zero additional calls (no live/key-authenticated lookup).
    expect(calls).toBe(1);
    const anthropic = must(
      detected.find((d) => d.name === "anthropic"),
      "expected an anthropic entry",
    );
    // The returned shape carries no credential field at all.
    expect(Object.keys(anthropic)).not.toContain("apiKey");
  });

  test("fake is ALWAYS present with a non-empty model list", async () => {
    const deps: DetectProvidersDeps = { fetch: fixedFetch("", 500), env: {} };
    const detected = await detectProviders(deps);
    const fake = must(
      detected.find((d) => d.name === "fake"),
      "expected a fake entry always",
    );
    expect(fake.models.length).toBeGreaterThan(0);
  });

  test("is deterministic: two calls with equivalent deps deep-equal (no Date.now/Math.random)", async () => {
    const makeDeps = (): DetectProvidersDeps => ({
      fetch: fixedFetch(FIXTURE_BODY),
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
    });
    const first = await detectProviders(makeDeps());
    const second = await detectProviders(makeDeps());
    expect(first).toEqual(second);
  });
});

describe("SSRF guard on the ollama probe baseUrl (review-hardening fix #1)", () => {
  // RED today: `probeOllamaModels` issues `deps.fetch` unconditionally, with no
  // check against `isPrivateEgressHost`/`isLoopbackHost` (`src/harness/mutation/
  // guard.ts`). The fix must consult that guard BEFORE fetching, and OMIT ollama
  // (fail-soft, `detectProviders` still never throws) without ever dialing a
  // private/metadata host — LOOPBACK must remain unblocked (Ollama's own default
  // is loopback).
  test("a metadata-service baseUrl (169.254.169.254) omits ollama AND issues NO fetch to that host", async () => {
    const { fetch: fetchFn, urls } = capturingFetch(FIXTURE_BODY);
    const deps: DetectProvidersDeps = { fetch: fetchFn, env: {}, baseUrl: "http://169.254.169.254" };

    const detected = await detectProviders(deps);

    expect(detected.find((d) => d.name === "ollama")).toBeUndefined();
    expect(urls).toEqual([]);
  });

  test("a private RFC1918 baseUrl (10.0.0.5) omits ollama AND issues NO fetch to that host", async () => {
    const { fetch: fetchFn, urls } = capturingFetch(FIXTURE_BODY);
    const deps: DetectProvidersDeps = { fetch: fetchFn, env: {}, baseUrl: "http://10.0.0.5:11434" };

    const detected = await detectProviders(deps);

    expect(detected.find((d) => d.name === "ollama")).toBeUndefined();
    expect(urls).toEqual([]);
  });

  test("a loopback baseUrl (localhost) is NOT over-blocked: ollama is still probed and present", async () => {
    const { fetch: fetchFn, urls } = capturingFetch(FIXTURE_BODY);
    const deps: DetectProvidersDeps = { fetch: fetchFn, env: {}, baseUrl: "http://localhost:11434" };

    const detected = await detectProviders(deps);

    expect(urls).toEqual(["http://localhost:11434/api/tags"]);
    const ollama = must(
      detected.find((d) => d.name === "ollama"),
      "expected an ollama entry — loopback must not be over-blocked by the SSRF guard",
    );
    expect(ollama.models).toEqual(["llama3.1:latest"]);
  });

  test("a loopback baseUrl (127.0.0.1) is NOT over-blocked: ollama is still probed and present", async () => {
    const { fetch: fetchFn, urls } = capturingFetch(FIXTURE_BODY);
    const deps: DetectProvidersDeps = { fetch: fetchFn, env: {}, baseUrl: "http://127.0.0.1:11434" };

    const detected = await detectProviders(deps);

    expect(urls).toEqual(["http://127.0.0.1:11434/api/tags"]);
    const ollama = must(
      detected.find((d) => d.name === "ollama"),
      "expected an ollama entry — loopback must not be over-blocked by the SSRF guard",
    );
    expect(ollama.models).toEqual(["llama3.1:latest"]);
  });
});

describe("AC2 — pickProviderModel: numbered picker, invalid-input safe, no hardcoded default", () => {
  const SAMPLE_DETECTED: DetectedProvider[] = [
    { name: "ollama", models: ["llama3.1:latest"], baseUrl: "http://localhost:11434" },
    { name: "fake", models: ["fake-a", "fake-b"] },
  ];

  test("renders provider + model menus and returns the chosen {provider, model, baseUrl}", async () => {
    const writes: string[] = [];
    const io: ShellIO = { lines: linesFrom("1", "1"), write: (s: string) => writes.push(s) };

    const result = await pickProviderModel(io, SAMPLE_DETECTED);

    expect(result).toEqual({ provider: "ollama", model: "llama3.1:latest", baseUrl: "http://localhost:11434" });
    const output = writes.join("");
    expect(output).toContain("ollama");
    expect(output).toContain("fake");
    expect(output).toContain("llama3.1:latest");
  });

  test("selecting the second provider + second model returns it, with baseUrl omitted (not present)", async () => {
    const io: ShellIO = { lines: linesFrom("2", "2"), write: () => {} };

    const result = await pickProviderModel(io, SAMPLE_DETECTED);

    expect(result.provider).toBe("fake");
    expect(result.model).toBe("fake-b");
    expect(result.baseUrl).toBeUndefined();
  });

  test("a non-numeric / out-of-range PROVIDER choice re-prompts instead of throwing", async () => {
    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("abc", "9", "1", "1"), // non-numeric, out-of-range, then valid provider + model
      write: (s: string) => writes.push(s),
    };

    const result = await pickProviderModel(io, SAMPLE_DETECTED);

    expect(result).toEqual({ provider: "ollama", model: "llama3.1:latest", baseUrl: "http://localhost:11434" });
    expect(writes.join("")).toMatch(/invalid/i);
  });

  test("a non-numeric / out-of-range MODEL choice re-prompts instead of throwing", async () => {
    const io: ShellIO = { lines: linesFrom("1", "xyz", "1"), write: () => {} };

    const result = await pickProviderModel(io, SAMPLE_DETECTED);

    expect(result).toEqual({ provider: "ollama", model: "llama3.1:latest", baseUrl: "http://localhost:11434" });
  });

  test("EOF before any valid choice falls back deterministically to detected[0] (safe fallback, never throws/hangs)", async () => {
    const io: ShellIO = { lines: linesFrom("abc", "xyz"), write: () => {} }; // never a valid number, then EOF

    const result = await pickProviderModel(io, SAMPLE_DETECTED);

    expect(result).toEqual({ provider: "ollama", model: "llama3.1:latest", baseUrl: "http://localhost:11434" });
  });

  test("is deterministic given the same detected list and inputs", async () => {
    const io1: ShellIO = { lines: linesFrom("1", "1"), write: () => {} };
    const io2: ShellIO = { lines: linesFrom("1", "1"), write: () => {} };

    const r1 = await pickProviderModel(io1, SAMPLE_DETECTED);
    const r2 = await pickProviderModel(io2, SAMPLE_DETECTED);

    expect(r1).toEqual(r2);
  });
});

describe("flow 053 — pickAgentMode: agent/chat menu, agent default", () => {
  test("choice 1 selects agent (true)", async () => {
    const writes: string[] = [];
    const io: ShellIO = { lines: linesFrom("1"), write: (s) => writes.push(s) };
    expect(await pickAgentMode(io)).toBe(true);
    expect(writes.join("")).toMatch(/agent/);
    expect(writes.join("")).toMatch(/chat/);
  });

  test("choice 2 selects chat (false)", async () => {
    const io: ShellIO = { lines: linesFrom("2"), write: () => {} };
    expect(await pickAgentMode(io)).toBe(false);
  });

  test("bare Enter (empty line) defaults to agent (true)", async () => {
    const io: ShellIO = { lines: linesFrom(""), write: () => {} };
    expect(await pickAgentMode(io)).toBe(true);
  });

  test("EOF before any choice defaults to agent (true)", async () => {
    const io: ShellIO = { lines: linesFrom(), write: () => {} };
    expect(await pickAgentMode(io)).toBe(true);
  });

  test("re-prompts on invalid input, then honors a valid choice", async () => {
    const writes: string[] = [];
    const io: ShellIO = { lines: linesFrom("x", "9", "2"), write: (s) => writes.push(s) };
    expect(await pickAgentMode(io)).toBe(false);
    expect(writes.join("")).toMatch(/invalid/i);
  });
});

test("flow 083: fetchOpenRouterModels parses /v1/models (sorted, deduped); falls back on failure", async () => {
  const okFetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "z/m" }, { id: "a/m" }, { id: "a/m" }, { id: 42 }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  expect(await fetchOpenRouterModels(okFetch)).toEqual(["a/m", "z/m"]);

  const badFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  expect(await fetchOpenRouterModels(badFetch)).toContain("openai/gpt-4o-mini"); // curated fallback

  const throwFetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await fetchOpenRouterModels(throwFetch)).toContain("openai/gpt-4o-mini");
});

test("flow 078: openrouter is ALWAYS offered (key entered at use time; no network probe)", async () => {
  const withKey = await detectProviders({ fetch: throwingFetch("no ollama"), env: { OPENROUTER_API_KEY: "sk-or-x" } });
  const openrouter = withKey.find((d) => d.name === "openrouter");
  expect(openrouter?.models).toContain("openai/gpt-4o-mini");
  expect(openrouter?.baseUrl).toBe("https://openrouter.ai/api");

  // Present even without a key — the interactive shell prompts for it.
  const without = await detectProviders({ fetch: throwingFetch("no ollama"), env: {} });
  expect(without.find((d) => d.name === "openrouter")?.models).toContain("openai/gpt-4o-mini");
});
