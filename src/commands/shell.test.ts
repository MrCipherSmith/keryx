// RED tests for the interactive `keryx` shell REPL core (flow 021, T5 / AC1-AC2).
//
// Pins an injectable `runShell(io, deps)` core (`src/commands/shell.ts`, T6
// implements it to make this suite GREEN) that reaches NO real
// `process.stdin`/`process.stdout`/TTY: `io` supplies an async line source +
// a write sink, `deps` supplies a `ProviderPort` factory + clock/id + the
// initial provider/model selection. See `.metaproject/flows/
// 021-2026-07-13-keryx-interactive-shell/{context.md,acceptance-criteria.md}`
// (AC1-AC2, "Testable REPL core") for the frozen scope.
//
// `src/commands/shell.ts` does NOT exist yet; until then the missing-module
// import is the expected RED failure for the WHOLE file (every test below
// fails identically at import time — this is NOT a per-test bug).
//
// PINNED API (T6 implements exactly this surface):
//   export interface ShellIO { lines: AsyncIterable<string>; write: (s: string) => void }
//   export interface ShellDeps {
//     makeProvider: (name: string, model: string, baseUrl?: string) => ProviderPort;
//     clock: () => string;
//     idSeq: () => string;
//     initial: { provider: string; model: string; baseUrl?: string };
//   }
//   export async function runShell(io: ShellIO, deps: ShellDeps): Promise<void>;
//   export async function shellCommand(args: string[]): Promise<void>; // thin TTY wrapper, NOT unit-tested here
//
// PINNED CONTRACT (unpinned before this dispatch; fixed here so T6 and this
// suite agree):
//   - `runShell` keeps an in-memory `history: NormalizedMessage[]`, empty at
//     start. Each non-slash-command input line is one "turn": push
//     `{role:"user", content:line}` onto history, build a `NormalizedRequest`
//     whose `messages` is the CURRENT history (i.e. it always includes the
//     just-pushed user line), call `provider.stream(request, opts)`, write
//     every `text_delta.text` to `io.write` as it arrives, and on `model_end`
//     push `{role:"assistant", content: <accumulated text>}` onto history.
//     History therefore grows by exactly 2 entries (user + assistant) per
//     completed turn, and the NEXT turn's request carries the full
//     accumulated history — this is what proves multi-turn without exposing
//     `history` externally.
//   - `deps.makeProvider(provider, model, baseUrl)` is called to obtain the
//     active `ProviderPort`: at least once (using `deps.initial`) before/at
//     the first turn, and again whenever `/model` or `/provider` changes the
//     active selection. The provider instance used for a given turn's
//     `stream()` call reflects whichever (provider, model) selection is
//     active at the time that turn runs; exact call timing (immediately on
//     the slash command vs. lazily before the next turn) is an implementation
//     choice.
//   - Slash commands (never trigger `provider.stream`, except where noted):
//       `/help`            — write help text (mentions the other commands).
//       `/model <m>`       — switch the active model for subsequent turns.
//       `/provider <name>` — switch the active provider for subsequent turns.
//       `/clear`           — reset history to empty.
//       `/exit`, `/quit`   — terminate the loop; `runShell` resolves cleanly.
//   - End-of-input (the `io.lines` async iterable completes without `/exit`)
//     also terminates the loop; `runShell` resolves cleanly (never throws).
//   - A turn whose provider stream yields `provider_error` writes a readable
//     error line via `io.write` and the loop CONTINUES to the next input line
//     (it does not throw/crash the whole session).
//
// Provider wiring note: rather than reverse-engineer `runShell`'s internal
// `NormalizedRequest` shape, tests wrap the real, committed `FakeProvider` in
// a thin local adapter that captures the ACTUAL request `runShell` builds (for
// history/multi-turn assertions) but replays a LOCALLY built, hash-stamped
// request against the underlying `FakeProvider` (same technique as
// `src/harness/run/run.test.ts`'s `fixtureProvider` / `fake-provider.test.ts`'s
// `withMatchingHash`). This keeps the suite decoupled from the unpinned exact
// request-construction shape while still exercising the real `FakeProvider`
// replay behaviour end-to-end.
//
// OFFLINE / DETERMINISTIC: no real `process.stdin`/`stdout`, no network, no
// `Date.now`/`Math.random` — `deps.clock`/`deps.idSeq` are always injected
// fixed stubs.
//
// --- flow 022, T5 / AC3 additions (RED: pins an ADDITIVE `ShellDeps` field
// `runShell` does not implement yet — T6 adds it to `src/commands/shell.ts`).
// See `.metaproject/flows/022-2026-07-13-keryx-r2-4-tui/{context.md,
// acceptance-criteria.md}` (AC3) for the frozen scope.
//
// PINNED SELECTOR SEAM (T6 implements exactly this; chosen to keep `runShell`
// decoupled from `./select`'s `fetch`/`env` plumbing — it only needs the
// bundled detect+pick behaviour as one injected function):
//   export interface ShellDeps {
//     ...(unchanged fields)...
//     selectProviderModel?: (
//       io: ShellIO,
//       opts?: { onlyProvider?: string },
//     ) => Promise<{ provider: string; model: string; baseUrl?: string }>;
//   }
//   - `/models`  calls `deps.selectProviderModel?.(io, { onlyProvider: <current providerName> })`
//     — offers ONLY the current provider's models. On a valid result, `runShell`
//     updates the active provider/model/baseUrl (recreating the provider via
//     the existing `makeActive()` pattern) so the NEXT turn uses it.
//   - `/provider` calls `deps.selectProviderModel?.(io)` (no `onlyProvider`) —
//     a full re-detection/pick across all providers; same update-then-use
//     behaviour.
//   - When `deps.selectProviderModel` is undefined, `/models` and `/provider`
//     write a message containing "not available" and are no-ops — NEVER a
//     crash, NEVER a model turn.
//   - `/connect` needs NO new deps: it writes STATIC guidance mentioning
//     `ANTHROPIC_API_KEY` (how to `export` it) and never reads/echoes any
//     actual credential value.
//   - `shellCommand` (T6, not unit-tested here) wires `selectProviderModel` by
//     composing `./select`'s `detectProviders` + `pickProviderModel` with the
//     real `process.env`/`fetch`, filtering to `opts.onlyProvider` when given.
//
// This file's NEW tests below will not fully typecheck until T6 lands the
// additive `selectProviderModel` field on `ShellDeps` — the same kind of
// expected RED as `select.test.ts`'s missing-module import (a documented gap
// for T6 to fill, not a test bug).

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { FakeProvider, type FakeProviderTranscript, requestHashOf } from "../harness/provider/fake-provider";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";
// PINNED API (RED: module does not exist until T6).
import type { ShellDeps, ShellIO } from "./shell";
import { EXPAND_MAX_LINES, expandedToolOutput, parseShellCliFlags, runShell, shellCommand } from "./shell";
import { blockLabel } from "../lib/md-blocks";

