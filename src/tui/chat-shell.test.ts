// Flow 112 — T6. The chat driver: the push/pull adapter and the mounted shell.
//
// AC10 drives a chat turn END TO END through the REAL `runShell` with a fake
// provider and asserts the streamed reply on a captured frame — the same driver
// the readline chat path runs, which is the whole point of path A.
// AC11 unit-tests the adapter without a renderer.
// AC13 pins the flow-109 rendering chat inherits: a `ts` fence shows its
// language tag and a diff shows distinct add/remove colouring, asserted on span
// COLOURS (a substring check cannot prove colour).
//
// `@opentui/core` is reached ONLY structurally, through `loadOpenTui`'s inferred
// return type; the shell takes `otui` as a parameter. The optional-dependency
// guard in `src/capability/no-optional-imports` is a regex over file TEXT, so
// the forbidden static import form must not be spelled out in a comment either.
import { expect, test } from "bun:test";
import { createChatBridge, mountChatShell, type ChatShellHandle } from "./chat-shell";
import { runShell, type ShellDeps, type ShellIO } from "../commands/shell";
import type { NormalizedEvent, ProviderPort, ProviderDescription } from "../harness/provider/types";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    // SEQUENTIAL, never `Promise.all`: the two entrypoints share a module cycle
    // (`core-slot.ts` extends `Renderable`), and evaluating them concurrently
    // hits the cycle mid-initialization — `Cannot access 'Renderable' before
    // initialization` / `… 'TestWriteStream' …`. Awaiting core first settles it.
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;
type SpanFrame = ReturnType<TestSetup["captureSpans"]>;

/**
 * Loaded ONCE, at module scope, so an absent optional dependency SKIPS the
 * renderer tests instead of passing them. Each used to `return` early, which bun
 * reports as a pass — AC10/AC13 could silently become green no-ops. (The AC11
 * adapter tests need no renderer and always run.)
 */
const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

/** The bundle, inside a body that only runs when it is present. */
function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without @opentui/core");
  }
  return OTUI;
}

/** The foreground colour (as `[r,g,b,a]`) of the span carrying `needle`. */
function fgOf(frame: SpanFrame, needle: string): [number, number, number, number] | undefined {
  for (const line of frame.lines) {
    const span = line.spans.find((s) => s.text.includes(needle));
    if (span !== undefined) {
      return span.fg.toInts();
    }
  }
  return undefined;
}

/** A provider that replays one scripted reply per turn, as text deltas. */
function scriptedTextProvider(replies: readonly string[]): ProviderPort {
  let call = 0;
  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: false,
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
  return {
    describe: () => description,
    stream: (_request, opts) => {
      const reply = replies[call] ?? "";
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        // Chunked so the streaming path (not only `onTurnEnd`) is exercised.
        for (const piece of reply.match(/[\s\S]{1,12}/g) ?? []) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "text_delta", text: piece };
        }
        yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end" };
      })();
    },
  };
}

let idCounter = 0;
function chatDeps(replies: readonly string[]): ShellDeps {
  idCounter = 0;
  const provider = scriptedTextProvider(replies);
  return {
    makeProvider: () => provider,
    clock: () => "2026-07-21T00:00:00.000Z",
    idSeq: () => `id-${idCounter++}`,
    initial: { provider: "scripted", model: "m" },
    // No `session`: `runShell` skips persistence, so the test writes no files.
  };
}

/** Let the driver's async turn settle: several render frames + macrotasks. */
async function settle(h: { flush: TestSetup["flush"] }, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await h.flush();
  }
}

async function mountChat(
  otui: OtuiBundle,
  opts: { replies: readonly string[]; width?: number; height?: number },
): Promise<TestSetup & { handle: ChatShellHandle; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 90, height: opts.height ?? 26 });
  const handle = await mountChatShell(otui.core, setup.renderer, {
    deps: chatDeps(opts.replies),
    runShell, // the REAL driver — not a stand-in (AC10)
    persistSelection: false,
  });
  await setup.flush();
  return {
    ...setup,
    handle,
    destroy: () => {
      handle.destroy(); // closes the line stream and clears the chrome timers
      setup.renderer.destroy();
    },
  };
}

