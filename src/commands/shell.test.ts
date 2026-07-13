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
import { runShell } from "./shell";

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
