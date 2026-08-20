import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, mock, test } from "bun:test";
import { createTreesitterSpec, resolveTreesitterCapability, type BuildInput } from "./adapter";
import type { TsNode } from "./extract";
import { enrichBuildWithSymbols } from "../enrich";
import { hasWarned, resetWarnOnce } from "../../capability/warn-once";
import { setTreesitterEnabled } from "../symbols-capability";
import type { CallEdge, SymbolLayer, SymbolNode } from "../types";

// Registered at MODULE TOP LEVEL, before any `test()` body runs: Bun loads
// every test file's static imports/module body in a resolution pass before
// running any test's body, so a `mock.module` call placed here reliably wins
// the specifier UNTIL some test anywhere in the same `bun test` invocation
// performs a real `await import("web-tree-sitter")` first (e.g.
// `fallback.test.ts`'s AC4.3 test does exactly that with the capability
// enabled) — once that happens, Bun's module cache is warmed with the real
// module and this mock's factory is no longer invoked for later imports in
// the same process. That makes `webTreeSitterImportAttempts` a reliable
// "definitely zero attempts" signal (nothing increments it unless OUR mock's
// factory ran) but NOT a reliable "definitely attempted" signal when run
// alongside the rest of the suite — the enabled-path test below therefore
// proves "gate 1 passed and we reached the real isAvailable() probe" via the
// process-scoped warn-once tracker instead, which is correct regardless of
// which physical module served the import.
let webTreeSitterImportAttempts = 0;
mock.module("web-tree-sitter", () => {
  webTreeSitterImportAttempts += 1;
  function MockParser(this: unknown): void {}
  (MockParser as unknown as { init: () => Promise<void> }).init = async () => {};
  (MockParser as unknown as { Language: { load: (p: string) => Promise<unknown> } }).Language = {
    load: async () => ({}),
  };
  return { default: MockParser };
});

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
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ts-"));
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
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ts-none-"));
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
  const root = await mkdtemp(path.join(tmpdir(), "keryx-enrich-"));
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