otuiTest("AC10: a chat turn runs end to end through the real runShell and the reply is on the frame", async () => {
  const otui = requireOtui();
  const h = await mountChat(otui, { replies: ["Keryx is a metaproject CLI.", "Second answer here."] });

  // Mount state: the chat chrome, its own mode label, and a focused composer.
  const mounted = h.captureCharFrame();
  expect(mounted).toContain("keryx · chat · scripted/m");
  expect(h.handle.chrome.textarea.focused).toBe(true);

  // A composer submission becomes a `runShell` line and streams a reply back.
  h.handle.chrome.input.value = "what is keryx?";
  await h.flush();
  h.mockInput.pressEnter();
  await settle(h);

  const frame = h.captureCharFrame();
  expect(frame).toContain("what is keryx?"); // the user echo
  expect(frame).toContain("Keryx is a metaproject CLI."); // the streamed reply
  expect(h.handle.chrome.isBusy()).toBe(false); // the turn settled, spinner gone
  expect(h.handle.bridge.turnActive()).toBe(false);
  expect(h.handle.chrome.textarea.focused).toBe(true); // focus handed back

  // A second turn appends rather than replacing, and the estimate advances.
  h.handle.chrome.input.value = "and again?";
  await h.flush();
  h.mockInput.pressEnter();
  await settle(h);
  const second = h.captureCharFrame();
  expect(second).toContain("Keryx is a metaproject CLI.");
  expect(second).toContain("Second answer here.");
  expect(second).toMatch(/~\d/); // the D-A2 estimated context counter

  // A slash command is handled by `runShell` itself and never reaches a model.
  h.handle.chrome.input.value = "/help";
  await h.flush();
  h.mockInput.pressEnter();
  await settle(h);
  expect(h.captureCharFrame()).toContain("/compact");

  // …and an agent-only command fails with the wrong-mode explanation (S4/AC8).
  h.handle.chrome.input.value = "/expand";
  await h.flush();
  h.mockInput.pressEnter();
  await settle(h);
  expect(h.captureCharFrame()).toContain("only available in agent mode");

  // `/exit` ends the line stream, so the driver returns and the shell tears down.
  h.handle.chrome.input.value = "/exit";
  await h.flush();
  h.mockInput.pressEnter();
  await h.handle.done;
  h.destroy();
});

otuiTest("a turn settling never steals focus from a `/` dropdown opened while it streamed", async () => {
  const otui = requireOtui();
  // A driver whose turn is held open by the test, so the `/` menu can be opened
  // in the middle of it. The scripted provider finishes far too fast for that.
  let releaseTurn: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const heldRunShell = async (io: ShellIO): Promise<void> => {
    for await (const _line of io.lines) {
      io.onTurnStart?.();
      io.write("streaming…");
      await held;
      io.onTurnEnd?.("streaming…");
      io.write("\n\n");
    }
  };

  const setup = await otui.testing.createTestRenderer({ width: 90, height: 26 });
  const handle = await mountChatShell(otui.core, setup.renderer, {
    deps: chatDeps([]),
    runShell: heldRunShell,
    persistSelection: false,
  });
  await setup.flush();

  handle.chrome.input.value = "a question";
  await setup.flush();
  setup.mockInput.pressEnter();
  await settle(setup);
  expect(handle.bridge.turnActive()).toBe(true); // the turn is still running

  // Mid-turn, the user opens the command dropdown: it takes the keyboard.
  await setup.mockInput.pressKeys(["/"]);
  await settle(setup);
  expect(handle.chrome.menuActive()).toBe(true);
  expect(handle.chrome.menu.focused).toBe(true);
  expect(handle.chrome.textarea.focused).toBe(false);

  // The turn now settles. The dropdown is still up, so focus must stay with it:
  // an unconditional `focusComposer()` here leaves the menu on screen swallowing
  // printable keys while Enter submits the raw filter text instead of selecting
  // the highlighted command.
  releaseTurn();
  await settle(setup);
  expect(handle.chrome.isBusy()).toBe(false); // the turn really did settle
  expect(handle.chrome.menuActive()).toBe(true);
  expect(handle.chrome.menu.focused).toBe(true);
  expect(handle.chrome.textarea.focused).toBe(false);

  handle.destroy();
  setup.renderer.destroy();
});

