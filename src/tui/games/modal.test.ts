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
  expect(texts.get("game-system")?.content).toContain("system:");
  expect(texts.get("game-stats")?.content).toContain("model:");
  expect(String(texts.get("game-stats")?.content)).toContain("turns 0");
});

test("a model turn updates board, stats and status", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(() => usageProvider("0")));
  press({ name: "enter", sequence: "\r" }); // X at centre
  await settle();
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-stats")?.content)).toContain("turns 1");
  expect(String(texts.get("game-stats")?.content)).toContain("in 40");
  expect(String(texts.get("game-stats")?.content)).toContain("out 3");
  expect(String(texts.get("game-stats")?.content)).toContain("reasoning");
});

test("a hung model turn hits the deadline and plays a local move", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(hangingProvider), { timeoutMs: 20 });
  press({ name: "enter", sequence: "\r" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-notice")?.content)).toContain("timed out");
  expect(String(texts.get("game-stats")?.content)).toContain("fallbacks 1");
});

test("restart resets the board and the stats", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(() => stubProvider("0")));
  press({ name: "enter", sequence: "\r" });
  await settle();
  press({ name: "r", sequence: "r" });
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-stats")?.content)).toContain("turns 0");
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
  expect(String(texts.get("game-stats")?.content)).toContain("errors 1");
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
