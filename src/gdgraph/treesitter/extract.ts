// Tree-sitter symbol/call extraction (specification.md §8.1, §9; T-B12).
//
// PURE structural walk over a parsed tree, producing a sorted, stable
// `SymbolLayer`. This module NEVER imports `web-tree-sitter` (C0-2/C0-14) — the
// adapter parses and passes the root node through the minimal `TsNode` shape
// below, so extraction is dependency-free and unit-testable with a plain mock
// tree. Determinism: symbols sorted by (path, startLine, name); calls sorted by
// (from, to, kind); ids are content-independent positional
// (`<path>#<Container>.<name>`, `@<startLine>` only on name collision).

import type { CallEdge, SymbolKind, SymbolLayer, SymbolNode } from "../types";

// The minimal syntax-node contract the walk needs. `web-tree-sitter`'s SyntaxNode
// is structurally compatible; a test can supply a hand-built mock.
export interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childForFieldName(field: string): TsNode | null;
  readonly namedChildren: TsNode[];
  readonly children: TsNode[];
}

type Language = "typescript" | "javascript";

const FUNCTION_TYPES = new Set(["function_declaration", "function_signature", "generator_function_declaration"]);
const METHOD_TYPES = new Set(["method_definition", "method_signature"]);
const CLASS_TYPES = new Set(["class_declaration", "class"]);
const INTERFACE_TYPES = new Set(["interface_declaration"]);
const CALL_TYPES = new Set(["call_expression", "new_expression"]);
const ARROW_HOLDER_TYPES = new Set(["lexical_declaration", "variable_declaration"]);

interface RawSymbol {
  base: string;
  node: SymbolNode;
}