const NO_CAPS: ProviderCapabilities = {
  streaming: false,
  toolCalls: false,
  parallelToolCalls: false,
  structuredOutput: false,
  reasoningMetadata: false,
  promptCaching: false,
  vision: false,
  tokenCounting: false,
  modelListing: false,
};

/** Deterministic fixed clock stub — never `Date.now`. */
function fixedClock(): () => string {
  return () => "2026-01-01T00:00:00.000Z";
}

/** Deterministic monotonic id stub — never `Math.random`/`randomUUID`. */
function fixedIdSeq(): () => string {
  let counter = 0;
  return () => `id-${counter++}`;
}

/** An async iterable of input lines, in order, then EOF. */
async function* linesFrom(...lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}

/** Guarded index access (noUncheckedIndexedAccess-safe) — throws on out-of-bounds. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`index ${index} out of bounds (length ${arr.length})`);
  }
  return value;
}

/** A locally built, fixed `NormalizedRequest` used only to stamp fixture transcripts. */
function buildFixtureRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "fake-provider",
    modelId: "fixture-model",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "fixture" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

/** A fixture transcript that streams `textChunks` as ordered `text_delta`s then finishes. */
function textTranscript(transcriptId: string, textChunks: string[]): FakeProviderTranscript {
  const events: FakeProviderTranscript["events"] = textChunks.map((text, index) => ({
    sequence: index,
    kind: "text_delta" as const,
    payload: { text },
  }));
  events.push({ sequence: textChunks.length, kind: "finish" as const, payload: {} });
  return {
    schemaVersion: 1,
    transcriptId,
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64), // overwritten by capturingFakeProvider's stamping.
    events,
  };
}

/** A fixture transcript that immediately yields a single typed `provider_error`. */
function errorTranscript(
  transcriptId: string,
  error: { kind: string; retryable: boolean; message: string },
): FakeProviderTranscript {
  return {
    schemaVersion: 1,
    transcriptId,
    providerId: "fake-provider",
    providerRevision: "fake-1.0.0",
    requestHash: "0".repeat(64), // overwritten by capturingFakeProvider's stamping.
    events: [{ sequence: 0, kind: "error" as const, payload: error }],
  };
}

/**
 * Wraps the real, committed `FakeProvider` so `runShell`'s internal request
 * shape never has to match a fixture's `requestHash` (see file header): each
 * call to `stream()` captures the ACTUAL request `runShell` built (for
 * history/multi-turn assertions) into `captured`, then replays the Nth
 * configured transcript (by call order) against a locally built, hash-stamped
 * request so the real `FakeProvider` replay logic still runs end-to-end.
 */