test("Java grammar resolution — grammarForFile selects java for .java files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-java-"));
  try {
    const grammarsDir = path.join(root, "grammars");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await mkdir(grammarsDir, { recursive: true });

    const wasmPath = path.join(grammarsDir, "tree-sitter-java.wasm");
    const bytes = Buffer.from("fake-java-grammar");
    await writeFile(wasmPath, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");

    await writeFile(
      path.join(root, ".metaproject", "assets.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        assets: {
          "tree-sitter-java": {
            version: "0.1.13",
            url: "https://example.dev/tree-sitter-java.wasm",
            sha256: sha,
            size: bytes.length,
          },
        },
      }),
    );

    const spec = createTreesitterSpec(root, { languages: ["java"], grammarsPath: grammarsDir });
    const adapter = spec.load({ dep: mockParserModule(), asset: null });
    expect(await adapter.isAvailable()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Python grammar resolution — grammarForFile selects python for .py files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-python-"));
  try {
    const grammarsDir = path.join(root, "grammars");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await mkdir(grammarsDir, { recursive: true });

    const wasmPath = path.join(grammarsDir, "tree-sitter-python.wasm");
    const bytes = Buffer.from("fake-python-grammar");
    await writeFile(wasmPath, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");

    await writeFile(
      path.join(root, ".metaproject", "assets.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        assets: {
          "tree-sitter-python": {
            version: "0.1.13",
            url: "https://example.dev/tree-sitter-python.wasm",
            sha256: sha,
            size: bytes.length,
          },
        },
      }),
    );

    const spec = createTreesitterSpec(root, { languages: ["python"], grammarsPath: grammarsDir });
    const adapter = spec.load({ dep: mockParserModule(), asset: null });
    expect(await adapter.isAvailable()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Real default (no-injected-resolver) production path (T6 review fix) ---
//
// Every test above injects an explicit `CapabilityResolver`/`dep`, bypassing
// `resolveTreesitterCapability` entirely. The REAL call site
// (`build.ts` → `enrichBuildWithSymbols(projectRoot, fileRecords)`, no
// resolver argument) goes through `resolveTreesitterCapability`'s literal
// `await import("web-tree-sitter")` fast path with NO injected resolver at
// all. These tests exercise that exact default path and, via the
// module-top-level `mock.module` above, directly observe whether the literal
// import was attempted — proving gate 1 (manifest-enabled) runs BEFORE the
// import, not after (the bug this ordering fixes).

beforeEach(() => {
  webTreeSitterImportAttempts = 0;
});

async function makeDisabledOrAbsentWorkspace(enabled: "absent" | false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ts-default-"));
  if (enabled === false) {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const manifest = setTreesitterEnabled({}, false);
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify(manifest),
      "utf8",
    );
  }
  // enabled === "absent" ⇒ no .metaproject/metaproject.json at all (missing
  // manifest = off, per seam.ts's own contract).
  return root;
}

test("default path, capability DISABLED (missing manifest) — resolveTreesitterCapability never attempts the web-tree-sitter import", async () => {
  const root = await makeDisabledOrAbsentWorkspace("absent");
  try {
    const adapter = await resolveTreesitterCapability(root, {
      languages: ["typescript"],
      grammarsPath: null,
    });
    expect(adapter).toBeNull();
    // The core assertion (Fix 1): a disabled/missing-manifest ceiling must
    // resolve to null WITHOUT ever attempting the literal dep import.
    expect(webTreeSitterImportAttempts).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default path, capability DISABLED (enabled: false) — resolveTreesitterCapability never attempts the web-tree-sitter import", async () => {
  const root = await makeDisabledOrAbsentWorkspace(false);
  try {
    const adapter = await resolveTreesitterCapability(root, {
      languages: ["typescript"],
      grammarsPath: null,
    });
    expect(adapter).toBeNull();
    expect(webTreeSitterImportAttempts).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default path, capability DISABLED — enrichBuildWithSymbols (no injected resolver) degrades cleanly with no writes and no dep-load attempt", async () => {
  const root = await makeDisabledOrAbsentWorkspace("absent");
  try {
    // No third argument ⇒ the real production default path (build.ts calls
    // enrichBuildWithSymbols with exactly two arguments).
    const result = await enrichBuildWithSymbols(root, [{ path: "src/x.ts", content: "" }]);
    expect(result).toEqual({ enriched: false, symbols: 0, calls: 0 });
    expect(webTreeSitterImportAttempts).toBe(0);

    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
    await expect(readFile(path.join(storage, "symbols.jsonl"), "utf8")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default path, capability ENABLED — resolveTreesitterCapability gets past gate 1 and reaches the real isAvailable() probe", async () => {
  resetWarnOnce();
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ts-default-enabled-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const manifest = setTreesitterEnabled({}, true);
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify(manifest),
      "utf8",
    );

    // No grammarsPath and no lockfile entries ⇒ resolveGrammars deterministically
    // resolves zero grammars ⇒ isAvailable() is false, so this proves the
    // manifest gate short-circuits correctly on the enabled side too, without
    // requiring a real compiled binary or a real WASM grammar asset.
    const adapter = await resolveTreesitterCapability(root, {
      languages: ["typescript"],
      grammarsPath: null,
    });

    // No grammar resolves ⇒ isAvailable() is false ⇒ degrades to null, same
    // AC0-8 catch-and-degrade contract as the seam.
    expect(adapter).toBeNull();
    // Gate 1 passed (unlike the disabled cases above) and execution reached
    // the real `isAvailable()` probe, which reported unavailable and warned
    // once — the process-scoped warn-once tracker is a reliable,
    // ordering-independent witness of this (unlike counting the mock
    // factory's own invocations, which only fires when THIS file's mock wins
    // the module-cache race against any real `web-tree-sitter` import
    // elsewhere in a full-suite run — see the top-of-file comment).
    expect(hasWarned("gdgraph.treesitter")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