otuiTest("/new resets the estimated context counter instead of letting it keep climbing", async () => {
  const otui = requireOtui();
  const h = await mountChat(otui, { replies: ["A fairly long scripted answer about keryx."] });
  expect(h.captureCharFrame()).toContain("~0 tokens (est)");

  h.handle.chrome.input.value = "a question long enough to move the estimate";
  await h.flush();
  h.mockInput.pressEnter();
  await settle(h);
  expect(h.captureCharFrame()).not.toContain("~0 tokens (est)"); // it moved

  // `/new` makes `runShell` drop its history; the estimate mirrors that history,
  // so it must be dropped too rather than carried into the fresh session.
  h.handle.chrome.input.value = "/new";
  await h.flush();
  h.mockInput.pressEnter();
  await settle(h);
  expect(h.captureCharFrame()).toContain("~0 tokens (est)");
  h.destroy();
});

otuiTest("AC13: chat renders a ts fence with its language tag and a diff with distinct colours", async () => {
  const otui = requireOtui();
  const reply = [
    "Try this:",
    "```ts",
    "const a = 1;",
    "```",
    "```diff",
    "@@ -1,2 +1,2 @@",
    "-removed line",
    "+added line",
    "```",
  ].join("\n");
  const h = await mountChat(otui, { replies: [reply], width: 90, height: 30 });
  h.handle.chrome.input.value = "show me";
  await h.flush();
  h.mockInput.pressEnter();
  await settle(h);

  const frame = h.captureCharFrame();
  expect(frame).toContain("ts · 1 line"); // fence framed with its language tag
  expect(frame).toContain("const a = 1;");
  expect(frame).toContain("Try this:"); // surrounding prose still rendered
  expect(frame).not.toContain("```"); // fence lines consumed, never printed

  // Colour, not substring: a plain-text check would pass with no styling at all.
  const spans = h.captureSpans();
  const add = fgOf(spans, "+added line");
  const del = fgOf(spans, "-removed line");
  expect(add).toBeDefined();
  expect(del).toBeDefined();
  if (add === undefined || del === undefined) {
    throw new Error("diff lines were not rendered");
  }
  expect(add[1]).toBeGreaterThan(add[0]); // green dominates an addition
  expect(add[1]).toBeGreaterThan(add[2]);
  expect(del[0]).toBeGreaterThan(del[1]); // red dominates a deletion
  expect(del[0]).toBeGreaterThan(del[2]);
  expect(add).not.toEqual(del);
  h.destroy();
});

// --- AC11: the push/pull adapter, without a renderer ------------------------