function capturingFakeProvider(transcripts: FakeProviderTranscript[]): {
  provider: ProviderPort;
  captured: NormalizedRequest[];
} {
  const captured: NormalizedRequest[] = [];
  let callIndex = 0;
  const instances = transcripts.map((transcript, index) => {
    const fixedRequest = buildFixtureRequest(`fixture-${index}`);
    const stamped: FakeProviderTranscript = { ...transcript, requestHash: requestHashOf(fixedRequest) };
    return { fake: new FakeProvider([stamped]), fixedRequest };
  });
  const provider: ProviderPort = {
    describe: () => {
      const first = instances[0];
      if (first === undefined) {
        throw new Error("capturingFakeProvider: no transcripts configured");
      }
      return first.fake.describe();
    },
    stream: (request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> => {
      captured.push(request);
      const entry = instances[callIndex] ?? instances[instances.length - 1];
      callIndex++;
      if (entry === undefined) {
        throw new Error("capturingFakeProvider: stream() called with no transcripts configured");
      }
      return entry.fake.stream(entry.fixedRequest, opts);
    },
  };
  return { provider, captured };
}

/** A provider whose `stream()` call is counted synchronously (never entering the generator body). */
function countingProvider(streamCalls: { count: number }): ProviderPort {
  return {
    describe: () => ({ capabilities: NO_CAPS, descriptor: { providerId: "fake-provider" } }),
    stream: (): AsyncIterable<NormalizedEvent> => {
      streamCalls.count++;
      return (async function* (): AsyncGenerator<NormalizedEvent> {})();
    },
  };
}

describe("AC1 — injectable runShell core: streaming + genuine multi-turn history", () => {
  test("streams assistant text to io.write and carries full accumulated history into the next turn's request", async () => {
    const turn1 = textTranscript("t1", ["Hi", " there"]);
    const turn2 = textTranscript("t2", ["I'm", " fine"]);
    const { provider, captured } = capturingFakeProvider([turn1, turn2]);

    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("Hello", "How are you", "/exit"),
      write: (s: string) => writes.push(s),
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    const output = writes.join("");
    expect(output).toContain("Hi there");
    expect(output).toContain("I'm fine");

    // Genuine multi-turn: the SECOND turn's request carries BOTH the prior
    // user+assistant messages plus the new user line.
    expect(captured.length).toBe(2);
    const firstReq = at(captured, 0);
    const secondReq = at(captured, 1);
    expect(firstReq.messages.map((m) => m.content)).toEqual(["Hello"]);
    expect(secondReq.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(secondReq.messages.map((m) => m.content)).toEqual(["Hello", "Hi there", "How are you"]);
  });

  test("runShell resolves cleanly at end-of-input (EOF), with zero turns", async () => {
    const streamCalls = { count: 0 };
    const io: ShellIO = { lines: linesFrom(), write: () => {} };
    const deps: ShellDeps = {
      makeProvider: () => countingProvider(streamCalls),
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await expect(runShell(io, deps)).resolves.toBeUndefined();
    expect(streamCalls.count).toBe(0);
  });

  test("runShell resolves cleanly on /exit and does not process lines after it", async () => {
    const streamCalls = { count: 0 };
    const io: ShellIO = { lines: linesFrom("/exit"), write: () => {} };
    const deps: ShellDeps = {
      makeProvider: () => countingProvider(streamCalls),
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await expect(runShell(io, deps)).resolves.toBeUndefined();
    expect(streamCalls.count).toBe(0);
  });

  test("runShell resolves cleanly on /quit", async () => {
    const streamCalls = { count: 0 };
    const io: ShellIO = { lines: linesFrom("/quit"), write: () => {} };
    const deps: ShellDeps = {
      makeProvider: () => countingProvider(streamCalls),
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await expect(runShell(io, deps)).resolves.toBeUndefined();
    expect(streamCalls.count).toBe(0);
  });
});

describe("AC2 — slash commands + provider_error resilience", () => {
  test("/clear resets history so the next turn's request carries only the new message", async () => {
    const turnA = textTranscript("a", ["Ok"]);
    const turnB = textTranscript("b", ["Sure"]);
    const { provider, captured } = capturingFakeProvider([turnA, turnB]);

    const io: ShellIO = {
      lines: linesFrom("First", "/clear", "Second", "/exit"),
      write: () => {},
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    expect(captured.length).toBe(2);
    const secondReq = at(captured, 1);
    expect(secondReq.messages.map((m) => m.content)).toEqual(["Second"]);
  });

  test("/model and /provider switch the active selection for subsequent turns", async () => {
    const initialTurn = textTranscript("init", ["Hello!"]);
    const { provider: initialProvider, captured: initialCaptured } = capturingFakeProvider([initialTurn]);
    const switchedTurn = textTranscript("switched", ["Yo"]);
    const { provider: switchedProvider, captured: switchedCaptured } = capturingFakeProvider([switchedTurn]);

    const makeProviderCalls: Array<{ name: string; model: string; baseUrl?: string }> = [];
    const makeProvider = (name: string, model: string, baseUrl?: string): ProviderPort => {
      makeProviderCalls.push(baseUrl === undefined ? { name, model } : { name, model, baseUrl });
      if (name === "ollama" && model === "llama3.2") {
        return switchedProvider;
      }
      return initialProvider;
    };

    const io: ShellIO = {
      lines: linesFrom("Hi", "/model llama3.2", "/provider ollama", "Yo there", "/exit"),
      write: () => {},
    };
    const deps: ShellDeps = {
      makeProvider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    // The switched (provider, model) pair was requested from the factory at some point.
    expect(makeProviderCalls.some((call) => call.name === "ollama" && call.model === "llama3.2")).toBe(true);

    // The turn issued AFTER both switches used the switched provider instance.
    expect(switchedCaptured.length).toBe(1);
    expect(at(switchedCaptured, 0).modelId).toBe("llama3.2");

    // Only the very first turn (before any switch) used the initial provider instance.
    expect(initialCaptured.length).toBe(1);
  });

  test("/help prints help text and does NOT start a model turn", async () => {
    const streamCalls = { count: 0 };
    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("/help", "/exit"),
      write: (s: string) => writes.push(s),
    };
    const deps: ShellDeps = {
      makeProvider: () => countingProvider(streamCalls),
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    expect(streamCalls.count).toBe(0);
    const output = writes.join("");
    expect(output).toMatch(/help/i);
    expect(output).toMatch(/\/model/);
    expect(output).toMatch(/\/clear/);
    expect(output).toMatch(/\/exit/);
  });

  test("a provider_error turn writes a readable error line and the loop CONTINUES to the next input", async () => {
    const failing = errorTranscript("err1", {
      kind: "unavailable",
      retryable: true,
      message: "model unavailable",
    });
    const recovering = textTranscript("ok1", ["Recovered"]);
    const { provider, captured } = capturingFakeProvider([failing, recovering]);

    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("first (will error)", "second (should succeed)", "/exit"),
      write: (s: string) => writes.push(s),
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await expect(runShell(io, deps)).resolves.toBeUndefined();

    const output = writes.join("");
    expect(/error|unavailable/i.test(output)).toBe(true);
    expect(output).toContain("Recovered");
    // Both turns reached the provider: the loop did not stop after the error.
    expect(captured.length).toBe(2);
  });
});

/** Local alias for the pinned, additive `ShellDeps.selectProviderModel` seam (see file header). */
type SelectProviderModel = (
  io: ShellIO,
  opts?: { onlyProvider?: string; onlyConnected?: boolean },
) => Promise<{ provider: string; model: string; baseUrl?: string }>;

describe("AC3 — /models, /provider, /connect + credential safety (flow 022)", () => {
  test("/help now also documents /models, /provider, and /connect", async () => {
    const streamCalls = { count: 0 };
    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("/help", "/exit"),
      write: (s: string) => writes.push(s),
    };
    const deps: ShellDeps = {
      makeProvider: () => countingProvider(streamCalls),
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    expect(streamCalls.count).toBe(0);
    const output = writes.join("");
    expect(output).toMatch(/\/models/);
    expect(output).toMatch(/\/provider/);
    expect(output).toMatch(/\/connect/);
  });

  test("/models lists the current provider's models and a numeric pick switches the model used by the NEXT turn", async () => {
    const turn = textTranscript("after-models-switch", ["ok"]);
    const { provider, captured } = capturingFakeProvider([turn]);

    const selectCalls: Array<{ onlyProvider?: string }> = [];
    // RED: `selectProviderModel` is not yet a known `ShellDeps` field (T6 adds
    // it) — this object literal is expected to fail typecheck until then.
    const selectProviderModel: SelectProviderModel = async (io, opts) => {
      selectCalls.push(opts ?? {});
      io.write("1. fixture-model-2\n");
      return { provider: "fake", model: "fixture-model-2" };
    };

    const io: ShellIO = {
      lines: linesFrom("/models", "hello after switch", "/exit"),
      write: () => {},
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
      selectProviderModel,
    };

    await runShell(io, deps);

    // `/models` restricts detection/pick to the CURRENT provider ("fake").
    expect(selectCalls).toEqual([{ onlyProvider: "fake" }]);
    // The turn AFTER the switch used the newly picked model.
    expect(captured.length).toBe(1);
    expect(at(captured, 0).modelId).toBe("fixture-model-2");
  });

  test("/provider re-runs full selection (no onlyProvider) and can switch to a different provider entirely", async () => {
    const turn = textTranscript("after-provider-switch", ["hi"]);
    const { provider: switchedProvider, captured } = capturingFakeProvider([turn]);

    const selectCalls: Array<{ onlyProvider?: string } | undefined> = [];
    const makeProviderCalls: Array<{ name: string; model: string; baseUrl?: string }> = [];
    const selectProviderModel: SelectProviderModel = async (_io, opts) => {
      selectCalls.push(opts);
      return { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434" };
    };
    const makeProvider = (name: string, model: string, baseUrl?: string): ProviderPort => {
      makeProviderCalls.push(baseUrl === undefined ? { name, model } : { name, model, baseUrl });
      return switchedProvider;
    };

    const io: ShellIO = {
      lines: linesFrom("/provider", "hi there", "/exit"),
      write: () => {},
    };
    const deps: ShellDeps = {
      makeProvider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
      selectProviderModel,
    };

    await runShell(io, deps);

    // `/provider` passes NO `onlyProvider` restriction (full re-detection).
    expect(selectCalls.length).toBe(1);
    expect(at(selectCalls, 0)?.onlyProvider).toBeUndefined();

    expect(
      makeProviderCalls.some(
        (call) => call.name === "ollama" && call.model === "llama3.2" && call.baseUrl === "http://localhost:11434",
      ),
    ).toBe(true);
    expect(captured.length).toBe(1);
    expect(at(captured, 0).providerId).toBe("ollama");
    expect(at(captured, 0).modelId).toBe("llama3.2");
  });

  test("/models and /provider fail-soft (write a message, never crash) when no selector is injected", async () => {
    const streamCalls = { count: 0 };
    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("/models", "/provider", "/exit"),
      write: (s: string) => writes.push(s),
    };
    const deps: ShellDeps = {
      makeProvider: () => countingProvider(streamCalls),
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
      // selectProviderModel intentionally omitted — must not crash runShell.
    };

    await expect(runShell(io, deps)).resolves.toBeUndefined();
    expect(streamCalls.count).toBe(0);
    expect(writes.join("")).toMatch(/not available/i);
  });

  test("/connect with a selector switches among connected providers only", async () => {
    const turn = textTranscript("after-connect-switch", ["ok"]);
    const { provider, captured } = capturingFakeProvider([turn]);
    const selectCalls: Array<{ onlyProvider?: string; onlyConnected?: boolean } | undefined> = [];
    const selectProviderModel: SelectProviderModel = async (_io, opts) => {
      selectCalls.push(opts);
      return { provider: "deepseek", model: "deepseek-chat" };
    };

    const io: ShellIO = {
      lines: linesFrom("/connect", "hello after connect", "/exit"),
      write: () => {},
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
      selectProviderModel,
    };

    await runShell(io, deps);

    expect(selectCalls).toEqual([{ onlyConnected: true }]);
    expect(captured.length).toBe(1);
    expect(at(captured, 0).providerId).toBe("deepseek");
    expect(at(captured, 0).modelId).toBe("deepseek-chat");
  });

  test("/connect writes ANTHROPIC_API_KEY guidance and never echoes/stores a credential value", async () => {
    const streamCalls = { count: 0 };
    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("/connect", "/exit"),
      write: (s: string) => writes.push(s),
    };
    const deps: ShellDeps = {
      makeProvider: () => countingProvider(streamCalls),
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    expect(streamCalls.count).toBe(0);
    const output = writes.join("");
    expect(output).toMatch(/ANTHROPIC_API_KEY/);
    // Never echoes a credential-shaped value (e.g. an "sk-"-prefixed secret).
    expect(output).not.toMatch(/sk-[a-zA-Z0-9]/);
  });
});

// --- flow 031: optional rich-rendering hooks (onTurnStart / onTurnEnd /
// onSystem). The core stays deterministic; the hooks are additive and MUST be
// byte-identical no-ops when absent. See
// `.metaproject/flows/031-2026-07-17-keryx-shell-rich-inline-ui/
// acceptance-criteria.md` (AC1).
describe("flow 031 — additive ShellIO rich-rendering hooks", () => {
  test("onTurnStart precedes streaming, onTurnEnd carries the full reply, onSystem gets system text (not write)", async () => {
    const turn = textTranscript("t1", ["Hel", "lo"]);
    const { provider } = capturingFakeProvider([turn]);

    const events: string[] = [];
    const tokens: string[] = [];
    const systemText: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("/help", "hi", "/exit"),
      write: (s: string) => {
        tokens.push(s);
        events.push("write");
      },
      onTurnStart: () => events.push("turnStart"),
      onTurnEnd: (full: string) => events.push(`turnEnd:${full}`),
      onSystem: (t: string) => systemText.push(t),
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    // `/help` is routed to onSystem, never to write.
    expect(systemText.join("")).toMatch(/Commands:/);
    expect(tokens.join("")).not.toMatch(/Commands:/);
    // onTurnStart fires before the first streamed token; onTurnEnd carries the
    // full accumulated reply; tokens still stream through write.
    const startIdx = events.indexOf("turnStart");
    const firstWriteIdx = events.indexOf("write");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(firstWriteIdx);
    expect(events).toContain("turnEnd:Hello");
    expect(tokens.join("")).toContain("Hello");
  });

  test("without the optional hooks, output is byte-identical (system + tokens + separator all via write)", async () => {
    const turn = textTranscript("t1", ["Hel", "lo"]);
    const { provider } = capturingFakeProvider([turn]);

    const writes: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("hi", "/exit"),
      write: (s: string) => writes.push(s),
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    // One turn: streamed tokens then the blank-line separator — exactly the
    // pre-flow-031 behavior, with no hook-driven output injected.
    expect(writes.join("")).toBe("Hello\n\n");
  });

  test("onSystem receives a streamed provider_error line when supplied", async () => {
    const errored = errorTranscript("e1", {
      kind: "provider_unavailable",
      retryable: false,
      message: "boom",
    });
    const { provider } = capturingFakeProvider([errored]);

    const tokens: string[] = [];
    const systemText: string[] = [];
    const io: ShellIO = {
      lines: linesFrom("hi", "/exit"),
      write: (s: string) => tokens.push(s),
      onSystem: (t: string) => systemText.push(t),
    };
    const deps: ShellDeps = {
      makeProvider: () => provider,
      clock: fixedClock(),
      idSeq: fixedIdSeq(),
      initial: { provider: "fake", model: "fixture-model" },
    };

    await runShell(io, deps);

    expect(systemText.join("")).toMatch(/\[error\].*boom/);
    expect(tokens.join("")).not.toMatch(/\[error\]/);
  });
});

describe("parseShellCliFlags — default TUI agent shell", () => {
  test("bare args prefer TUI and leave agent mode unset (default agent)", () => {
    const flags = parseShellCliFlags([]);
    expect(flags.wantTui).toBe(true);
    expect(flags.modeFlag).toBeUndefined();
  });

  test("--no-tui opts out of OpenTUI", () => {
    expect(parseShellCliFlags(["--no-tui"]).wantTui).toBe(false);
  });

  test("--chat selects chat mode; --agent selects agent mode", () => {
    expect(parseShellCliFlags(["--chat"]).modeFlag).toBe(false);
    expect(parseShellCliFlags(["--agent"]).modeFlag).toBe(true);
  });

  test("--tui remains accepted and keeps wantTui true", () => {
    expect(parseShellCliFlags(["--tui"]).wantTui).toBe(true);
    expect(parseShellCliFlags(["--no-tui", "--tui"]).wantTui).toBe(true);
  });

  test("provider/model/base-url are parsed", () => {
    const flags = parseShellCliFlags([
      "--provider",
      "ollama",
      "--model",
      "llama3.1:latest",
      "--base-url",
      "http://localhost:11434",
    ]);
    expect(flags.providerArg).toBe("ollama");
    expect(flags.modelArg).toBe("llama3.1:latest");
    expect(flags.baseUrl).toBe("http://localhost:11434");
    expect(flags.wantTui).toBe(true);
  });

  test("session flags -c / -r are per-project continue/resume", () => {
    expect(parseShellCliFlags(["-c"]).continueLast).toBe(true);
    expect(parseShellCliFlags(["--continue"]).continueLast).toBe(true);
    expect(parseShellCliFlags(["-r", "abc-123"]).resumeId).toBe("abc-123");
    expect(parseShellCliFlags(["--resume", "my-title"]).resumeId).toBe("my-title");
    expect(parseShellCliFlags(["-r"]).resumePick).toBe(true);
    expect(parseShellCliFlags(["-r"]).resumeId).toBeUndefined();
  });
});

test("shellCommand wires web_search into the agent TUI tool set", async () => {
  let toolNames: string[] = [];
  await shellCommand(["--agent", "--provider", "fake", "--model", "fixture-model"], {
    isTty: true,
    checkVersion: async () => ({
      status: "up-to-date",
      currentVersion: "test",
      latestVersion: "test",
      source: "cache",
    }),
    launchAgent: async (opts) => {
      // SLATE-3a: `makeAgentDeps` gains a second `getSessionDir` parameter
      // (see the source-text audit below) — no live session in this
      // scenario, so a getter that always resolves to `undefined` is the
      // correct "no active session" input.
      const deps = await opts.makeAgentDeps({ provider: "fake", model: "fixture-model" }, () => undefined);
      toolNames = deps.tools.map((tool) => tool.definition.name);
      return true;
    },
  });

  expect(toolNames.sort()).toEqual([
    "ask_user",
    "get_cwd",
    "graph_affected",
    "graph_path",
    "graph_query",
    "graph_symbol",
    "health_status",
    "list_dir",
    "memory_search",
    "read_file",
    "read_wiki",
    "repomap",
    "search_code",
    "shell_exec",
    "slate_read",
    "slate_write_seed",
    "spawn_subagent",
    "test_related",
    "web_fetch",
    "web_search",
    "wiki_ask",
    "wiki_backlinks",
    "workspace_overview",
    "workspace_read",
  ]);
});

test("shellCommand's makeAgentDeps threads a supplied getSessionDir through to slate_read/slate_write_seed", async () => {
  let tools: { definition: { name: string }; invoke: (input: Record<string, unknown>) => Promise<{ isError: boolean }> }[] = [];
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "keryx-shell-getsessiondir-"));
  await shellCommand(["--agent", "--provider", "fake", "--model", "fixture-model"], {
    isTty: true,
    checkVersion: async () => ({
      status: "up-to-date",
      currentVersion: "test",
      latestVersion: "test",
      source: "cache",
    }),
    launchAgent: async (opts) => {
      // Fix round (Finding 1, code review of PR #306): `opts.makeAgentDeps`'s
      // second parameter widened from `getSessionDir: () => string |
      // undefined` to `getSlateSession: () => SlateSessionRef | undefined` —
      // `shell.ts`'s own `makeAgentDeps` now derives `getSessionDir` locally
      // from this getter's `.dir` (see that file), so this test still
      // exercises the same `slate_read`/`slate_write_seed` wiring via the
      // full ref shape.
      const deps = await opts.makeAgentDeps(
        { provider: "fake", model: "fixture-model" },
        () => ({ dir: sessionDir, cwd: process.cwd(), opened: true }),
      );
      tools = deps.tools;
      return true;
    },
  });

  const slateRead = tools.find((tool) => tool.definition.name === "slate_read");
  expect(slateRead).toBeDefined();
  // sessionDir has no open slate, but IS a real, resolved session dir — this
  // must NOT be the "no active session" error path.
  const result = await slateRead?.invoke({});
  expect(result?.isError).toBe(false);
});

// --- SLATE-3a: shell.ts's getSessionDir threading (flow 161, AC5) --------
//
// `makeAgentDeps` (the TUI path's deps-builder, defined in shell.ts and
// invoked via `opts.makeAgentDeps` from tui-shell.ts) gains a SECOND
// parameter, `getSessionDir: () => string | undefined`, threaded straight
// into `buildInteractiveAgentTools({ ..., getSessionDir })` — proven above by
// invoking `opts.makeAgentDeps` end-to-end and checking `slate_read`/
// `slate_write_seed` are in the tool set.
//
// The readline agent-mode path (`runAgentRepl`, `NOT unit-tested` per its own
// doc comment — see the SLATE-5 audit above) is different: `tools:
// buildInteractiveAgentTools({...})` is built in `shellCommand`'s "if
// (agentMode)" branch BEFORE `runAgentRepl` is even called, but the
// `SlateSessionRef` this turn's `slate_read`/`slate_write_seed` must resolve
// is only known INSIDE `runAgentRepl` (`let slateSession`, reassigned as the
// REPL runs — see the SLATE-5 audit above). A static dir captured at
// tools-build time cannot work (no session exists yet), so a LAZY getter is
// required, exactly like the TUI path — but the getter must read a value
// `runAgentRepl` writes into AFTER the getter has already been created and
// handed to `buildInteractiveAgentTools`.
//
// Chosen shape (T8, for T9 to build exactly this): a shared mutable box,
//   const slateSessionBox: { current: SlateSessionRef | undefined } = { current: undefined };
// declared in `shellCommand`'s agent-mode branch BEFORE the readline
// `buildInteractiveAgentTools({ ..., getSessionDir: () =>
// slateSessionBox.current?.dir })` call, and threaded into `runAgentRepl(...)`
// as a new argument. Inside `runAgentRepl`, every existing `slateSession =
// ...` assignment additionally syncs the box (`slateSessionBox.current =
// slateSession;`) immediately after — `runAgentRepl`'s own local `let
// slateSession` variable and its 3-close-trigger wiring (audited above) stay
// completely unchanged; the box is a pure side-channel, not a replacement.
// `closeSlateSession` mutates `.opened` on the SAME object `slateSession`
// already points to, so the box reflects that in-place mutation automatically
// with no extra sync line needed — `.dir` (all `getSessionDir` ever reads)
// never changes via close.
//
// This is a source-text audit, following the exact precedent set by the
// SLATE-5 describe block above: `runAgentRepl` has no injection seam and is
// not driven end-to-end here, so the wiring is proven by asserting the
// required literals exist, in the required order, in the real source file —
// not yet true until T9 lands this shape.
describe("SLATE-3a — shell.ts getSessionDir threading (source-text audit)", () => {
  const shellSource = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");
  const agentModeBranchStart = shellSource.indexOf("if (agentMode) {");
  // A generous fixed window from the branch start: large enough to cover
  // everything from `if (agentMode) {` through its `runAgentRepl(...)` call
  // and a little past it, without accidentally reaching into an unrelated
  // later part of the file (this file has no other "if (agentMode)" branch).
  const agentModeBranch = shellSource.slice(agentModeBranchStart, agentModeBranchStart + 3000);
  const replBodyStart = shellSource.indexOf("async function runAgentRepl(");
  const replBody = shellSource.slice(replBodyStart, agentModeBranchStart);

  test("a shared slateSessionBox is declared before the readline buildInteractiveAgentTools call", () => {
    const boxIndex = agentModeBranch.indexOf(
      "const slateSessionBox: { current: SlateSessionRef | undefined } = { current: undefined };",
    );
    const toolsCallIndex = agentModeBranch.indexOf("tools: buildInteractiveAgentTools({");
    expect(boxIndex).toBeGreaterThanOrEqual(0);
    expect(toolsCallIndex).toBeGreaterThan(boxIndex);
  });

  test("the readline buildInteractiveAgentTools call passes a getSessionDir reading the box", () => {
    const toolsCallIndex = agentModeBranch.indexOf("tools: buildInteractiveAgentTools({");
    const toolsCallBlock = agentModeBranch.slice(toolsCallIndex, toolsCallIndex + 400);
    expect(toolsCallBlock).toContain("getSessionDir: () => slateSessionBox.current?.dir");
  });

  test("the box is threaded into the runAgentRepl(...) call", () => {
    const replCallIndex = shellSource.indexOf("await runAgentRepl(sharedLines,");
    expect(replCallIndex).toBeGreaterThanOrEqual(0);
    const replCallBlock = shellSource.slice(replCallIndex, replCallIndex + 400);
    expect(replCallBlock).toContain("slateSessionBox");
  });

  test("every slateSession reassignment inside runAgentRepl syncs the box immediately after", () => {
    const reassignments = ["slateSession = live !== undefined ? { dir: live.dir, cwd: sessionCwd, opened: false } : undefined;", "slateSession = { dir: live.dir, cwd: sessionCwd, opened: false };"];
    for (const assignment of reassignments) {
      const idx = replBody.indexOf(assignment);
      expect(idx).toBeGreaterThanOrEqual(0);
      const after = replBody.slice(idx + assignment.length, idx + assignment.length + 200);
      expect(after).toContain("slateSessionBox.current = slateSession;");
    }
  });
});

// --- SLATE-15: /goal wiring in shell.ts's readline agent-mode command switch
// (flow 161, T10 — AC1/AC2) -------------------------------------------------
//
// RED until T11 lands the wiring: `runAgentRepl` has no injection seam (same
// precedent as the SLATE-3a/SLATE-5 audits above), so this is a source-text
// audit, not a driven-through-the-real-REPL test. The ACTUAL behavior (fail-
// closed `--workspace` validation, no-workspace-created guarantee,
// ensureSlateOpened + runAgentTurn sequencing) is proven directly against the
// shared `runGoalCommand` core in `goal-command.test.ts`; this block only
// proves shell.ts's readline surface actually WIRES that core in — the exact
// Phase-2 cross-surface-gap lesson this flow's dispatch briefs call out
// explicitly ("verify both surfaces by grep, do not assume symmetry").
//
// PINNED SHAPE (T11 implements exactly this — see subagent-result): a new
// `else if (command === "/goal")` branch inside `runAgentRepl`'s existing
// `if (line.startsWith("/"))` switch (alongside `/search-connect` etc.,
// before the final unconditional `else`), calling:
//   await runGoalCommand({
//     raw: rest,                       // already-computed `parts.slice(1).join(" ").trim()`
//     cwd: sessionCwd,
//     io: agentIo,
//     deps,
//     history,
//     slateSession,
//     mintAttemptId: mintTimestampAttemptId,
//   });
// `runGoalCommand` mutates `slateSession.opened` IN PLACE (same object
// `slateSessionBox.current` already points to via the SLATE-3a wiring above),
// so no extra `slateSessionBox.current = slateSession;` sync is needed for
// this branch specifically — it is not a REASSIGNMENT of the `slateSession`
// variable itself, unlike `/new`'s branch.
describe("SLATE-15 — /goal wiring in shell.ts's readline agent-mode command switch (source-text audit)", () => {
  const shellSource = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");
  const replBodyStart2 = shellSource.indexOf("async function runAgentRepl(");
  const agentModeBranchStart2 = shellSource.indexOf("if (agentMode) {");
  const replBody2 = shellSource.slice(replBodyStart2, agentModeBranchStart2);

  test("runGoalCommand is imported from ./goal-command", () => {
    expect(shellSource).toMatch(/from ["']\.\/goal-command["']/);
    expect(shellSource).toContain("runGoalCommand");
  });

  test("the readline command switch has a /goal branch calling runGoalCommand", () => {
    const branchIndex = replBody2.indexOf('command === "/goal"');
    expect(branchIndex).toBeGreaterThanOrEqual(0);
    const branchBlock = replBody2.slice(branchIndex, branchIndex + 400);
    expect(branchBlock).toContain("runGoalCommand(");
  });

  test("the /goal branch passes rest, sessionCwd, agentIo, deps, history, slateSession, and mintTimestampAttemptId", () => {
    const branchIndex = replBody2.indexOf('command === "/goal"');
    const branchBlock = replBody2.slice(branchIndex, branchIndex + 500);
    expect(branchBlock).toContain("rest");
    expect(branchBlock).toContain("sessionCwd");
    expect(branchBlock).toContain("agentIo");
    expect(branchBlock).toContain("history");
    expect(branchBlock).toContain("slateSession");
    expect(branchBlock).toContain("mintTimestampAttemptId");
  });

  test("/goal appears in the readline agent REPL's own advertised command list (READLINE_AGENT_COMMANDS)", () => {
    const start = shellSource.indexOf("const READLINE_AGENT_COMMANDS: readonly string[] = [");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = shellSource.indexOf("];", start);
    const block = shellSource.slice(start, end);
    expect(block).toContain('"/goal"');
  });
});

// --- flow 109 / AC10: readline `/expand` parity with the TUI transcript -----

describe("expandedToolOutput (readline /expand, AC10)", () => {
  /** ANSI introducer, spelled out so the literal control byte never lands in source. */
  const ESC = String.fromCharCode(27);
  function forceColor(): void {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
  }
  function noColor(): void {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";
  }

  test("nothing to expand: undefined for missing, empty and whitespace-only output", () => {
    expect(expandedToolOutput("read_file", undefined)).toBeUndefined();
    expect(expandedToolOutput("read_file", "")).toBeUndefined();
    expect(expandedToolOutput("read_file", "   \n\t\n ")).toBeUndefined();
  });

  test("header is the SHARED blockLabel, so readline and the TUI cannot drift", () => {
    noColor();
    const out = expandedToolOutput("read_file", "a\nb\nc") ?? "";
    // Byte-identical to what an expanded TUI block header renders.
    expect(out).toContain(blockLabel({ kind: "read_file", lineCount: 3, collapsed: false }));
    expect(out).toContain("▾ read_file (3 lines)");
    // Singular/plural comes from the shared helper too.
    expect(expandedToolOutput("read_file", "only one") ?? "").toContain("▾ read_file (1 line)");
    // An unnamed tool still labels as `tool`, as before.
    expect(expandedToolOutput(undefined, "x") ?? "").toContain("▾ tool (1 line)");
  });

  test("body is indented under the gutter and keeps its content", () => {
    noColor();
    const out = expandedToolOutput("list_dir", "alpha\nbeta") ?? "";
    expect(out.startsWith("\n")).toBe(true); // leading blank line, as before
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("  alpha\n");
    expect(out).toContain("  beta\n");
  });

  test("truncates past the cap and says how many lines were dropped (unchanged behavior)", () => {
    noColor();
    const many = Array.from({ length: EXPAND_MAX_LINES + 25 }, (_, i) => `line ${i}`).join("\n");
    const out = expandedToolOutput("shell_exec", many) ?? "";
    expect(out).toContain(`line ${EXPAND_MAX_LINES - 1}`);
    expect(out).not.toContain(`line ${EXPAND_MAX_LINES}\n`);
    expect(out).toContain("… (25 more lines truncated)");
    // The count in the header is the FULL line count, not the shown one.
    expect(out).toContain(`▾ shell_exec (${EXPAND_MAX_LINES + 25} lines)`);
  });

  test("trailing newlines are trimmed before counting, so the label is not inflated", () => {
    noColor();
    expect(expandedToolOutput("read_file", "a\nb\n\n\n") ?? "").toContain("▾ read_file (2 lines)");
  });

  test("a unified diff is colorized through the SHARED renderDiff, not flatly dimmed", () => {
    forceColor();
    const out = expandedToolOutput("apply_patch", "@@ -1,2 +1,2 @@\n-gone\n+here\n stays") ?? "";
    // Green add, red delete, cyan hunk — the same helper `renderDiff` gives the TUI.
    expect(out).toContain(`${ESC}[32m+here`);
    expect(out).toContain(`${ESC}[31m-gone`);
    expect(out).toContain(`${ESC}[36m@@ -1,2 +1,2 @@`);
  });

  test("non-diff output stays dim, and a `- ` bullet list is never mistaken for a diff", () => {
    forceColor();
    const bullets = expandedToolOutput("read_file", "- first bullet\n- second bullet") ?? "";
    expect(bullets).not.toContain(`${ESC}[31m`); // no red: not a deletion
    expect(bullets).toContain(`${ESC}[2m`); // dim body, as before
    expect(bullets).toContain("- first bullet");
  });

  test("NO_COLOR emits no escape codes at all", () => {
    noColor();
    const out = expandedToolOutput("apply_patch", "@@ -1,2 +1,2 @@\n-gone\n+here") ?? "";
    expect(out).not.toContain(ESC);
    expect(out).toContain("@@ -1,2 +1,2 @@");
  });
});

// --- SLATE-5 close-trigger wiring audit (Phase 2, review finding) ---
//
// `runAgentRepl` (the interactive agent-mode REPL loop, above `runShell` in
// this file) is explicitly "NOT unit-tested" per its own doc comment,
// predating this Flow: it drives real `process.stdout`, a real
// TTY-conditioned spinner, and reads on-disk shell-permission config via
// `loadShellPermissions()` with no injection seam — refactoring that is out
// of this Flow's scope. The slate open/close/archive LOGIC this wiring calls
// into is NOT new here and is already fully regression-tested directly:
// `runAgentRepl` calls the SAME `runAgentTurn` that `agent.test.ts`'s
// "SLATE-5: ..." tests already drive (shell.ts is a thin caller, not a
// second implementation), and `slate-lifecycle.test.ts` covers
// `closeSlateSession`/`ensureSlateOpened` directly. What IS new and
// genuinely untested is shell.ts's OWN wiring — which exact points call
// `closeSlateSession` and where a fresh `SlateSessionRef` is (re)created —
// so this is a source-text audit proving every required call site exists,
// following the precedent already established by `harness.test.ts`'s
// "AC4 — src/cli.ts registers the harness command (source-text audit)" for
// wiring this codebase already treats as impractical to drive through a
// real, side-effecting REPL loop end-to-end.
describe("SLATE-5 — shell.ts runAgentRepl close-trigger wiring (source-text audit)", () => {
  const shellSource = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");
  const bodyStart = shellSource.indexOf("async function runAgentRepl(");
  const replBody = shellSource.slice(bodyStart);
  const closeCall = "await closeSlateSession(slateSession, mintTimestampAttemptId);";

  test("imports the slate-lifecycle close primitives", () => {
    expect(shellSource).toContain(
      'import { closeSlateSession, mintTimestampAttemptId, type SlateSessionRef } from "../session/slate-lifecycle";',
    );
  });

  test("closes the live slate at exactly the three documented trigger points (EOF, /exit|/quit, /new|/clear) — not fewer, not more", () => {
    const occurrences = replBody.split(closeCall).length - 1;
    expect(occurrences).toBe(3);
  });

  test("EOF (end of input) is one of the close-trigger points", () => {
    const eofBlock = replBody.slice(replBody.indexOf("if (line === undefined) {"), replBody.indexOf("return; // end of input") + 1);
    expect(eofBlock).toContain(closeCall);
  });

  test("/exit and /quit is one of the close-trigger points", () => {
    const exitBlock = replBody.slice(
      replBody.indexOf('command === "/exit" || command === "/quit"'),
      replBody.indexOf('command === "/exit" || command === "/quit"') + 300,
    );
    expect(exitBlock).toContain(closeCall);
  });

  test("/new (and /clear) closes the OLD slate before a fresh SlateSessionRef is created for the new session dir", () => {
    const newBlockStart = replBody.indexOf('command === "/new" || command === "/clear"');
    const newBlock = replBody.slice(newBlockStart, newBlockStart + 900);
    const closeIndex = newBlock.indexOf(closeCall);
    const reassignIndex = newBlock.indexOf("slateSession = { dir: live.dir, cwd: sessionCwd, opened: false };");
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(reassignIndex).toBeGreaterThan(closeIndex);
  });

  test("the initial SlateSessionRef is constructed from the opened session (undefined when sessions are off)", () => {
    expect(replBody).toContain(
      "slateSession = live !== undefined ? { dir: live.dir, cwd: sessionCwd, opened: false } : undefined;",
    );
  });

  test("the slate session ref is actually threaded into runAgentTurn for each turn", () => {
    expect(replBody).toContain(
      "await runAgentTurn(agentIo, deps, history, line, slateSession !== undefined ? { slateSession } : {});",
    );
  });
});

// --- flow 163 AC8: the REPL (keryx shell) never triggers the Track B
// wrap-up composer this way — the trigger call site exists ONLY in the
// one-shot `keryx harness run` path (see harness.test.ts's own "flow 163
// AC8" source-text audit for the positive half of this proof). A long-lived
// REPL process serves many turns; `closeSlateOnFlowDone` (already shipped)
// is its own, unrelated slate-close mechanism — it must never additionally
// fire a machine wrap-up. Source-text audit, following the exact precedent
// this file already sets for its own SLATE-3a/SLATE-15 wiring proofs above
// (`readFileSync` the real source, assert on literals — `runAgentRepl` has
// no injection seam to drive this through end-to-end).
describe("flow 163 AC8 — shell.ts's REPL never triggers the wrap-up composer (source-text audit)", () => {
  const shellSourceAc8 = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");

  test("shell.ts never imports or calls the Track B wrap-up composer", () => {
    expect(shellSourceAc8).not.toContain("runWrapUp");
    expect(shellSourceAc8).not.toMatch(/machine-wrap-up/);
  });
});
