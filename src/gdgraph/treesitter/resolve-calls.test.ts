import { expect, test } from "bun:test";
import { resolveCrossFileCalls } from "./extract";
import type { CallEdge, SymbolNode } from "../types";

function sym(id: string, name: string, path: string): SymbolNode {
  return { id, kind: "function", path, name, container: null, startLine: 1, endLine: 2, language: "typescript" };
}
function unresolved(from: string, to: string): CallEdge {
  return { id: `u:${from}=>${to}`, from, to, kind: "unresolved-call", resolved: false };
}

test("resolves a cross-file member call to a globally-unique symbol", () => {
  const symbols = [sym("src/a.ts#runPipeline", "runPipeline", "src/a.ts"), sym("src/b.ts#caller", "caller", "src/b.ts")];
  // caller (in b.ts) calls `TasksApi.runPipeline` — cross-file, unresolved by per-file extraction
  const calls = [unresolved("src/b.ts#caller", "TasksApi.runPipeline")];
  const out = resolveCrossFileCalls(symbols, calls);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ from: "src/b.ts#caller", to: "src/a.ts#runPipeline", kind: "calls", resolved: true });
});

test("leaves an ambiguous name (multiple defs) unresolved — never guesses", () => {
  const symbols = [
    sym("src/a.ts#clonePipeline", "clonePipeline", "src/a.ts"),
    sym("src/b.ts#clonePipeline", "clonePipeline", "src/b.ts"),
    sym("src/c.ts#caller", "caller", "src/c.ts"),
  ];
  const out = resolveCrossFileCalls(symbols, [unresolved("src/c.ts#caller", "x.clonePipeline")]);
  expect(out[0]?.kind).toBe("unresolved-call");
});

test("drops self-edges and passes resolved calls through unchanged", () => {
  const symbols = [sym("src/a.ts#f", "f", "src/a.ts")];
  const resolved: CallEdge = { id: "c", from: "src/a.ts#g", to: "src/a.ts#f", kind: "calls", resolved: true };
  const out = resolveCrossFileCalls(symbols, [unresolved("src/a.ts#f", "f"), resolved]);
  // the self-call f->f is not added as a resolved edge; the pre-resolved call stays
  expect(out.some((c) => c.kind === "calls" && c.from === "src/a.ts#f" && c.to === "src/a.ts#f")).toBe(false);
  expect(out).toContainEqual(resolved);
});