/** Drain `io.lines` into an array, recording the order the driver saw them. */
function drain(io: ShellIO): { seen: string[]; ended: Promise<void> } {
  const seen: string[] = [];
  const ended = (async () => {
    for await (const line of io.lines) {
      seen.push(line);
    }
  })();
  return { seen, ended };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("AC11: composer submissions become ShellIO.lines in order, including while a turn runs", async () => {
  const accepted: string[] = [];
  const bridge = createChatBridge({ onAccepted: (line) => accepted.push(line) });
  const seen: string[] = [];
  const iterator = bridge.io.lines[Symbol.asyncIterator]();

  // A submission before anything is pulled is queued, not lost.
  expect(bridge.submit("first")).toBe("accepted");
  expect(bridge.pending()).toBe(1);
  seen.push((await iterator.next()).value as string);
  expect(bridge.turnActive()).toBe(true); // a line is out with the driver

  // Two more arrive WHILE the turn runs: they queue in order behind it.
  expect(bridge.submit("second")).toBe("accepted");
  expect(bridge.submit("third")).toBe("accepted");
  expect(bridge.pending()).toBe(2);

  // …and a slash command mid-turn is refused rather than raced (plan R2).
  expect(bridge.submit("/compact")).toBe("deferred");
  expect(bridge.pending()).toBe(2);

  seen.push((await iterator.next()).value as string);
  seen.push((await iterator.next()).value as string);
  expect(seen).toEqual(["first", "second", "third"]);
  expect(accepted).toEqual(["first", "second", "third"]);
  expect(bridge.pending()).toBe(0);

  // A blank line is never a turn, and a slash command IS accepted when idle:
  // the driver is between turns once it has asked for the next line.
  const pull = iterator.next();
  expect(bridge.turnActive()).toBe(false);
  expect(bridge.submit("   ")).toBe("ignored");
  expect(bridge.submit("/help")).toBe("accepted");
  expect((await pull).value).toBe("/help");
});

test("AC11: the iterator ends cleanly on /exit, during a turn as well as between turns", async () => {
  const between = createChatBridge();
  const b1 = drain(between.io);
  await tick();
  expect(between.submit("hello")).toBe("accepted");
  await tick();
  expect(between.submit("/exit")).toBe("exit");
  await b1.ended; // resolves: the for-await completed rather than hanging
  expect(b1.seen).toEqual(["hello"]);
  // Anything submitted after the close is ignored, never queued for a dead loop.
  expect(between.submit("late")).toBe("ignored");
  expect(between.pending()).toBe(0);

  // Mid-turn: the driver has a line out, so the close is observed at its NEXT
  // pull — the loop still ends, it just does not abandon the running turn.
  const during = createChatBridge();
  const iterator = during.io.lines[Symbol.asyncIterator]();
  during.submit("slow question");
  expect((await iterator.next()).value).toBe("slow question");
  expect(during.submit("/quit")).toBe("exit"); // `/quit` aliases `/exit`
  expect(during.turnActive()).toBe(true);
  expect((await iterator.next()).done).toBe(true);

  // `return()` (an early `break` in the driver) closes it too.
  const broken = createChatBridge();
  const it2 = broken.io.lines[Symbol.asyncIterator]();
  await it2.return?.();
  expect((await it2.next()).done).toBe(true);
});

test("AC11: the \"\\n\\n\" turn separator never reaches the transcript as content", () => {
  const text: string[] = [];
  const settled: number[] = [];
  const bridge = createChatBridge({
    onText: (chunk) => text.push(chunk),
    onTurnSettled: () => settled.push(text.length),
  });

  // One full turn, exactly as `runShell` drives it: start → deltas → end →
  // separator. The separator arrives AFTER the message closed, so forwarding it
  // would open an empty trailing message block.
  bridge.io.onTurnStart?.();
  bridge.io.write("hello ");
  bridge.io.write("world");
  bridge.io.onTurnEnd?.("hello world");
  bridge.io.write("\n\n");
  expect(text).toEqual(["hello ", "world"]);

  // A turn that produced NOTHING (a provider error) gets no `onTurnEnd` at all,
  // and its separator must be swallowed just the same.
  bridge.io.onTurnStart?.();
  bridge.io.write("\n\n");
  expect(text).toEqual(["hello ", "world"]);

  // A genuine "\n\n" chunk INSIDE a reply is still content — the rule is "not
  // currently streaming", not "the string looks like the separator".
  bridge.io.onTurnStart?.();
  bridge.io.write("para one");
  bridge.io.write("\n\n");
  bridge.io.write("para two");
  bridge.io.onTurnEnd?.("para one\n\npara two");
  bridge.io.write("\n\n");
  expect(text).toEqual(["hello ", "world", "para one", "\n\n", "para two"]);

  // Empty writes are never content either.
  bridge.io.write("");
  expect(text.length).toBe(5);
  expect(settled).toEqual([]); // nothing settles until the driver pulls again
});

test("a reply whose FIRST chunk is the separator keeps its leading blank line", () => {
  const text: string[] = [];
  const bridge = createChatBridge({ onText: (chunk) => text.push(chunk) });

  // Ambiguous at arrival — identical to the no-content turn above — so it is
  // held, not dropped. The chunk that follows proves it was content.
  bridge.io.onTurnStart?.();
  bridge.io.write("\n\n");
  expect(text).toEqual([]); // still undecided
  bridge.io.write("indented block follows");
  expect(text).toEqual(["\n\n", "indented block follows"]);
  bridge.io.onTurnEnd?.("\n\nindented block follows");
  bridge.io.write("\n\n");
  expect(text).toEqual(["\n\n", "indented block follows"]); // trailing one dropped

  // A reply that is ONLY a blank line is still content: `onTurnEnd` fires (it
  // only fires when the turn accumulated something), which resolves the hold.
  bridge.io.onTurnStart?.();
  bridge.io.write("\n\n");
  bridge.io.onTurnEnd?.("\n\n");
  expect(text).toEqual(["\n\n", "indented block follows", "\n\n"]);
  bridge.io.write("\n\n");
  expect(text.length).toBe(3);

  // …and a held separator never leaks into the NEXT turn.
  bridge.io.onTurnStart?.();
  bridge.io.write("\n\n"); // no content follows: a trailing separator
  bridge.io.onTurnStart?.();
  bridge.io.write("plain");
  expect(text).toEqual(["\n\n", "indented block follows", "\n\n", "plain"]);
});
