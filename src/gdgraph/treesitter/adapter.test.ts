import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createTreesitterSpec, type BuildInput } from "./adapter";
import type { TsNode } from "./extract";
import { enrichBuildWithSymbols } from "../enrich";
import type { CallEdge, SymbolLayer, SymbolNode } from "../types";

// --- tiny structural mock tree: one top-level function `boot` that calls `tick` ---
function mk(o: {
  type: string;
  line?: number;
  endLine?: number;
  text?: string;
  fields?: Record<string, TsNode | null>;
  namedChildren?: TsNode[];
}): TsNode {
  const line = o.line ?? 1;
  const named = o.namedChildren ?? [];
  return {
    type: o.type,
    text: o.text ?? "",
    startPosition: { row: line - 1, column: 0 },
    endPosition: { row: (o.endLine ?? line) - 1, column: 0 },
    childForFieldName: (field: string) => o.fields?.[field] ?? null,
    namedChildren: named,
    children: named,
  };
}

function bootTree(): TsNode {
  const id = (t: string) => mk({ type: "identifier", text: t });
  const body = mk({
    type: "statement_block",
    line: 1,
    namedChildren: [mk({ type: "call_expression", line: 1, fields: { function: id("tick") }, text: "tick()" })],
  });
  const boot = mk({
    type: "function_declaration",
    line: 1,
    endLine: 2,
    fields: { name: id("boot"), parameters: mk({ type: "formal_parameters", text: "()" }) },
    namedChildren: [body],
  });
  const tick = mk({
    type: "function_declaration",
    line: 3,
    endLine: 3,
    fields: { name: id("tick"), parameters: mk({ type: "formal_parameters", text: "()" }) },
  });
  return mk({ type: "program", line: 1, endLine: 3, namedChildren: [boot, tick] });
}

// A structural mock of the `web-tree-sitter` module (a Parser constructor with
// static `init` + `Language.load`). Parse always returns the bootTree.
function mockParserModule(): unknown {
  function MockParser(this: unknown) {}
  (MockParser as unknown as { init: () => Promise<void> }).init = async () => {};
  (MockParser as unknown as { Language: { load: (p: string) => Promise<unknown> } }).Language = {
    load: async () => ({}),
  };
  MockParser.prototype.setLanguage = function setLanguage(): void {};
  MockParser.prototype.parse = function parse(): { rootNode: TsNode } {
    return { rootNode: bootTree() };
  };
  return MockParser;
}

// Create a temp workspace whose lockfile pins a real on-disk grammar file so the
// Asset Resolver verifies it (availability-true), with a config grammarsPath (T1).
async function makeWorkspaceWithGrammar(): Promise<{ root: string; grammarsDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-ts-"));
  const grammarsDir = path.join(root, "grammars");
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await mkdir(grammarsDir, { recursive: true });
  const wasmPath = path.join(grammarsDir, "tree-sitter-typescript.wasm");
  const bytes = Buffer.from("fake-grammar-bytes");
  await writeFile(wasmPath, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    path.join(root, ".metaproject", "assets.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      assets: {
        "tree-sitter-typescript": {
          version: "0.22.0",
          url: "https://example.dev/tree-sitter-typescript.wasm",
          sha256: sha,
          size: bytes.length,
        },
      },
    }),
  );
  return { root, grammarsDir };
}

test("AC5.2 availability-true — adapter isAvailable + run() yields the symbol layer", async () => {
  const { root, grammarsDir } = await makeWorkspaceWithGrammar();
  try {
    const spec = createTreesitterSpec(root, { languages: ["typescript"], grammarsPath: grammarsDir });
    const adapter = spec.load({ dep: mockParserModule(), asset: null });

    expect(await adapter.isAvailable()).toBe(true);

    const layer = await adapter.run({ files: [{ path: "src/boot.ts", content: "ignored-by-mock" }] });
    const symbolIds = layer.symbols.map((symbol: SymbolNode) => symbol.id).sort();
    expect(symbolIds).toEqual(["src/boot.ts#boot", "src/boot.ts#tick"]);
    const callKinds = layer.calls.map((call: CallEdge) => `${call.kind}:${call.from}=>${call.to}`);
    expect(callKinds).toContain("calls:src/boot.ts#boot=>src/boot.ts#tick");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC5.2 availability-false — no grammar ⇒ isAvailable false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-ts-none-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const spec = createTreesitterSpec(root, { languages: ["typescript"], grammarsPath: null });
    const adapter = spec.load({ dep: mockParserModule(), asset: null });
    expect(await adapter.isAvailable()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("availability-false — missing dep ⇒ isAvailable false", async () => {
  const { root, grammarsDir } = await makeWorkspaceWithGrammar();
  try {
    const spec = createTreesitterSpec(root, { languages: ["typescript"], grammarsPath: grammarsDir });
    const adapter = spec.load({ dep: undefined, asset: null });
    expect(await adapter.isAvailable()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC1.1 additive write path — enrich writes symbols.jsonl + calls.jsonl via a mock adapter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-enrich-"));
  try {
    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    const expectedLayer: SymbolLayer = {
      symbols: [
        {
          id: "src/x.ts#run",
          kind: "function",
          path: "src/x.ts",
          name: "run",
          container: null,
          startLine: 1,
          endLine: 1,
          language: "typescript",
          signature: "run()",
        },
      ],
      calls: [{ id: "defines:src/x.ts=>src/x.ts#run", from: "src/x.ts", to: "src/x.ts#run", kind: "defines", resolved: true }],
    };

    const injected = async () => ({
      id: "gdgraph.treesitter",
      isAvailable: async () => true,
      run: async (_input: BuildInput) => expectedLayer,
    });

    const result = await enrichBuildWithSymbols(root, [{ path: "src/x.ts", content: "" }], injected);
    expect(result.enriched).toBe(true);
    expect(result.symbols).toBe(1);

    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    const symbolsFile = await readFile(path.join(storage, "symbols.jsonl"), "utf8");
    const callsFile = await readFile(path.join(storage, "calls.jsonl"), "utf8");
    expect(symbolsFile.trim()).toBe(JSON.stringify(expectedLayer.symbols[0]));
    expect(callsFile.trim()).toBe(JSON.stringify(expectedLayer.calls[0]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