// Extract the symbol layer from a parsed tree root. `filePath` is the owning
// file path (matches a file GraphNode.path).
export function extractSymbolLayer(root: TsNode, filePath: string, language: Language): SymbolLayer {
  const raw: RawSymbol[] = [];
  const calls: CallEdge[] = [];

  // Walk the tree, tracking the enclosing class/interface container + the
  // nearest enclosing symbol id (for call attribution).
  const visit = (node: TsNode, container: string | null, enclosingSymbolId: string | null): void => {
    let nextContainer = container;
    let nextEnclosing = enclosingSymbolId;

    const symbol = symbolFromNode(node, filePath, container, language);
    if (symbol) {
      raw.push(symbol);
      nextEnclosing = symbol.node.id;
      if (symbol.node.kind === "class" || symbol.node.kind === "interface") {
        nextContainer = symbol.node.name;
      }
    } else if (ARROW_HOLDER_TYPES.has(node.type)) {
      // `const foo = () => {}` / `const Bar = function () {}` — arrow/const fns.
      for (const declared of arrowFunctionSymbols(node, filePath, container, language)) {
        raw.push(declared);
        // Descend into the arrow body under this symbol's id below.
      }
    }

    if (CALL_TYPES.has(node.type)) {
      const call = callFromNode(node, filePath, enclosingSymbolId);
      if (call) {
        calls.push(call);
      }
    }

    for (const child of node.namedChildren) {
      visit(child, nextContainer, nextEnclosing);
    }
  };

  visit(root, null, null);

  // Disambiguate id collisions with a positional `@<startLine>` suffix.
  const baseCounts = new Map<string, number>();
  for (const entry of raw) {
    baseCounts.set(entry.base, (baseCounts.get(entry.base) ?? 0) + 1);
  }
  const symbolNodes: SymbolNode[] = raw.map((entry) => {
    if ((baseCounts.get(entry.base) ?? 0) > 1) {
      return { ...entry.node, id: `${entry.base}@${entry.node.startLine}` };
    }
    return entry.node;
  });

  // `defines` edges: file → each symbol (containment).
  const defines: CallEdge[] = symbolNodes.map((symbol) => ({
    id: `defines:${filePath}->${symbol.id}`,
    from: filePath,
    to: symbol.id,
    kind: "defines",
    resolved: true,
  }));

  // Resolve CALL targets to same-file symbols by name; else unresolved-call.
  const nameToId = new Map<string, string>();
  for (const symbol of symbolNodes) {
    if (!nameToId.has(symbol.name)) {
      nameToId.set(symbol.name, symbol.id);
    }
  }
  const resolvedCalls: CallEdge[] = calls.map((call, index) => {
    const calleeName = lastSegment(call.to);
    const target = nameToId.get(calleeName);
    if (target) {
      return {
        id: `call:${call.from}->${target}:${index}`,
        from: call.from,
        to: target,
        kind: "calls",
        resolved: true,
      };
    }
    return {
      id: `unresolved:${call.from}->${call.to}:${index}`,
      from: call.from,
      to: call.to,
      kind: "unresolved-call",
      resolved: false,
    };
  });

  const sortedSymbols = symbolNodes.slice().sort(compareSymbols);
  const sortedCalls = [...defines, ...resolvedCalls].sort(compareCalls);

  // Reassign call ids after sort so they are stable + positional-free of index
  // ordering surprises (ids derived from endpoints, not array position).
  const stableCalls = sortedCalls.map((call) => ({
    ...call,
    id: `${call.kind}:${call.from}=>${call.to}`,
  }));
  // De-duplicate identical edges (same from/to/kind) produced by repeats.
  const seen = new Set<string>();
  const dedupedCalls: CallEdge[] = [];
  for (const call of stableCalls) {
    const key = `${call.kind}|${call.from}|${call.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedupedCalls.push(call);
  }

  return { symbols: sortedSymbols, calls: dedupedCalls };
}

function symbolFromNode(
  node: TsNode,
  filePath: string,
  container: string | null,
  language: Language,
): RawSymbol | null {
  const kind = symbolKind(node.type);
  if (!kind) {
    return null;
  }
  const name = nameOf(node);
  if (!name) {
    return null;
  }
  return makeSymbol(node, filePath, container, language, kind, name);
}

function arrowFunctionSymbols(
  node: TsNode,
  filePath: string,
  container: string | null,
  language: Language,
): RawSymbol[] {
  const out: RawSymbol[] = [];
  for (const declarator of node.namedChildren) {
    if (declarator.type !== "variable_declarator") {
      continue;
    }
    const value = declarator.childForFieldName("value");
    if (!value) {
      continue;
    }
    if (value.type === "arrow_function" || value.type === "function" || value.type === "function_expression") {
      const nameNode = declarator.childForFieldName("name");
      const name = nameNode?.text;
      if (name) {
        out.push(makeSymbol(declarator, filePath, container, language, "function", name));
      }
    }
  }
  return out;
}

function makeSymbol(
  node: TsNode,
  filePath: string,
  container: string | null,
  language: Language,
  kind: SymbolKind,
  name: string,
): RawSymbol {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const base = container ? `${filePath}#${container}.${name}` : `${filePath}#${name}`;
  const symbol: SymbolNode = {
    id: base,
    kind,
    path: filePath,
    name,
    container,
    startLine,
    endLine,
    language,
    signature: renderSignature(node, kind, container, name),
  };
  return { base, node: symbol };
}

function callFromNode(node: TsNode, filePath: string, enclosingSymbolId: string | null): CallEdge | null {
  const fn = node.childForFieldName("function") ?? node.childForFieldName("constructor");
  const calleeText = fn ? firstLine(fn.text) : firstLine(node.text);
  if (!calleeText) {
    return null;
  }
  return {
    id: "pending",
    from: enclosingSymbolId ?? filePath,
    to: calleeText,
    kind: "calls",
    resolved: false,
  };
}

function symbolKind(type: string): SymbolKind | null {
  if (FUNCTION_TYPES.has(type)) {
    return "function";
  }
  if (METHOD_TYPES.has(type)) {
    return "method";
  }
  if (CLASS_TYPES.has(type)) {
    return "class";
  }
  if (INTERFACE_TYPES.has(type)) {
    return "interface";
  }
  return null;
}

function nameOf(node: TsNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode && nameNode.text) {
    return firstLine(nameNode.text);
  }
  return null;
}

function renderSignature(node: TsNode, kind: SymbolKind, container: string | null, name: string): string {
  const params = node.childForFieldName("parameters");
  const paramText = params ? firstLine(params.text) : "()";
  const prefix = container ? `${container}.` : "";
  if (kind === "class") {
    return `class ${name}`;
  }
  if (kind === "interface") {
    return `interface ${name}`;
  }
  if (kind === "method") {
    return `${prefix}${name}${paramText}`;
  }
  return `${name}${paramText}`;
}

function lastSegment(callee: string): string {
  const withoutCall = callee.replace(/\(.*$/s, "");
  const parts = withoutCall.split(".");
  return (parts[parts.length - 1] ?? withoutCall).trim();
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function compareSymbols(a: SymbolNode, b: SymbolNode): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  if (a.startLine !== b.startLine) {
    return a.startLine - b.startLine;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function compareCalls(a: CallEdge, b: CallEdge): number {
  if (a.from !== b.from) {
    return a.from < b.from ? -1 : 1;
  }
  if (a.to !== b.to) {
    return a.to < b.to ? -1 : 1;
  }
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}
