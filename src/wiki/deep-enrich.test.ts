// Tests for `enrichPageDeep` (flow 169 T6, TRD §1.3/§1.4).
//
// Follows the same offline injection pattern `enrich.ts`'s own tests use for
// `providerFactory`/`fetch` (deterministic, no live model credentials) and the
// `scriptedProvider` pattern from `commands/agent.test.ts` for driving
// `runAgentTurn` through canned event sequences.

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildDeepEnrichTools,
  DEEP_ENRICH_OPS,
  enrichPageDeep,
  type EnrichPageDeepInput,
} from "./deep-enrich";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort } from "../harness/provider/types";
import type { ProviderFactory } from "../harness/provider/single-turn";
import type { WikiPage } from "./types";

const PAGE: WikiPage = {
  absolutePath: "/tmp/does-not-matter.md",
  relativePath: "components/example.md",
  pageType: "component",
  title: "Example",
  version: "0.1.0",
  type: "component",
  status: "draft",
  summary: "An example component.",
};

function fixedIdSeq(): () => string {
  let n = 0;
  return () => `id-${n++}`;
}

function baseInput(overrides: Partial<EnrichPageDeepInput> = {}): EnrichPageDeepInput {
  return {
    cwd: process.cwd(),
    page: PAGE,
    original: "---\nTitle: Example\nStatus: draft\n---\n\n# Example\n\nStub.\n",
    systemPrompt: "You are a technical writer.",
    provider: "anthropic",
    model: "claude-test",
    maxToolCalls: 5,
    maxRuntimeMs: 5_000,
    idSeq: fixedIdSeq(),
    clock: () => "2026-08-18T00:00:00.000Z",
    env: { ANTHROPIC_API_KEY: "test-key" },
    ...overrides,
  };
}

// A minimal scripted ProviderPort mirroring `commands/agent.test.ts`'s
// `scriptedProvider` helper — each `stream()` call replays the next scripted
// event list.
function scriptedProviderFactory(scripts: Partial<NormalizedEvent>[][]): {
  factory: ProviderFactory;
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "scripted" },
  };
  const provider: ProviderPort = {
    describe: () => description,
    stream: (request, opts) => {
      requests.push(request);
      const events = scripts[call] ?? [];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
  return { factory: () => provider, requests };
}

/** A provider whose `stream()` never yields and never returns (for the timeout test). */
function hangingProviderFactory(): ProviderFactory {
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "scripted" },
  };
  const provider: ProviderPort = {
    describe: () => description,
    stream: () =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await new Promise(() => {
          // never resolves
        });
      })(),
  };
  return () => provider;
}

// --- AC3/FR-6: flat recursion — the exact, construction-level tool grant ---

test("buildDeepEnrichTools grants exactly the DEEP_ENRICH_OPS allowlist and nothing else", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-deep-enrich-"));
  const port = createMetaprojectAdapter(cwd);
  const tools = buildDeepEnrichTools(port);
  const names = tools.map((t) => t.definition.name).sort();
  expect(names).toEqual([...DEEP_ENRICH_OPS].sort());
  expect(names).not.toContain("spawn_subagent");
  expect(names).not.toContain("shell_exec");
  // Every granted tool is read-only by construction (no write/shell/delegate risk).
  for (const tool of tools) {
    expect(tool.definition.risk).toBe("read");
  }
});

// --- Happy path: a tool call round-trip, then a text answer -----------------

test("enrichPageDeep runs a bounded child turn and returns the enriched markdown + tool-call provenance", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-deep-enrich-"));
  const { factory, requests } = scriptedProviderFactory([
    // Round 1: the child calls read_wiki.
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "read_wiki" },
      { kind: "tool_call_end", toolCallId: "c1", input: '{"path":"components/other.md"}' },
      { kind: "model_end" },
    ],
    // Round 2 (after the tool result is fed back): the final page text.
    [
      { kind: "text_delta", text: "---\nTitle: Example\nStatus: accepted\n---\n\n# Example\n\nEnriched body.\n" },
      { kind: "model_end" },
    ],
  ]);

  const result = await enrichPageDeep(baseInput({ cwd, providerFactory: factory }));

  expect("enriched" in result).toBe(true);
  if ("enriched" in result) {
    expect(result.enriched).toContain("Enriched body.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("read_wiki");
    // No wiki page exists at that path in the fresh tmp dir, so the real
    // adapter's read_wiki call resolves to an error result — proving this is
    // a REAL tool invocation through `MetaprojectPort`, not a stub.
    expect(result.toolCalls[0]?.isError).toBe(true);
  }
  // Two model round-trips: the tool-call round, then the text-only round.
  expect(requests).toHaveLength(2);
});

