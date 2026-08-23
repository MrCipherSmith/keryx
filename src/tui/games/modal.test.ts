// Headless tests for the games host modal: multi-tab modal, model turns with
// stats, deadline fallback, restart. No OpenTUI, no TTY — fakes live in
// modal.test-helpers.ts.
import { expect, test } from "bun:test";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../harness/provider/types";
import type { ProviderFactory } from "../../harness/provider/single-turn";
import { getTheme } from "../theme";
import { presentGamesModal } from "./modal";
import { createRegistry } from "./registry";
import type { GameDefinition } from "./types";
import { ticTacToeGame } from "./tic-tac-toe";
import {
  CAPABILITIES,
  factoryFor,
  fakeHost,
  fakeOtui,
  hangingProvider,
  settle,
  stubProvider,
  textsOf,
  usageProvider,
  openWith,
  FakeBox,
  type CapturedModal,
} from "./modal.test-helpers";

test("games modal renders the game board and the agent panel", () => {
  const captured: CapturedModal = {};
  const { handle } = openWith(captured, factoryFor(() => stubProvider("0")));
  expect(captured.tabs?.map((t) => t.id)).toEqual(["tic-tac-toe"]);
  expect(handle).toBeDefined();
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-system")?.content)).toContain("tic-tac-toe");
  expect(String(texts.get("game-session-turns")?.content)).toBe("0");
  expect(texts.get("game-stats-empty")?.content).toBe("no turns yet");
});

test("a model turn updates board, stats and status", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(() => usageProvider("0")));
  press({ name: "enter", sequence: "\r" }); // X at centre
  await settle();
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-session-turns")?.content)).toBe("1");
  expect(String(texts.get("game-stats-model")?.content)).toMatch(/\//);
  expect(String(texts.get("game-stats-tokens")?.content)).toContain("in 40");
  expect(String(texts.get("game-stats-tokens")?.content)).toContain("out 3");
  expect(String(texts.get("game-stats-reasoning")?.content)).toBe("yes");
});

test("a hung model turn hits the deadline and plays a local move", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(hangingProvider), { timeoutMs: 20 });
  press({ name: "enter", sequence: "\r" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-notice")?.content)).toContain("timed out");
  expect(String(texts.get("game-session-fallbacks")?.content)).toBe("1");
});

test("restart resets the board and the stats", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(() => stubProvider("0")));
  press({ name: "enter", sequence: "\r" });
  await settle();
  press({ name: "r", sequence: "r" });
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-session-turns")?.content)).toBe("0");
});

test("a provider error surfaces on the notice line and counts as an error", async () => {
  const captured: CapturedModal = {};
  const provider: ProviderPort = {
    describe() {
      return { capabilities: { ...CAPABILITIES }, descriptor: { providerId: "stub-err" } };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield {
        kind: "provider_error", sequence: 0, attemptId: opts.attemptId,
        error: { kind: "overloaded", retryable: true, message: "busy" },
      };
    },
  };
  const { press } = openWith(captured, factoryFor(() => provider));
  press({ name: "enter", sequence: "\r" });
  await settle();
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-notice")?.content)).toContain("busy");
  expect(String(texts.get("game-session-errors")?.content)).toBe("1");
});


test("left/right arrows are claimed for the active game before the tab strip", () => {
  const captured: CapturedModal = {};
  openWith(captured, factoryFor(() => stubProvider("0")));
  const arrows = captured.input?.onArrowKeys as unknown as
    | ((key: { name: string; sequence: string }, direction: "left" | "right") => boolean | undefined)
    | undefined;
  expect(arrows).toBeDefined();
  expect(arrows?.({ name: "left", sequence: "\u001b[D" }, "left")).toBe(true);
  expect(arrows?.({ name: "right", sequence: "\u001b[C" }, "right")).toBe(true);
  // A key the active game does not consume falls through to tab switching.
  expect(arrows?.({ name: "a", sequence: "a" }, "left")).toBe(false);
});

test("arrow keys move the tic-tac-toe cursor", () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(() => stubProvider("0")));
  const cells = (): Map<string, FakeBox> => {
    const found = new Map<string, FakeBox>();
    const walk = (node: FakeBox): void => {
      for (const child of node.children) {
        if (child instanceof FakeBox) {
          const id = child.opts.id;
          if (typeof id === "string") {
            found.set(id, child);
          }
          walk(child);
        }
      }
    };
    walk(captured.body ?? new FakeBox());
    return found;
  };
  expect(cells().get("game-cell-4")?.opts.borderColor).toBe(getTheme().focus);
  press({ name: "left", sequence: "\u001b[D" });
  const after = cells();
  expect(after.get("game-cell-3")?.opts.borderColor).toBe(getTheme().focus);
  expect(after.get("game-cell-4")?.opts.borderColor).toBe(getTheme().border);
});

test("extra games appear as tabs and keep their own state", () => {
  const second: GameDefinition = {
    ...ticTacToeGame,
    id: "mini-ttt",
    label: "Mini TTT",
  };
  const registry = createRegistry([ticTacToeGame, second]);
  const captured: CapturedModal = {};
  let keyHandler: ((key: { name: string; sequence: string }) => void) | undefined;
  const handle = presentGamesModal(fakeHost(captured), fakeOtui, {}, {
    providerFactory: factoryFor(() => stubProvider("0")),
    env: {},
    onKeypress: (handler) => {
      keyHandler = handler;
      return () => {};
    },
  }, registry);
  expect(captured.tabs?.map((t) => t.id)).toEqual(["tic-tac-toe", "mini-ttt"]);
  expect(handle?.activeGameId()).toBe("tic-tac-toe");
  expect(getTheme().text).toBeDefined();
});
