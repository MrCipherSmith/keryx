import { describe, expect, test } from "bun:test";
import { createBlockRegistry, EVICTED_BLOCK_TEXT } from "./transcript-blocks";

// flow 109 / T2 — RED phase. `src/tui/transcript-blocks.ts` does not exist yet.
// Registry half only: pure state machine, no `@opentui/core` import at any
// level (not even a type import) so this file runs without the optional dep.

type BlockInput = {
  kind: string;
  summary: string;
  fullText: string;
  lineCount: number;
};

function block(n: number, overrides: Partial<BlockInput> = {}): BlockInput {
  return {
    kind: "tool",
    summary: `summary ${n}`,
    fullText: `full text ${n}`,
    lineCount: n,
    ...overrides,
  };
}

// --- registration & per-block collapse (AC2) -------------------------------

describe("createBlockRegistry: registration and collapse", () => {
  test("register returns a distinct id per block and list() keeps registration order", () => {
    const registry = createBlockRegistry();
    const ids = [registry.register(block(1)), registry.register(block(2)), registry.register(block(3))];

    expect(new Set(ids).size).toBe(3);
    expect(registry.list().map((b) => b.id)).toEqual(ids);
    expect(registry.list().map((b) => b.summary)).toEqual(["summary 1", "summary 2", "summary 3"]);
  });

  test("a newly registered block starts collapsed and retains its payload", () => {
    const registry = createBlockRegistry();
    const id = registry.register(block(1, { kind: "thought", lineCount: 14 }));
    const state = registry.get(id);

    expect(state?.collapsed).toBe(true);
    expect(state?.retained).toBe(true);
    expect(state?.kind).toBe("thought");
    expect(state?.lineCount).toBe(14);
    expect(state?.fullText).toBe("full text 1");
  });

  test("AC2: toggling one block leaves every other block's collapsed state untouched", () => {
    const registry = createBlockRegistry();
    const [a, b, c] = [registry.register(block(1)), registry.register(block(2)), registry.register(block(3))];

    registry.toggle(b);

    expect(registry.get(a)?.collapsed).toBe(true);
    expect(registry.get(b)?.collapsed).toBe(false);
    expect(registry.get(c)?.collapsed).toBe(true);
  });

  test("AC2: toggling the same block twice returns it to the original state", () => {
    const registry = createBlockRegistry();
    const id = registry.register(block(1));

    registry.toggle(id);
    expect(registry.get(id)?.collapsed).toBe(false);
    registry.toggle(id);
    expect(registry.get(id)?.collapsed).toBe(true);
  });

  test("get() and toggle() on an unknown id are inert", () => {
    const registry = createBlockRegistry();
    const id = registry.register(block(1));

    expect(registry.get("no-such-block")).toBeUndefined();
    expect(() => registry.toggle("no-such-block")).not.toThrow();
    expect(registry.get(id)?.collapsed).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });
});

// --- focus movement --------------------------------------------------------

describe("createBlockRegistry: focus", () => {
  test("an empty registry has no focused block and focus moves are no-ops", () => {
    const registry = createBlockRegistry();

    expect(registry.focused()).toBeUndefined();
    expect(registry.focusNext()).toBeUndefined();
    expect(registry.focusPrev()).toBeUndefined();
  });

  test("the first registration takes focus", () => {
    const registry = createBlockRegistry();
    const first = registry.register(block(1));
    registry.register(block(2));

    expect(registry.focused()?.id).toBe(first);
  });

  test("focusNext walks forward and clamps at the last block", () => {
    const registry = createBlockRegistry();
    const [a, b, c] = [registry.register(block(1)), registry.register(block(2)), registry.register(block(3))];

    expect(registry.focused()?.id).toBe(a);
    expect(registry.focusNext()?.id).toBe(b);
    expect(registry.focusNext()?.id).toBe(c);
    expect(registry.focusNext()?.id).toBe(c);
    expect(registry.focused()?.id).toBe(c);
  });

  test("focusPrev walks backward and clamps at the first block", () => {
    const registry = createBlockRegistry();
    const [a, b, c] = [registry.register(block(1)), registry.register(block(2)), registry.register(block(3))];

    registry.focusNext();
    registry.focusNext();
    expect(registry.focused()?.id).toBe(c);
    expect(registry.focusPrev()?.id).toBe(b);
    expect(registry.focusPrev()?.id).toBe(a);
    expect(registry.focusPrev()?.id).toBe(a);
    expect(registry.focused()?.id).toBe(a);
  });

  test("focus moves never return undefined while at least one block exists", () => {
    const registry = createBlockRegistry();
    registry.register(block(1));

    expect(registry.focusPrev()).toBeDefined();
    expect(registry.focusNext()).toBeDefined();
    expect(registry.focused()).toBeDefined();
  });

  test("focus stays on the same block id when a new block is registered", () => {
    const registry = createBlockRegistry();
    registry.register(block(1));
    const b = registry.register(block(2));
    registry.focusNext();
    expect(registry.focused()?.id).toBe(b);

    registry.register(block(3));
    expect(registry.focused()?.id).toBe(b);

    registry.register(block(4));
    expect(registry.focused()?.id).toBe(b);
  });
});

