// RED tests for review-polish item B (flow 028/T5): a shared `makeProvider`
// factory de-duplicating the provider-selection switch presently copy-pasted
// across `src/commands/shell.ts` (`realMakeProvider`) and
// `src/commands/harness.ts` (`harnessCommand`'s inline
// `if (provider === "anthropic") ... else if (provider === "ollama") ... else`
// block) — INCLUDING the anthropic-without-`ANTHROPIC_API_KEY` fallback to an
// offline no-op `FakeProvider` (never a network attempt without a credential,
// mirroring both existing call sites verbatim).
//
// `src/harness/provider/make-provider.ts` does not exist yet (T6's job) — the
// missing-module import below is the expected RED failure ("Cannot find
// module './make-provider'"), NOT a bug in this test file. Do NOT create
// make-provider.ts here.
//
// ---------------------------------------------------------------------------
// PINNED SIGNATURE (T6 impl must match; state any deviation loudly in review):
//
//   export interface MakeProviderOpts {
//     fetch: typeof fetch;
//     env?: Record<string, string | undefined>;   // defaults to process.env
//     baseUrl?: string;                             // ollama loopback base url
//   }
//   export function makeProvider(
//     name: string,
//     model: string,
//     opts: MakeProviderOpts,
//   ): ProviderPort;
//
// Cases (mirroring `shell.ts`'s `realMakeProvider` / `harness.ts`'s inline
// switch, both read before writing this suite):
//   - "anthropic" + `opts.env.ANTHROPIC_API_KEY` present (non-empty) -> an
//     `AnthropicProvider` (`describe().descriptor.providerId === "anthropic"`).
//   - "anthropic" + NO `ANTHROPIC_API_KEY` (absent or empty string) -> the
//     offline `FakeProvider` fallback — never constructs `AnthropicProvider`,
//     never touches the network (fail-closed on a missing credential).
//   - "ollama" -> an `OllamaProvider`
//     (`describe().descriptor.providerId === "ollama"`).
//   - "fake" (or any unrecognized provider name) -> a `FakeProvider`
//     (`describe().descriptor.providerId === "fake-provider"`), mirroring the
//     existing unconditional `else` branch in both call sites.
//
// `model` is accepted for forward-compatibility (mirrors both call sites,
// which already take a model argument even though today's provider
// construction does not vary by model) but is NOT asserted on here.
//
// Deterministic + offline: `opts.fetch` is a stub that throws if ever called
// (mirrors `executor.test.ts`'s `withFetchGuard`) — `makeProvider` must never
// invoke fetch merely by CONSTRUCTING a provider.
import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "./anthropic/anthropic-provider";
import { FakeProvider } from "./fake-provider";
import { OllamaProvider } from "./ollama/ollama-provider";

// PINNED API under test — T6 impl exports these; import fails until then
// (expected RED: "Cannot find module './make-provider'").
import { makeProvider } from "./make-provider";
import type { MakeProviderOpts } from "./make-provider";

/** A fetch stub that throws if ever called — constructing a provider must never reach the network. */
function neverCalledFetch(): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) => {
    throw new Error(
      `makeProvider must never call fetch merely by constructing a provider (args: ${JSON.stringify(args)})`,
    );
  }) as unknown as typeof fetch;
}

function makeOpts(overrides: Partial<MakeProviderOpts> = {}): MakeProviderOpts {
  return { fetch: neverCalledFetch(), env: {}, ...overrides };
}

