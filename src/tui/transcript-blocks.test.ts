import { describe, expect, test } from "bun:test";
import { segmentMarkdown } from "../lib/md-blocks";
import {
  createBlockNavController,
  createBlockRegistry,
  createStreamSegmenter,
  EVICTED_BLOCK_TEXT,
  TRUNCATED_BLOCK_NOTICE,
  UNKNOWN_BLOCK_TEXT,
  type BlockRegistry,
} from "./transcript-blocks";

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

  // Changed in T6/F5: an unknown id used to return EVICTED_BLOCK_TEXT, so a
  // caller could not tell "retention dropped it" from "never existed" and a
  // typo'd id copied the marker string under a "Copied to clipboard" toast.
  test("bodyText distinguishes an unknown id from an evicted block", () => {
    const registry = createBlockRegistry({ maxBlocks: 1 });
    const evicted = registry.register(block(1));
    registry.register(block(2));

    expect(registry.bodyText("no-such-block")).toBe(UNKNOWN_BLOCK_TEXT);
    expect(registry.bodyText(evicted)).toBe(EVICTED_BLOCK_TEXT);
    expect(UNKNOWN_BLOCK_TEXT).not.toBe(EVICTED_BLOCK_TEXT);
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

// --- the char cap is a real bound (AC8 / D-4 — T6/F2) ----------------------
//
// `enforceBounds` refuses to evict the newest retained block, so before this a
// SINGLE payload larger than `maxRetainedChars` escaped the cap entirely and was
// held for the process lifetime. The existing tests above only used 8-char
// payloads, so none of them ever crossed the cap in one register call.

describe("createBlockRegistry: oversized payloads (AC8)", () => {
  const oversized = "x".repeat(5_000);

  test("a single payload larger than the cap is clipped to the cap, not admitted whole", () => {
    const registry = createBlockRegistry({ maxRetainedChars: 100 });
    const id = registry.register({ kind: "output", summary: "big", fullText: oversized, lineCount: 1 });
    const state = registry.get(id);

    expect(state?.retained).toBe(true); // still expandable — its HEAD is kept
    expect(state?.truncated).toBe(true);
    expect(state?.fullText).toBe("x".repeat(100));
    expect(registry.retainedChars()).toBe(100);
    expect(registry.retainedChars()).toBeLessThanOrEqual(100);
  });

  test("the retained head is the START of the payload and the body flags the truncation", () => {
    const registry = createBlockRegistry({ maxRetainedChars: 20 });
    const id = registry.register({ kind: "output", summary: "big", fullText: `HEAD-${oversized}`, lineCount: 1 });

    expect(registry.bodyText(id).startsWith("HEAD-")).toBe(true);
    expect(registry.bodyText(id)).toContain(TRUNCATED_BLOCK_NOTICE);
    expect(registry.get(id)?.lineCount).toBe(1); // metadata describes the ORIGINAL
  });

  test("the cap still holds after a run of oversized payloads", () => {
    const registry = createBlockRegistry({ maxRetainedChars: 100 });
    for (let n = 0; n < 5; n++) {
      registry.register({ kind: "output", summary: `s${n}`, fullText: oversized, lineCount: 1 });
      expect(registry.retainedChars()).toBeLessThanOrEqual(100);
    }
    // Only the newest survives retained; the rest keep metadata + the marker.
    const list = registry.list();
    expect(list.map((b) => b.retained)).toEqual([false, false, false, false, true]);
    expect(registry.bodyText(list[0]?.id ?? "")).toBe(EVICTED_BLOCK_TEXT);
  });

  test("a payload that exactly fills the cap is retained whole and not marked truncated", () => {
    const registry = createBlockRegistry({ maxRetainedChars: 10 });
    const id = registry.register({ kind: "output", summary: "s", fullText: "0123456789", lineCount: 1 });

    expect(registry.get(id)?.truncated).toBe(false);
    expect(registry.bodyText(id)).toBe("0123456789");
    expect(registry.retainedChars()).toBe(10);
  });
});

// --- copy honesty (T6/F5) --------------------------------------------------
//
// `copy` used to hand `bodyText(id)` to the clipboard unconditionally and always
// toast "Copied to clipboard" — so copying an evicted block put the marker
// string on the clipboard and reported success. No `otui` is involved in the
// controller's copy path, so this runs without the optional dependency.

function navHarness(registry: BlockRegistry): {
  nav: ReturnType<typeof createBlockNavController>;
  copied: string[];
  toasts: string[];
} {
  const copied: string[] = [];
  const toasts: string[] = [];
  const nav = createBlockNavController({
    registry,
    view: () => undefined,
    scroll: { scrollTop: 0, stickyScroll: true },
    isBlocked: () => false,
    focusComposer: () => {},
    blurComposer: () => {},
    copyText: (text) => {
      copied.push(text);
    },
    toast: (message) => {
      toasts.push(message);
    },
    schedule: (run) => run(),
  });
  return { nav, copied, toasts };
}

describe("createBlockNavController: copy", () => {
  test("a retained block copies its payload and toasts success", () => {
    const registry = createBlockRegistry();
    const id = registry.register(block(1));
    const h = navHarness(registry);

    expect(h.nav.copy(id)).toBe(true);
    expect(h.copied).toEqual(["full text 1"]);
    expect(h.toasts).toEqual(["Copied to clipboard"]);
  });

  test("an evicted block copies NOTHING and says so instead of claiming success", () => {
    const registry = createBlockRegistry({ maxBlocks: 1 });
    const evicted = registry.register(block(1));
    registry.register(block(2));
    const h = navHarness(registry);

    expect(h.nav.copy(evicted)).toBe(false);
    expect(h.copied).toEqual([]);
    expect(h.toasts).toEqual(["Output no longer retained"]);
    expect(h.toasts).not.toContain("Copied to clipboard");
  });

  test("an unknown id copies nothing and toasts nothing", () => {
    const registry = createBlockRegistry();
    const h = navHarness(registry);

    expect(h.nav.copy("no-such-block")).toBe(false);
    expect(h.copied).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test("a truncated block copies its head and says the copy is partial", () => {
    const registry = createBlockRegistry({ maxRetainedChars: 8 });
    const id = registry.register({ kind: "output", summary: "s", fullText: "x".repeat(100), lineCount: 1 });
    const h = navHarness(registry);

    expect(h.nav.copy(id)).toBe(true);
    expect(h.copied[0]).toBe(`${"x".repeat(8)}\n${TRUNCATED_BLOCK_NOTICE}`);
    expect(h.toasts).toEqual(["Copied to clipboard (truncated)"]);
  });

  test("a clipboard refusal is still reported as a failure with no toast", () => {
    const registry = createBlockRegistry();
    const id = registry.register(block(1));
    const toasts: string[] = [];
    const nav = createBlockNavController({
      registry,
      view: () => undefined,
      scroll: { scrollTop: 0, stickyScroll: true },
      isBlocked: () => false,
      focusComposer: () => {},
      blurComposer: () => {},
      copyText: () => {
        throw new Error("clipboard not permitted");
      },
      toast: (message) => {
        toasts.push(message);
      },
      schedule: (run) => run(),
    });

    expect(nav.copy(id)).toBe(false);
    expect(toasts).toEqual([]);
  });
});

// --- streaming segmentation (risk R1 — T6/F4) ------------------------------

describe("createStreamSegmenter", () => {
  test("a fence split across chunk boundaries (mid-marker) still opens a code segment", () => {
    const s = createStreamSegmenter();
    s.push("intro\n`");
    s.push("``t");
    s.push("s\nconst x = 1;\n");
    const { segments } = s.state();

    expect(segments).toEqual([
      { kind: "text", text: "intro" },
      { kind: "code", lang: "ts", body: "const x = 1;" },
    ]);
  });

  test("token-by-token streaming ends at the same segments as segmentMarkdown", () => {
    const md = "before\n```ts\nconst x = 1;\n```\nafter\n";
    const s = createStreamSegmenter();
    for (const ch of md) {
      s.push(ch);
    }
    expect(s.state().segments).toEqual(segmentMarkdown(md.replace(/\n$/, "")));
  });

  test("R1: a token never re-segments the buffer — frozen segments keep their identity", () => {
    const s = createStreamSegmenter();
    s.push("a\n```ts\n1\n```\nb\n```py\n2\n```\n");
    const settled = s.state();
    expect(settled.frozen).toBe(4); // text, ```ts, text, ```py — all closed
    const before = settled.segments.slice(0, settled.frozen);

    for (const ch of "trailing prose keeps arriving\nand more\n") {
      s.push(ch);
      const now = s.state();
      expect(now.frozen).toBeGreaterThanOrEqual(settled.frozen); // monotonic
      for (const [i, segment] of before.entries()) {
        // Reference identity: a frozen segment is never rebuilt, so the caller
        // only ever repaints the single trailing segment.
        expect(now.segments[i]).toBe(segment);
      }
    }
  });

  test("frozen only advances when a closing fence lands, and never counts the trailing segment", () => {
    const s = createStreamSegmenter();
    expect(s.push("prose\n").frozen).toBe(0);
    expect(s.push("```ts\n").frozen).toBe(1); // the prose froze when the fence opened
    expect(s.push("const x = 1;\n").frozen).toBe(1);
    const closed = s.push("```\n");
    expect(closed.frozen).toBe(2);
    expect(closed.segments).toHaveLength(2); // no empty trailing text segment
  });

  test("reset() drops every frozen and pending segment", () => {
    const s = createStreamSegmenter();
    s.push("a\n```ts\n1\n```\ntail");
    expect(s.state().segments.length).toBeGreaterThan(0);

    s.reset();
    expect(s.state()).toEqual({ segments: [], frozen: 0 });

    // …and the next message starts clean, including the in-code flag.
    expect(s.push("plain").segments).toEqual([{ kind: "text", text: "plain" }]);
  });

  test("reset() clears an UNCLOSED fence so the next message is not swallowed as code", () => {
    const s = createStreamSegmenter();
    s.push("```ts\nconst x = 1;\n");
    expect(s.state().segments[0]?.kind).toBe("code");

    s.reset();
    expect(s.push("plain prose\n").segments).toEqual([{ kind: "text", text: "plain prose" }]);
  });

  test("DELIBERATE divergence: a trailing PARTIAL line is not fence-tested", () => {
    const s = createStreamSegmenter();
    // Mid-stream the fence marker is still part of an incomplete line, so it
    // shows as prose for exactly one token…
    expect(s.push("a\n```ts").segments).toEqual([{ kind: "text", text: "a\n```ts" }]);
    expect(segmentMarkdown("a\n```ts")).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "ts", body: "" },
    ]);
    // …and is replaced by the code segment the moment the line completes.
    expect(s.push("\n").segments).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "ts", body: "" },
    ]);
  });

  test("an unterminated fence keeps reporting the partial body as the trailing segment", () => {
    const s = createStreamSegmenter();
    s.push("```js\nconst partial = (");
    const { segments, frozen } = s.state();

    expect(frozen).toBe(0);
    expect(segments).toEqual([{ kind: "code", lang: "js", body: "const partial = (" }]);
  });

  test("CRLF chunks segment exactly like LF chunks", () => {
    const crlf = createStreamSegmenter();
    crlf.push("a\r\n```ts\r\nx\r\n```\r\nb\r\n");
    const lf = createStreamSegmenter();
    lf.push("a\n```ts\nx\n```\nb\n");

    expect(crlf.state()).toEqual(lf.state());
    expect(crlf.state().segments).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "ts", body: "x" },
      { kind: "text", text: "b" },
    ]);
  });
});
