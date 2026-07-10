import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { extractSymbolLayer, type TsNode } from "./extract";
import type { CallEdge, SymbolNode } from "../types";

const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/symbol-graph/", import.meta.url));

// --- Minimal mock syntax-tree builder (a structural stand-in for a parsed
// `web-tree-sitter` tree; the extractor is dependency-free). ---
interface MockOptions {
  type: string;
  line?: number;
  endLine?: number;
  text?: string;
  fields?: Record<string, TsNode | null>;
  namedChildren?: TsNode[];
}

function mk(o: MockOptions): TsNode {
  const line = o.line ?? 1;
  const endLine = o.endLine ?? line;
  const named = o.namedChildren ?? [];
  return {
    type: o.type,
    text: o.text ?? "",
    startPosition: { row: line - 1, column: 0 },
    endPosition: { row: endLine - 1, column: 0 },
    childForFieldName: (field: string) => o.fields?.[field] ?? null,
    namedChildren: named,
    children: named,
  };
}

const idNode = (text: string): TsNode => mk({ type: "identifier", text });
const paramsNode = (): TsNode => mk({ type: "formal_parameters", text: "()" });
const callTo = (name: string, line: number): TsNode =>
  mk({ type: "call_expression", line, fields: { function: idNode(name) }, text: `${name}()` });

// Build the tree modeling `fixtures/symbol-graph/source.ts`.
export function buildWidgetTree(): TsNode {
  const alphaBody = mk({ type: "statement_block", line: 1, namedChildren: [callTo("helper", 1)] });
  const funcAlpha = mk({
    type: "function_declaration",
    line: 1,
    endLine: 1,
    fields: { name: idNode("alpha"), parameters: paramsNode() },
    namedChildren: [alphaBody],
  });
  const funcHelper = mk({
    type: "function_declaration",
    line: 2,
    endLine: 2,
    fields: { name: idNode("helper"), parameters: paramsNode() },
  });
  const renderBody = mk({ type: "statement_block", line: 4, namedChildren: [callTo("alpha", 4)] });
  const methodRender = mk({
    type: "method_definition",
    line: 4,
    endLine: 4,
    fields: { name: idNode("render"), parameters: paramsNode() },
    namedChildren: [renderBody],
  });
  const classBody = mk({ type: "class_body", line: 3, endLine: 5, namedChildren: [methodRender] });
  const classWidget = mk({
    type: "class_declaration",
    line: 3,
    endLine: 5,
    fields: { name: idNode("Widget") },
    namedChildren: [classBody],
  });
  const interfaceShape = mk({
    type: "interface_declaration",
    line: 6,
    endLine: 6,
    fields: { name: idNode("Shape") },
  });
  return mk({
    type: "program",
    line: 1,
    endLine: 6,
    namedChildren: [funcAlpha, funcHelper, classWidget, interfaceShape],
  });
}

async function loadJsonl<T>(file: string): Promise<T[]> {
  const content = await readFile(file, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function prf(produced: Set<string>, expected: Set<string>): { precision: number; recall: number } {
  let truePos = 0;
  for (const item of produced) {
    if (expected.has(item)) {
      truePos += 1;
    }
  }
  return {
    precision: produced.size === 0 ? 0 : truePos / produced.size,
    recall: expected.size === 0 ? 0 : truePos / expected.size,
  };
}

test("AC1.2/AC1.3 — extracted symbols/calls hit precision ≥ 0.90 and recall ≥ 0.85", async () => {
  const layer = extractSymbolLayer(buildWidgetTree(), "src/widget.ts", "typescript");
  const expectedSymbols = await loadJsonl<SymbolNode>(path.join(FIXTURE_DIR, "expected", "symbols.jsonl"));
  const expectedCalls = await loadJsonl<CallEdge>(path.join(FIXTURE_DIR, "expected", "calls.jsonl"));

  const symbolKey = (s: SymbolNode) => `${s.id}|${s.kind}|${s.startLine}`;
  const callKey = (c: CallEdge) => `${c.kind}|${c.from}|${c.to}`;

  const symbolPrf = prf(new Set(layer.symbols.map(symbolKey)), new Set(expectedSymbols.map(symbolKey)));
  const callPrf = prf(new Set(layer.calls.map(callKey)), new Set(expectedCalls.map(callKey)));

  expect(symbolPrf.precision).toBeGreaterThanOrEqual(0.9);
  expect(symbolPrf.recall).toBeGreaterThanOrEqual(0.85);
  expect(callPrf.precision).toBeGreaterThanOrEqual(0.9);
  expect(callPrf.recall).toBeGreaterThanOrEqual(0.85);
});

test("AC1.1 — emits function/class/method/interface nodes + calls/defines/unresolved edges", () => {
  const layer = extractSymbolLayer(buildWidgetTree(), "src/widget.ts", "typescript");
  const kinds = new Set(layer.symbols.map((symbol) => symbol.kind));
  expect(kinds).toEqual(new Set(["function", "class", "method", "interface"]));
  const callKinds = new Set(layer.calls.map((call) => call.kind));
  expect(callKinds.has("defines")).toBe(true);
  expect(callKinds.has("calls")).toBe(true);
});

test("AC1.4 — symbol ids are stable + content-independent; re-run is byte-identical", () => {
  const a = extractSymbolLayer(buildWidgetTree(), "src/widget.ts", "typescript");
  const b = extractSymbolLayer(buildWidgetTree(), "src/widget.ts", "typescript");
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(a.symbols.map((symbol) => symbol.id)).toEqual([
    "src/widget.ts#alpha",
    "src/widget.ts#helper",
    "src/widget.ts#Widget",
    "src/widget.ts#Widget.render",
    "src/widget.ts#Shape",
  ]);
});

test("AC1.4 — colliding names get a positional @startLine disambiguator only", () => {
  const idNodeLocal = (text: string): TsNode => mk({ type: "identifier", text });
  const dup1 = mk({
    type: "function_declaration",
    line: 1,
    endLine: 1,
    fields: { name: idNodeLocal("dup"), parameters: paramsNode() },
  });
  const dup2 = mk({
    type: "function_declaration",
    line: 5,
    endLine: 5,
    fields: { name: idNodeLocal("dup"), parameters: paramsNode() },
  });
  const unique = mk({
    type: "function_declaration",
    line: 9,
    endLine: 9,
    fields: { name: idNodeLocal("only"), parameters: paramsNode() },
  });
  const root = mk({ type: "program", line: 1, endLine: 9, namedChildren: [dup1, dup2, unique] });
  const layer = extractSymbolLayer(root, "src/dup.ts", "typescript");
  const ids = layer.symbols.map((symbol) => symbol.id);
  expect(ids).toEqual(["src/dup.ts#dup@1", "src/dup.ts#dup@5", "src/dup.ts#only"]);
});

test("unresolved calls to unknown callees are kept as unresolved-call edges", () => {
  const idNodeLocal = (text: string): TsNode => mk({ type: "identifier", text });
  const body = mk({
    type: "statement_block",
    line: 1,
    namedChildren: [
      mk({ type: "call_expression", line: 1, fields: { function: idNodeLocal("externalThing") }, text: "externalThing()" }),
    ],
  });
  const fn = mk({
    type: "function_declaration",
    line: 1,
    endLine: 2,
    fields: { name: idNodeLocal("main"), parameters: paramsNode() },
    namedChildren: [body],
  });
  const root = mk({ type: "program", line: 1, endLine: 2, namedChildren: [fn] });
  const layer = extractSymbolLayer(root, "src/main.ts", "typescript");
  const unresolved = layer.calls.filter((call) => call.kind === "unresolved-call");
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0]?.to).toBe("externalThing");
  expect(unresolved[0]?.resolved).toBe(false);
});