describe("makeProvider — shared provider-selection factory (review-polish item B, DRY)", () => {
  test('"anthropic" WITH ANTHROPIC_API_KEY constructs an AnthropicProvider', () => {
    const provider = makeProvider(
      "anthropic",
      "claude-x",
      makeOpts({ env: { ANTHROPIC_API_KEY: "test-key-1" } }),
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.describe().descriptor.providerId).toBe("anthropic");
  });

  test('"anthropic" WITHOUT ANTHROPIC_API_KEY falls back to the offline FakeProvider (never AnthropicProvider, never network)', () => {
    const provider = makeProvider("anthropic", "claude-x", makeOpts({ env: {} }));
    expect(provider).not.toBeInstanceOf(AnthropicProvider);
    expect(provider).toBeInstanceOf(FakeProvider);
    expect(provider.describe().descriptor.providerId).toBe("fake-provider");
  });

  test('"anthropic" with an EMPTY-STRING ANTHROPIC_API_KEY also falls back to the fake provider (fail-closed, not a truthy empty string)', () => {
    const provider = makeProvider("anthropic", "claude-x", makeOpts({ env: { ANTHROPIC_API_KEY: "" } }));
    expect(provider).toBeInstanceOf(FakeProvider);
  });

  test('"ollama" constructs an OllamaProvider', () => {
    const provider = makeProvider("ollama", "llama3", makeOpts());
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.describe().descriptor.providerId).toBe("ollama");
  });

  test('"fake" constructs a FakeProvider', () => {
    const provider = makeProvider("fake", "fake-echo", makeOpts());
    expect(provider).toBeInstanceOf(FakeProvider);
    expect(provider.describe().descriptor.providerId).toBe("fake-provider");
  });

  test("an unrecognized provider name falls back to a FakeProvider (mirrors the existing unconditional else-branch in both call sites)", () => {
    const provider = makeProvider("totally-unknown", "whatever", makeOpts());
    expect(provider).toBeInstanceOf(FakeProvider);
  });
});

// --- flow 047: openrouter provider ------------------------------------------

test("openrouter with a key constructs the OpenAI-compatible network provider", () => {
  const provider = makeProvider(
    "openrouter",
    "openai/gpt-4o-mini",
    makeOpts({ env: { OPENROUTER_API_KEY: "sk-or-xxx" } }),
  );
  expect(provider.describe().descriptor.providerId).toBe("ollama");
});

test("openrouter without a key falls back to the offline FakeProvider (fail-closed)", () => {
  const provider = makeProvider("openrouter", "m", makeOpts({ env: {} }));
  expect(provider.describe().descriptor.providerId).toBe("fake-provider");
});

// --- flow 085: additional OpenAI-compatible registry providers --------------

test("deepseek with DEEPSEEK_API_KEY constructs the OpenAI-compatible network provider", () => {
  const provider = makeProvider("deepseek", "deepseek-chat", makeOpts({ env: { DEEPSEEK_API_KEY: "sk-ds" } }));
  expect(provider.describe().descriptor.providerId).toBe("ollama");
});

test("deepseek / zai / cerebras / groq / moonshot WITHOUT their key fail closed to FakeProvider", () => {
  for (const name of ["deepseek", "zai", "cerebras", "groq", "moonshot"]) {
    const provider = makeProvider(name, "m", makeOpts({ env: {} }));
    expect(provider.describe().descriptor.providerId).toBe("fake-provider");
  }
});

test("zai (GLM) constructs a network provider from ZAI_API_KEY (versioned coding endpoint via chatPath)", () => {
  const provider = makeProvider("zai", "glm-4.6", makeOpts({ env: { ZAI_API_KEY: "sk-zai" } }));
  expect(provider.describe().descriptor.providerId).toBe("ollama");
});

// --- flow 090: credential-scoped child construction (AC4) -------------------

describe("makeProvider — scoped credentials (flow 090, AC4)", () => {
  test("opts.credentials supplies the key (constructs the network provider)", () => {
    const provider = makeProvider(
      "anthropic",
      "claude-opus-4-8",
      makeOpts({ credentials: { ANTHROPIC_API_KEY: "scoped-key" } }),
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  test("opts.credentials takes precedence over opts.env — ambient env is NOT consulted", () => {
    // env has the key, but the empty scoped credential map wins => fail-closed to Fake.
    const provider = makeProvider(
      "anthropic",
      "claude-opus-4-8",
      makeOpts({ env: { ANTHROPIC_API_KEY: "ambient-key" }, credentials: {} }),
    );
    expect(provider).toBeInstanceOf(FakeProvider);
    expect(provider.describe().descriptor.providerId).toBe("fake-provider");
  });

  test("a child granted only ollama cannot construct a network provider it wasn't granted", () => {
    const provider = makeProvider(
      "deepseek",
      "deepseek-chat",
      makeOpts({ credentials: { OLLAMA: "n/a" } }),
    );
    expect(provider).toBeInstanceOf(FakeProvider);
  });
});
