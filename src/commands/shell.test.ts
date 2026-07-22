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
import { EXPAND_MAX_LINES, expandedToolOutput, parseShellCliFlags, runShell } from "./shell";
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
  opts?: { onlyProvider?: string },
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
