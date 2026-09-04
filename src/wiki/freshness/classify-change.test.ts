// LWG-7 change classification (flow 226): AC1, AC2 (classification half), AC4.

import { describe, expect, test } from "bun:test";
import type { SymbolLayer } from "../../gdgraph/types";
import { changedSignatures, classifyChanges, normalizeSource } from "./classify-change";

function layer(symbols: Array<{ id: string; signature?: string; name?: string }>): SymbolLayer {
  return {
    symbols: symbols.map((s) => ({
      id: s.id,
      kind: "function" as const,
      path: s.id.split("#")[0] ?? "",
      name: s.name ?? (s.id.split("#")[1] ?? s.id),
      container: null,
      startLine: 1,
      endLine: 2,
      language: "typescript" as const,
      ...(s.signature === undefined ? {} : { signature: s.signature }),
    })),
    calls: [],
  };
}

/** Extractor keyed on content, so before/after get different layers. */
function extractorFor(map: Record<string, SymbolLayer>) {
  return async (files: Array<{ path: string; content: string }>) => {
    const content = files[0]?.content ?? "";
    return map[content] ?? layer([]);
  };
}

async function classify(change: Parameters<typeof classifyChanges>[0]["changes"][number], extractor?: unknown) {
  const result = await classifyChanges({
    changes: [change],
    extractSymbols: (extractor as never) ?? null,
  });
  return result.changes[0];
}

describe("normalizeSource", () => {
  test("comments and reflowing are erased", () => {
    const before = "// a comment\nexport const x = 1;\n";
    const after = "export const x   =   1;   /* another */\n";
    expect(normalizeSource(before, "a.ts")).toBe(normalizeSource(after, "a.ts"));
  });

  test("a `//` inside a string is not a comment", () => {
    const before = 'const url = "http://example.com"; // note\n';
    const after = 'const url = "http://example.com";\n';
    expect(normalizeSource(before, "a.ts")).toBe(normalizeSource(after, "a.ts"));
    // And the URL survives, rather than being truncated at the slashes.
    expect(normalizeSource(before, "a.ts")).toContain("http://example.com");
  });

  test("a real change survives normalisation", () => {
    expect(normalizeSource("const x = 1;", "a.ts")).not.toBe(normalizeSource("const x = 2;", "a.ts"));
  });

  test("an unterminated literal aborts normalisation and returns the input", () => {
    // Failing towards "looks substantive" costs a wasted backlog entry;
    // failing the other way would silently drop a real change.
    const broken = 'const s = "unterminated\n';
    expect(normalizeSource(broken, "a.ts")).toBe(broken);
  });

  test("python uses # comments", () => {
    expect(normalizeSource("# c\nx = 1\n", "a.py")).toBe(normalizeSource("x = 1\n", "a.py"));
  });

  test("an unknown extension is left alone rather than guessed at", () => {
    const text = "# not necessarily a comment\n";
    expect(normalizeSource(text, "a.txt")).toBe(text);
  });
});

describe("classifyChanges — lifecycle classes", () => {
  test("added and removed", async () => {
    expect((await classify({ path: "a.ts", after: "x" }))?.changeClass).toBe("added");
    expect((await classify({ path: "a.ts", before: "x" }))?.changeClass).toBe("removed");
  });

  test("a pure rename is `moved`", async () => {
    const result = await classify({ path: "b.ts", previousPath: "a.ts", before: "x", after: "x" });
    expect(result?.changeClass).toBe("moved");
    expect(result?.previousPath).toBe("a.ts");
  });

  test("a rename that also changes a signature reports the stronger fact", async () => {
    const extractor = extractorFor({
      old: layer([{ id: "a.ts#run", signature: "run(): void" }]),
      new: layer([{ id: "a.ts#run", signature: "run(x: number): void" }]),
    });
    const result = await classify(
      { path: "b.ts", previousPath: "a.ts", before: "old", after: "new" },
      extractor,
    );
    // Reporting only "moved" would lose the signature change.
    expect(result?.changeClass).toBe("signature");
  });
});

describe("classifyChanges — cosmetic must produce no work (AC1)", () => {
  test("a comment-and-formatting-only edit is cosmetic, even with an extractor present", async () => {
    const extractor = extractorFor({});
    const result = await classify(
      {
        path: "a.ts",
        before: "// old note\nexport const x = 1;\n",
        after: "export const x = 1; // new note\n",
      },
      extractor,
    );
    expect(result?.changeClass).toBe("cosmetic");
    expect(result?.symbols).toEqual([]);
  });
});

describe("classifyChanges — signature vs body (AC2)", () => {
  const before = "export function run(): void {}\n";
  const after = "export function run(x: number): void {}\n";

  test("a changed signature is reported with the symbol name", async () => {
    const extractor = extractorFor({
      [before]: layer([{ id: "a.ts#run", signature: "run(): void" }]),
      [after]: layer([{ id: "a.ts#run", signature: "run(x: number): void" }]),
    });
    const result = await classify({ path: "a.ts", before, after }, extractor);
    expect(result?.changeClass).toBe("signature");
    expect(result?.symbols).toEqual(["run"]);
  });

  test("a body-only edit with identical signatures is `body`", async () => {
    const same = layer([{ id: "a.ts#run", signature: "run(): void" }]);
    const extractor = extractorFor({ [before]: same, [after]: same });
    const result = await classify({ path: "a.ts", before, after }, extractor);
    expect(result?.changeClass).toBe("body");
    expect(result?.symbols).toEqual([]);
  });
});

describe("classifyChanges — degradation is explicit (AC4)", () => {
  test("with no extractor, a substantive change is `body` and never `signature`", async () => {
    const result = await classifyChanges({
      changes: [{ path: "a.ts", before: "export function run(): void {}", after: "export function run(x: number): void {}" }],
      extractSymbols: null,
    });
    expect(result.changes[0]?.changeClass).toBe("body");
    expect(result.symbolLayerAvailable).toBe(false);
  });

  test("an extractor that throws degrades to `body` rather than guessing", async () => {
    const result = await classifyChanges({
      changes: [{ path: "a.ts", before: "a", after: "b" }],
      extractSymbols: async () => {
        throw new Error("adapter exploded");
      },
    });
    expect(result.changes[0]?.changeClass).toBe("body");
    // The layer WAS available; only this file failed. Reporting otherwise
    // would blame the wrong thing in the report's limitations.
    expect(result.symbolLayerAvailable).toBe(true);
  });
});

describe("changedSignatures", () => {
  test("added, removed and altered symbols all count; unchanged ones do not", () => {
    const before = layer([
      { id: "a.ts#kept", signature: "kept(): void" },
      { id: "a.ts#gone", signature: "gone(): void" },
      { id: "a.ts#altered", signature: "altered(): void" },
    ]);
    const after = layer([
      { id: "a.ts#kept", signature: "kept(): void" },
      { id: "a.ts#altered", signature: "altered(x: number): void" },
      { id: "a.ts#fresh", signature: "fresh(): void" },
    ]);
    expect(changedSignatures(before, after)).toEqual(["altered", "fresh", "gone"]);
  });

  test("a symbol with no rendered signature still registers its appearance", () => {
    expect(changedSignatures(layer([]), layer([{ id: "a.ts#x" }]))).toEqual(["x"]);
    // ...but does not make an unchanged symbol look changed.
    expect(changedSignatures(layer([{ id: "a.ts#x" }]), layer([{ id: "a.ts#x" }]))).toEqual([]);
  });
});
