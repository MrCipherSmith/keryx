// Enable/disable the `gdgraph.treesitter` capability in a parsed
// `metaproject.json` — the opt-in switch for the symbol layer. Pure manifest
// transforms (the command layer owns file IO), merge-safe: preserves any other
// gdgraph capabilities and never rewrites unrelated modules.
//
// Also hosts `requireSymbols()` (AFC-13 / AC5, requirements 2 & 3): the typed,
// actionable error a caller gets when it explicitly demands symbol-level
// capability and the graph has no symbol layer — instead of `undefined`, an
// empty result, or a generic `Error` with a string. When given the tree-sitter
// adapter's per-language `GrammarDiagnosis[]` (see `./treesitter/adapter`),
// the error additionally distinguishes "grammar not installed" from "grammar
// installed but incompatible with this runtime" — distinct causes with
// distinct remedies, rather than one indistinguishable "unavailable".

import type { GrammarDiagnosis } from "./treesitter/adapter";

export const TREESITTER_CAPABILITY = "gdgraph.treesitter";

type Json = Record<string, unknown>;

function treesitterEntry(enabled: boolean): Json {
  return {
    id: TREESITTER_CAPABILITY,
    enabled,
    kind: "ceiling",
    optionalDependency: "web-tree-sitter",
  };
}

// Return a new manifest with the gdgraph.treesitter capability set to `enabled`,
// adding the gdgraph module capabilities array if absent. Other capabilities and
// modules are preserved untouched.
export function setTreesitterEnabled(manifest: Json, enabled: boolean): Json {
  const modules =
    typeof manifest.modules === "object" && manifest.modules !== null
      ? { ...(manifest.modules as Json) }
      : {};
  const gdgraph =
    typeof modules.gdgraph === "object" && modules.gdgraph !== null
      ? { ...(modules.gdgraph as Json) }
      : {};

  const existing = Array.isArray(gdgraph.capabilities) ? (gdgraph.capabilities as unknown[]) : [];
  const others = existing.filter(
    (c) => !(c && typeof c === "object" && (c as Json).id === TREESITTER_CAPABILITY),
  );
  gdgraph.capabilities = [...others, treesitterEntry(enabled)];
  modules.gdgraph = gdgraph;
  return { ...manifest, modules };
}

// Whether the manifest has gdgraph.treesitter enabled.
export function isTreesitterEnabled(manifest: Json): boolean {
  const modules = manifest.modules as Json | undefined;
  const gdgraph = modules?.gdgraph as Json | undefined;
  const caps = Array.isArray(gdgraph?.capabilities) ? (gdgraph?.capabilities as unknown[]) : [];
  return caps.some(
    (c) => c && typeof c === "object" && (c as Json).id === TREESITTER_CAPABILITY && (c as Json).enabled === true,
  );
}

// --- requireSymbols (AFC-13 / AC5, requirements 2 & 3) ---

export type SymbolsUnavailableCode =
  // The graph has no symbol layer and no diagnoses were supplied to explain
  // why (capability disabled, or the caller didn't pass the adapter's probe).
  | "no-symbol-layer"
  // At least one required language's grammar never resolved: not installed,
  // or failed the Asset Resolver's checksum.
  | "grammar-missing"
  // At least one required language's grammar resolved and verified on disk,
  // but the installed `web-tree-sitter` runtime refused to load it (ABI /
  // version mismatch) — distinct from "missing": nothing to install, the
  // existing install doesn't match the runtime.
  | "grammar-incompatible";

// Thrown by `requireSymbols()`. A typed, actionable error — never a generic
// `Error` with a string, never swallowed into `undefined`/an empty result —
// naming what capability is missing and what would fix it.
export class SymbolsUnavailableError extends Error {
  readonly code: SymbolsUnavailableCode;
  readonly remedy: string;
  readonly diagnoses: GrammarDiagnosis[];

  constructor(code: SymbolsUnavailableCode, message: string, remedy: string, diagnoses: GrammarDiagnosis[] = []) {
    super(message);
    this.name = "SymbolsUnavailableError";
    this.code = code;
    this.remedy = remedy;
    this.diagnoses = diagnoses;
  }
}

// The minimal shape `requireSymbols` needs from a graph. Defined locally
// rather than imported from `./types` (owned by a concurrent task on this
// flow) so this module depends on nothing but the one field it actually
// reads; `GraphData` (which has `symbols?: SymbolNode[]`) satisfies this
// structurally, so callers can pass a real `GraphData` unchanged.
export interface SymbolsLayerCarrier {
  symbols?: unknown[];
}

// Explicit demand for symbol-level capability: returns `graph.symbols` when
// present, otherwise THROWS `SymbolsUnavailableError` instead of returning
// `undefined` or an empty array. This is the "requireSymbols" contract in
// AC-13 — a caller that opts into requiring symbols gets a typed, actionable
// failure, never a silent downgrade to file-level.
//
// `diagnoses` (optional) is normally `TreesitterAdapter#getDiagnoses()`
// (`./treesitter/adapter`) forwarded by the caller; when supplied, the thrown
// error's `code` distinguishes "grammar-missing" from "grammar-incompatible"
// (requirement 3) instead of a single generic "unavailable".
export function requireSymbols<G extends SymbolsLayerCarrier>(
  graph: G,
  diagnoses: GrammarDiagnosis[] = [],
): NonNullable<G["symbols"]> {
  if (graph.symbols !== undefined) {
    return graph.symbols as NonNullable<G["symbols"]>;
  }
  throw buildSymbolsUnavailableError(diagnoses);
}

function buildSymbolsUnavailableError(diagnoses: GrammarDiagnosis[]): SymbolsUnavailableError {
  const incompatible = diagnoses.filter((d) => d.status === "incompatible");
  if (incompatible.length > 0) {
    const languages = incompatible.map((d) => d.language).join(", ");
    return new SymbolsUnavailableError(
      "grammar-incompatible",
      `requireSymbols: the installed grammar for [${languages}] is incompatible with this web-tree-sitter runtime (${incompatible
        .map((d) => d.reason)
        .join("; ")})`,
      `Reinstall a "tree-sitter-<language>" grammar build that matches the installed web-tree-sitter runtime version (run "keryx gdgraph assets pull tree-sitter-<language>" after updating .metaproject/assets.lock.json), then rebuild the graph with "keryx gdgraph build".`,
      diagnoses,
    );
  }

  const missing = diagnoses.filter((d) => d.status === "missing");
  if (missing.length > 0) {
    const languages = missing.map((d) => d.language).join(", ");
    return new SymbolsUnavailableError(
      "grammar-missing",
      `requireSymbols: no grammar is installed for [${languages}]`,
      `Enable the "gdgraph.treesitter" capability in metaproject.json, install the grammar with "keryx gdgraph assets pull tree-sitter-<language>" for each of [${languages}], then rebuild the graph with "keryx gdgraph build".`,
      diagnoses,
    );
  }

  return new SymbolsUnavailableError(
    "no-symbol-layer",
    "requireSymbols: the graph has no symbol layer (gdgraph.treesitter is disabled, or the build ran without it)",
    'Enable the "gdgraph.treesitter" capability in metaproject.json and rebuild the graph with "keryx gdgraph build".',
    diagnoses,
  );
}
