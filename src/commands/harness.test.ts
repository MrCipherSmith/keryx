// RED tests for the `keryx harness run` CLI (flow 020, T5 / AC4).
//
// Pins `harnessCommand` (`src/commands/harness.ts`, registered in
// `src/cli.ts` by T6): `keryx harness run --provider <fake|anthropic|ollama>
// --model <m> [--base-url <url>] "<prompt>"` assembles `runOffline` with real
// deps and the selected provider, printing the normalized events / final text
// / completion / evidence. See `.metaproject/flows/020-2026-07-13-keryx-
// harness-ollama-cli/{context.md,acceptance-criteria.md}` (AC4) for the
// frozen scope.
//
// `src/commands/harness.ts` does NOT exist yet (T6 implements it to make this
// suite GREEN); until then the missing-module import is the expected RED
// failure for the WHOLE file (every test below fails identically at import
// time — this is NOT a per-test bug).
//
// PINNED API (T6 implements exactly this surface — see subagent-result):
//   export interface HarnessCommandDeps {
//     fetch?: typeof fetch;
//     clock?: () => string;
//     idSeq?: () => string;
//     env?: Record<string, string | undefined>;
//   }
//   export async function harnessCommand(args: string[], deps?: HarnessCommandDeps): Promise<void>;
// `deps` is OPTIONAL (a real CLI invocation supplies none and falls back to
// `globalThis.fetch` / wall-clock / `process.env`); every test below supplies
// an explicit `deps` so the run stays OFFLINE and deterministic. The command's
// LAST `console.log` call prints a single JSON-stringified structured result
// with `events` (array) / `text` (string) / `completion` (object) / `evidence`
// (array) — the "fake" path never reaches the network, so a matching-fixture
// failure surfaces as a structured (non-throwing) result, never an uncaught
// exception.
//
// OFFLINE / DETERMINISTIC: `fetch` is always injected via `deps.fetch`; no
// test touches `globalThis.fetch` except to prove it is left untouched. No
// `Date.now()` / `Math.random()` in this file (a fixed `clock`/`idSeq` is
// injected for the "fake" path).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
// PINNED API (RED: module does not exist until T6).
import type { HarnessCommandDeps } from "./harness";
import { harnessCommand } from "./harness";

/** Records call count and always throws — proves a code path never reaches the network. */
function makeThrowingFetch(): { fetch: typeof fetch; callCount: () => number } {
  let calls = 0;
  const fn = async (): Promise<Response> => {
    calls += 1;
    throw new Error("network must not be reached by this test path");
  };
  return { fetch: fn as unknown as typeof fetch, callCount: () => calls };
}

/** Patches `console.log` to capture every call's stringified arguments. */
function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

/** Parse the LAST captured console.log line as JSON (the pinned structured-result contract). */
function lastJson(logs: string[]): Record<string, unknown> {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (line === undefined) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not this line; keep scanning backwards.
    }
  }
  throw new Error(`no JSON-parseable console.log line found among: ${JSON.stringify(logs)}`);
}

let counter = 0;
function fixedDeps(overrides?: Partial<HarnessCommandDeps>): HarnessCommandDeps {
  counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
    ...overrides,
  };
}

describe("AC4 — keryx harness run --provider fake runs fully offline and prints a structured result", () => {
  test("assembles runOffline and prints events/text/completion/evidence; fetch is NEVER invoked", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "hello there"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    expect(logs.length).toBeGreaterThan(0);

    const result = lastJson(logs);
    expect(Array.isArray(result.events)).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.completion).toBeDefined();
    expect(result.completion).not.toBeNull();
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  test("never touches the global fetch on the fake path", async () => {
    const originalFetch = globalThis.fetch;
    let globalFetchCalled = false;
    // biome-ignore lint: intentional structural network-call detector for this test only.
    globalThis.fetch = (() => {
      globalFetchCalled = true;
      throw new Error("harnessCommand must not touch globalThis.fetch on the fake path.");
    }) as unknown as typeof fetch;

    const { fetch: fetchMock } = makeThrowingFetch();
    const { restore } = captureConsoleLog();
    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model", "offline check"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
    }

    expect(globalFetchCalled).toBe(false);
  });
});

describe("AC4 — keryx harness run --provider anthropic with no ANTHROPIC_API_KEY fails closed with NO network", () => {
  test("prints a clear fail-closed message mentioning ANTHROPIC_API_KEY; fetch is NEVER invoked", async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "anthropic", "--model", "claude-3-5-sonnet-20241022", "hello"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n").toLowerCase();
    expect(combined.includes("anthropic_api_key")).toBe(true);
    // A clear fail-closed signal: some recognizable failure/refusal wording.
    expect(/fail|refus|denied|missing|require|not set/.test(combined)).toBe(true);
  });
});

describe("AC4 (flow 021, T5) — `keryx harness run` UX fix: empty/missing --provider or prompt prints usage, no run", () => {
  test('"run" with no other args (no --provider, no prompt) prints usage and never runs runOffline', async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(["run"], fixedDeps({ fetch: fetchMock, env: {} }));
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("Usage: keryx harness run");
    // Must NOT have fallen through to a structured (blocked/failed) run result.
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
  });

  test('"run" with an empty --provider prints usage and never runs runOffline', async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "", "--model", "fixture-model", "hello there"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("Usage: keryx harness run");
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
  });

  test('"run" with an empty prompt prints usage and never runs runOffline', async () => {
    const { fetch: fetchMock, callCount } = makeThrowingFetch();
    const { logs, restore } = captureConsoleLog();

    try {
      await harnessCommand(
        ["run", "--provider", "fake", "--model", "fixture-model"],
        fixedDeps({ fetch: fetchMock, env: {} }),
      );
    } finally {
      restore();
    }

    expect(callCount()).toBe(0);
    const combined = logs.join("\n");
    expect(combined).toContain("Usage: keryx harness run");
    expect(/"status"\s*:\s*"(blocked|failed)"/.test(combined)).toBe(false);
  });
});

describe("AC4 — src/cli.ts registers the harness command (source-text audit)", () => {
  test("the root CLI dispatch mentions the harness command", () => {
    const cliSource = readFileSync(path.join(import.meta.dir, "..", "cli.ts"), "utf8");
    expect(/harness/i.test(cliSource)).toBe(true);
  });
});

describe("D-02 invariant — the harness CLI never writes flow.json (source-text audit)", () => {
  test("src/commands/harness.ts contains no flow.json write reference", () => {
    const source = readFileSync(path.join(import.meta.dir, "harness.ts"), "utf8");
    expect(/flow\.json/i.test(source)).toBe(false);
  });
});