// --- AC5: budget/timeout exhaustion never throws, always falls back --------

test("enrichPageDeep falls back (never throws) when the child exceeds its runtime budget", async () => {
  const result = await enrichPageDeep(
    baseInput({ providerFactory: hangingProviderFactory(), maxRuntimeMs: 50 }),
  );
  expect("fallback" in result).toBe(true);
  if ("fallback" in result) {
    expect(result.fallback).toBe(true);
    expect(result.reason).toMatch(/timed out/i);
    expect(result.partial).toBeUndefined();
  }
});

test("flow 219: deep enrichment composes external cancellation into its provider signal", async () => {
  const external = new AbortController();
  let seenSignal: AbortSignal | undefined;
  let releaseTurn!: () => void;
  const turnMayFinish = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let markStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => {
    markStreamStarted = resolve;
  });
  const providerFactory: ProviderFactory = () => ({
    describe: () => ({
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: false,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "controlled" },
    }),
    stream: (_request, opts) => {
      seenSignal = opts.signal;
      markStreamStarted();
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        await turnMayFinish;
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "late text" };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })();
    },
  });
  const input = {
    ...baseInput({ providerFactory }),
    signal: external.signal,
  } as EnrichPageDeepInput & { signal: AbortSignal };
  const run = enrichPageDeep(input);

  try {
    await streamStarted;
    external.abort("user interrupted deep enrich");
    expect(seenSignal).toBeDefined();
    // Deep still owns its timeout controller, so provider sees a composed
    // signal; aborting the user signal must abort that composition too.
    expect(seenSignal).not.toBe(external.signal);
    expect(seenSignal?.aborted).toBe(true);
  } finally {
    releaseTurn();
    await run;
  }
});

test("enrichPageDeep falls back with no credential and no injected providerFactory", async () => {
  const result = await enrichPageDeep(baseInput({ env: {} }));
  expect("fallback" in result).toBe(true);
  if ("fallback" in result) {
    expect(result.reason).toMatch(/no credential/i);
    expect(result.toolCalls).toEqual([]);
  }
});

// --- T10 (review finding #3): defense in depth against a non-positive     --
// --- maxRuntimeMs that reaches this function unclamped (e.g. bypassing    --
// --- `config.ts`'s clamp via a directly-constructed EnrichPageDeepInput). --
// Before the fix, `maxRuntimeMs <= 0` took the `else { await turn; }`
// branch — no timeout at all — so a `hangingProviderFactory()` turn would
// hang this test forever. It must now resolve immediately with a fallback.

test("enrichPageDeep treats maxRuntimeMs: 0 as already-exhausted, never awaiting unbounded", async () => {
  const result = await enrichPageDeep(
    baseInput({ providerFactory: hangingProviderFactory(), maxRuntimeMs: 0 }),
  );
  expect("fallback" in result).toBe(true);
  if ("fallback" in result) {
    expect(result.fallback).toBe(true);
    expect(result.reason).toMatch(/non-positive/i);
    expect(result.reason).toMatch(/already exhausted/i);
  }
});

test("enrichPageDeep treats a negative maxRuntimeMs as already-exhausted, never awaiting unbounded", async () => {
  const result = await enrichPageDeep(
    baseInput({ providerFactory: hangingProviderFactory(), maxRuntimeMs: -50 }),
  );
  expect("fallback" in result).toBe(true);
  if ("fallback" in result) {
    expect(result.fallback).toBe(true);
    expect(result.reason).toMatch(/non-positive/i);
  }
});

test("enrichPageDeep falls back on an empty model response", async () => {
  const { factory } = scriptedProviderFactory([[{ kind: "model_end" }]]);
  const result = await enrichPageDeep(baseInput({ providerFactory: factory }));
  expect("fallback" in result).toBe(true);
  if ("fallback" in result) {
    expect(result.reason).toMatch(/empty model response/i);
  }
});