test("Java class and method extraction", () => {
  const idNode = (text: string): TsNode => mk({ type: "identifier", text });
  const methodBody = mk({ type: "block", line: 4, namedChildren: [
    mk({ type: "method_invocation", line: 4, fields: { method: idNode("helper") }, text: "helper()" }),
  ]});
  const methodHelper = mk({
    type: "method_declaration",
    line: 3,
    endLine: 3,
    fields: { name: idNode("helper"), parameters: mk({ type: "formal_parameters", text: "()" }) },
  });
  const methodMain = mk({
    type: "method_declaration",
    line: 4,
    endLine: 5,
    fields: { name: idNode("main"), parameters: mk({ type: "formal_parameters", text: "()" }) },
    namedChildren: [methodBody],
  });
  const classBody = mk({ type: "class_body", line: 2, endLine: 6, namedChildren: [methodHelper, methodMain] });
  const classApp = mk({
    type: "class_declaration",
    line: 1,
    endLine: 6,
    fields: { name: idNode("App") },
    namedChildren: [classBody],
  });
  const root = mk({ type: "program", line: 1, endLine: 6, namedChildren: [classApp] });
  const layer = extractSymbolLayer(root, "src/App.java", "java");

  expect(layer.symbols).toHaveLength(3); // App class + 2 methods
  const classSymbol = layer.symbols.find((s) => s.name === "App");
  expect(classSymbol).toBeDefined();
  expect(classSymbol?.kind).toBe("class");

  const methods = layer.symbols.filter((s) => s.kind === "method");
  expect(methods).toHaveLength(2);
});

test("Python function and class extraction", () => {
  const idNode = (text: string): TsNode => mk({ type: "identifier", text });
  const funcBody = mk({ type: "block", line: 4, namedChildren: [
    mk({ type: "call", line: 4, fields: { function: idNode("helper") }, text: "helper()" }),
  ]});
  const funcHelper = mk({
    type: "function_definition",
    line: 2,
    endLine: 2,
    fields: { name: idNode("helper"), parameters: mk({ type: "parameters", text: "()" }) },
  });
  const funcMain = mk({
    type: "function_definition",
    line: 4,
    endLine: 5,
    fields: { name: idNode("main"), parameters: mk({ type: "parameters", text: "()" }) },
    namedChildren: [funcBody],
  });
  const methodProcess = mk({
    type: "function_definition",
    line: 8,
    endLine: 8,
    fields: { name: idNode("process"), parameters: mk({ type: "parameters", text: "(self)" }) },
  });
  const classBody = mk({ type: "block", line: 7, endLine: 9, namedChildren: [methodProcess] });
  const classApp = mk({
    type: "class_definition",
    line: 6,
    endLine: 9,
    fields: { name: idNode("App") },
    namedChildren: [classBody],
  });
  const root = mk({ type: "program", line: 1, endLine: 9, namedChildren: [funcHelper, funcMain, classApp] });
  const layer = extractSymbolLayer(root, "src/main.py", "python");

  expect(layer.symbols).toHaveLength(4); // 2 functions + 1 class + 1 nested function (process)
  const classSymbol = layer.symbols.find((s) => s.name === "App");
  expect(classSymbol).toBeDefined();
  expect(classSymbol?.kind).toBe("class");

  const functions = layer.symbols.filter((s) => s.kind === "function");
  expect(functions.length).toBeGreaterThan(0); // Should have at least the top-level functions
});
