import { expect, test } from "bun:test";
import {
  isTreesitterEnabled,
  requireSymbols,
  setTreesitterEnabled,
  SymbolsUnavailableError,
  TREESITTER_CAPABILITY,
  type SymbolsLayerCarrier,
} from "./symbols-capability";
import type { GrammarDiagnosis } from "./treesitter/adapter";

test("enable adds the capability entry to an empty manifest", () => {
  const next = setTreesitterEnabled({}, true);
  expect(isTreesitterEnabled(next)).toBe(true);
  const caps = (next.modules as any).gdgraph.capabilities;
  expect(caps).toHaveLength(1);
  expect(caps[0]).toMatchObject({ id: TREESITTER_CAPABILITY, enabled: true, kind: "ceiling" });
});

test("disable flips enabled to false", () => {
  const enabled = setTreesitterEnabled({}, true);
  const disabled = setTreesitterEnabled(enabled, false);
  expect(isTreesitterEnabled(disabled)).toBe(false);
});

test("is idempotent — never duplicates the capability entry", () => {
  let m: Record<string, unknown> = {};
  m = setTreesitterEnabled(m, true);
  m = setTreesitterEnabled(m, true);
  const caps = (m.modules as any).gdgraph.capabilities.filter(
    (c: any) => c.id === TREESITTER_CAPABILITY,
  );
  expect(caps).toHaveLength(1);
});

test("preserves other gdgraph capabilities and other modules", () => {
  const manifest = {
    modules: {
      gdgraph: { enabled: true, capabilities: [{ id: "gdgraph.other", enabled: true }] },
      security: { enabled: true },
    },
    schemaVersion: 1,
  };
  const next = setTreesitterEnabled(manifest, true) as any;
  const ids = next.modules.gdgraph.capabilities.map((c: any) => c.id).sort();
  expect(ids).toEqual(["gdgraph.other", "gdgraph.treesitter"]);
  expect(next.modules.security).toEqual({ enabled: true });
  expect(next.schemaVersion).toBe(1);
});

// --- AFC-13 / AC5 requirement 2: requireSymbols gives a typed, actionable
// error — never undefined, never an empty result, never a generic Error. ---

test("AC5.req2 — requireSymbols returns graph.symbols when the symbol layer is present (including an empty array — the layer RAN, it just found nothing)", () => {
  const withSymbols = { symbols: [{ id: "a" }] };
  expect(requireSymbols(withSymbols)).toEqual(withSymbols.symbols);

  const ranButEmpty = { symbols: [] };
  expect(requireSymbols(ranButEmpty)).toEqual([]);
});

test("AC5.req2 — requireSymbols throws SymbolsUnavailableError (not undefined, not an empty result, not a generic Error) when the symbol layer never ran", () => {
  // A `GraphData`-shaped object with no `symbols` key — exactly what the
  // graph looks like when the symbol layer never ran. The cast (rather than a
  // bare literal) is only to satisfy TS's weak-object-literal check, which
  // otherwise flags "no properties in common" for a fresh literal compared
  // against a type with a single optional property; a real `GraphData` value
  // (a named type, not a fresh literal) never triggers this.
  const graphWithNoLayer = { nodes: [], edges: [] } as unknown as SymbolsLayerCarrier;
  expect(() => requireSymbols(graphWithNoLayer)).toThrow(SymbolsUnavailableError);

  let caught: unknown;
  try {
    requireSymbols(graphWithNoLayer);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SymbolsUnavailableError);
  expect(caught).toBeInstanceOf(Error);
  const typed = caught as SymbolsUnavailableError;
  // Typed and actionable: a stable `code`, a non-empty `remedy`, a non-empty
  // `message` — not a bare string thrown, not `err.message === ""`.
  expect(typed.code).toBe("no-symbol-layer");
  expect(typeof typed.remedy).toBe("string");
  expect(typed.remedy.length).toBeGreaterThan(0);
  expect(typed.message.length).toBeGreaterThan(0);
});

// --- AFC-13 / AC5 requirement 3: missing vs incompatible must be
// distinguishable, not collapsed into one outcome. ---

test("AC5.req3 — requireSymbols reports grammar-missing when diagnoses say the grammar never resolved", () => {
  const diagnoses: GrammarDiagnosis[] = [
    { language: "typescript", status: "missing", reason: 'grammar asset "tree-sitter-typescript" is not resolved' },
  ];
  let caught: SymbolsUnavailableError | undefined;
  try {
    requireSymbols({}, diagnoses);
  } catch (err) {
    caught = err as SymbolsUnavailableError;
  }
  expect(caught?.code).toBe("grammar-missing");
  expect(caught?.message).toContain("typescript");
});

test("AC5.req3 — requireSymbols reports grammar-incompatible when diagnoses say the grammar resolved but failed to load (ABI mismatch), and this is a DIFFERENT code/message/remedy than grammar-missing", () => {
  const incompatible: GrammarDiagnosis[] = [
    {
      language: "typescript",
      status: "incompatible",
      reason: 'grammar at "/cache/tree-sitter-typescript" failed to load (likely an ABI/version mismatch): Incompatible language version 13. Expected minimum 14',
    },
  ];
  let caught: SymbolsUnavailableError | undefined;
  try {
    requireSymbols({}, incompatible);
  } catch (err) {
    caught = err as SymbolsUnavailableError;
  }
  expect(caught?.code).toBe("grammar-incompatible");
  expect(caught?.message).toContain("incompatible");

  // Same missing-grammar case as the previous test, compared directly here so
  // the distinction is asserted in one place: two different real-world
  // conditions must never collapse into the same code/message/remedy.
  const missing: GrammarDiagnosis[] = [
    { language: "typescript", status: "missing", reason: 'grammar asset "tree-sitter-typescript" is not resolved' },
  ];
  let missingCaught: SymbolsUnavailableError | undefined;
  try {
    requireSymbols({}, missing);
  } catch (err) {
    missingCaught = err as SymbolsUnavailableError;
  }
  expect(missingCaught?.code).not.toBe(caught?.code);
  expect(missingCaught?.message).not.toBe(caught?.message);
  expect(missingCaught?.remedy).not.toBe(caught?.remedy);
});