// --- bounded retention (AC8) ----------------------------------------------

describe("createBlockRegistry: bounded retention (AC8)", () => {
  test("default options retain a handful of blocks", () => {
    const registry = createBlockRegistry();
    const ids = [1, 2, 3, 4, 5].map((n) => registry.register(block(n)));

    for (const id of ids) {
      expect(registry.get(id)?.retained).toBe(true);
      expect(registry.get(id)?.fullText).toBe(`full text ${registry.get(id)?.lineCount}`);
    }
  });

  test("maxBlocks: a third registration evicts the oldest block's fullText but keeps its metadata", () => {
    const registry = createBlockRegistry({ maxBlocks: 2 });
    const [a, b, c] = [registry.register(block(1)), registry.register(block(2)), registry.register(block(3))];

    const oldest = registry.get(a);
    expect(oldest).toBeDefined();
    expect(oldest?.id).toBe(a);
    expect(oldest?.retained).toBe(false);
    expect(oldest?.fullText).toBeUndefined();
    expect(oldest?.summary).toBe("summary 1");
    expect(oldest?.kind).toBe("tool");
    expect(oldest?.lineCount).toBe(1);

    expect(registry.get(b)?.retained).toBe(true);
    expect(registry.get(b)?.fullText).toBe("full text 2");
    expect(registry.get(c)?.retained).toBe(true);
    expect(registry.get(c)?.fullText).toBe("full text 3");
  });

  test("maxBlocks: evicted blocks stay addressable in list()", () => {
    const registry = createBlockRegistry({ maxBlocks: 2 });
    const ids = [registry.register(block(1)), registry.register(block(2)), registry.register(block(3))];

    expect(registry.list().map((b) => b.id)).toEqual(ids);
    expect(registry.list().map((b) => b.retained)).toEqual([false, true, true]);
  });

  test("maxRetainedChars: the oldest block is evicted once the total retained text exceeds the cap", () => {
    // Each fullText below is 8 chars; a cap of 10 admits exactly one at a time.
    const registry = createBlockRegistry({ maxRetainedChars: 10 });
    const a = registry.register({ kind: "tool", summary: "s1", fullText: "aaaaaaaa", lineCount: 1 });
    expect(registry.get(a)?.retained).toBe(true);

    const b = registry.register({ kind: "tool", summary: "s2", fullText: "bbbbbbbb", lineCount: 1 });

    expect(registry.get(a)?.retained).toBe(false);
    expect(registry.get(a)?.fullText).toBeUndefined();
    expect(registry.get(a)?.summary).toBe("s1");
    expect(registry.get(b)?.retained).toBe(true);
    expect(registry.get(b)?.fullText).toBe("bbbbbbbb");
  });

  test("maxRetainedChars: blocks that fit under the cap are all retained", () => {
    const registry = createBlockRegistry({ maxRetainedChars: 100 });
    const ids = [1, 2, 3].map((n) => registry.register({ kind: "tool", summary: `s${n}`, fullText: "xx", lineCount: 1 }));

    expect(ids.map((id) => registry.get(id)?.retained)).toEqual([true, true, true]);
  });

  test("AC8: expanding an evicted block yields the documented marker instead of its text", () => {
    const registry = createBlockRegistry({ maxBlocks: 1 });
    const a = registry.register(block(1));
    const b = registry.register(block(2));

    expect(EVICTED_BLOCK_TEXT).toContain("output no longer retained");
    expect(registry.bodyText(a)).toBe(EVICTED_BLOCK_TEXT);
    expect(registry.bodyText(b)).toBe("full text 2");
  });

  test("bodyText of an unknown id is the evicted marker", () => {
    const registry = createBlockRegistry();
    expect(registry.bodyText("no-such-block")).toBe(EVICTED_BLOCK_TEXT);
  });

  test("an evicted block can still be toggled and focused", () => {
    const registry = createBlockRegistry({ maxBlocks: 1 });
    const a = registry.register(block(1));
    registry.register(block(2));

    expect(registry.get(a)?.retained).toBe(false);
    registry.toggle(a);
    expect(registry.get(a)?.collapsed).toBe(false);
    expect(registry.focused()?.id).toBe(a);
  });
});
