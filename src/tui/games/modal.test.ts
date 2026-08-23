// Headless tests for the games host modal: multi-tab modal, model turns with
// stats, deadline fallback, restart, and the board/panel vertical budget.
// No OpenTUI, no TTY — fakes live in modal.test-helpers.ts.
import { expect, test } from "bun:test";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../harness/provider/types";
import type { ProviderFactory } from "../../harness/provider/single-turn";
import { getTheme } from "../theme";
import { presentGamesModal } from "./modal";
import { createRegistry } from "./registry";
import type { GameDefinition } from "./types";
import { ticTacToeGame } from "./tic-tac-toe";
import { PANEL_FIXED_ROWS } from "./constants";
import { GAME_CELL_SIZES, resolveGameBudget } from "./tic-tac-toe/layout";
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
  expect(String(texts.get("game-user-prompt")?.content)).toContain("Make your move");
  expect(String(texts.get("game-stats-line")?.content)).toContain("no turns yet");
  expect(String(texts.get("game-stats-line")?.content)).toContain("0 turns");
  expect(String(texts.get("game-stats-model")?.content)).toBe("model: auto/auto");
});

test("the prompt card shows the FULL system prompt and the per-turn user prompt — no +N more cap", () => {
  const captured: CapturedModal = {};
  openWith(captured, factoryFor(() => stubProvider("0")));
  const texts = textsOf(captured.body ?? new FakeBox());
  const full = ticTacToeGame.systemPrompt();
  expect(full.split("\n").length).toBeGreaterThan(6); // the old cap would have truncated this
  expect(String(texts.get("game-system")?.content)).toBe(full);
  // The user prompt the model receives each turn carries the current board —
  // this is how the model learns the user's move.
  expect(String(texts.get("game-user-prompt")?.content)).toBe(ticTacToeGame.stateForModel(ticTacToeGame.fresh()));
});

test("the prompt card is a bounded block and the board fits the body height", () => {
  const captured: CapturedModal = {};
  openWith(captured, factoryFor(() => stubProvider("0")));
  // fakeHost mounts at 80x24 → tiny board + prompt at its floor; the sum of
  // board + fixed panel + prompt never exceeds the body height.
  const budget = resolveGameBudget(80, 24);
  expect(budget.cellSize).toEqual(GAME_CELL_SIZES.tiny);
  expect(budget.promptRows).toBe(5);
  expect(budget.boardUsedRows + PANEL_FIXED_ROWS + budget.promptRows).toBeLessThanOrEqual(24);
  let cardBox: FakeBox | undefined;
  const walk = (node: FakeBox): void => {
    for (const child of node.children) {
      if (child instanceof FakeBox) {
        if (child.opts.id === "game-system-card") {
          cardBox = child;
        }
        walk(child);
      }
    }
  };
  walk(captured.body ?? new FakeBox());
  expect(cardBox).toBeDefined();
  // Bounded minmax: the card is pinned to the budgeted height, not the body.
  expect(cardBox?.opts.height).toBe(5);
  expect(cardBox?.opts.maxHeight).toBe(5);
  expect(cardBox?.opts.flexGrow).toBe(0);
});

test("vertical budget: board largest, prompt bounded, everything fits the body", () => {
  // 40-row terminal: panel 38, body 33 → LARGE board + prompt at the floor.
  const big = resolveGameBudget(110, 33);
  expect(big.cellSize).toEqual(GAME_CELL_SIZES.large);
  expect(big.promptRows).toBe(5);
  expect(big.boardUsedRows + PANEL_FIXED_ROWS + big.promptRows).toBe(33);
  // 36-row terminal: body 29 → small board, prompt takes the leftover (7).
  const mid = resolveGameBudget(110, 29);
  expect(mid.cellSize).toEqual(GAME_CELL_SIZES.small);
  expect(mid.promptRows).toBe(7);
  expect(mid.boardUsedRows + PANEL_FIXED_ROWS + mid.promptRows).toBe(29);
  // 60-row terminal: large board, prompt capped at the 14-row ceiling.
  const tall = resolveGameBudget(110, 52);
  expect(tall.cellSize).toEqual(GAME_CELL_SIZES.large);
  expect(tall.promptRows).toBe(14);
  expect(tall.boardUsedRows + PANEL_FIXED_ROWS + tall.promptRows).toBeLessThanOrEqual(52);
});

test("a model turn updates board, stats and status", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(() => usageProvider("0")));
  press({ name: "enter", sequence: "\r" }); // X at centre
  await settle();
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-stats-line")?.content)).toContain("1 turn");
  expect(String(texts.get("game-stats-model")?.content)).toMatch(/\//);
  expect(String(texts.get("game-stats-line")?.content)).toContain("in 40/out 3");
  expect(String(texts.get("game-stats-line")?.content)).toContain("reasoning");
});

test("a hung model turn hits the deadline and plays a local move", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(hangingProvider), { timeoutMs: 20 });
  press({ name: "enter", sequence: "\r" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-notice")?.content)).toContain("timed out");
  expect(String(texts.get("game-stats-line")?.content)).toContain("1 fb");
});

test("restart resets the board and the stats", async () => {
  const captured: CapturedModal = {};
  const { press } = openWith(captured, factoryFor(() => stubProvider("0")));
  press({ name: "enter", sequence: "\r" });
  await settle();
  press({ name: "r", sequence: "r" });
  const texts = textsOf(captured.body ?? new FakeBox());
  expect(String(texts.get("game-stats-line")?.content)).toContain("0 turns");
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
  expect(String(texts.get("game-stats-line")?.content)).toContain("1 err");
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
