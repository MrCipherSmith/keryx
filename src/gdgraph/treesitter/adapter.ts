// Tree-sitter capability adapter (specification.md §7, §8.1; T-B12).
//
// Implements the Block 0 `CapabilityAdapter<BuildInput, SymbolLayer>`:
//   isAvailable() = `web-tree-sitter` imports AND ≥1 configured grammar resolves
//                   + verifies via the Asset Resolver.
//   run()         = parse each source file and emit a sorted, stable SymbolLayer.
//
// This is the ONLY module in `src/` that loads `web-tree-sitter`, and it does so
// exclusively via `await import()` (C0-2, AC1.5 — enforced by the static guard).
// It NEVER throws out (C0-11): every parse error is caught and the file is
// skipped, so an opt-in ceiling can never break the deterministic seam.

import type { CapabilityAdapter, CapabilitySpec } from "../../capability/seam";
import type { CallEdge, SymbolLayer, SymbolNode } from "../types";
import { extractSymbolLayer, resolveCrossFileCalls, type TsNode } from "./extract";
import {
  grammarForFile,
  resolveGrammars,
  symbolLanguage,
  toGrammarLanguages,
  type GrammarLanguage,
  type ResolvedGrammar,
} from "./grammars";

export interface FileRecord {
  path: string;
  content: string;
}

export interface BuildInput {
  files: FileRecord[];
}

export interface TreesitterAdapterConfig {
  languages: string[];
  grammarsPath: string | null;
}

// Minimal shapes of the `web-tree-sitter` surface we touch (kept local so the
// dep is never imported for types either — structural typing only).
interface ParserLike {
  setLanguage(language: unknown): void;
  parse(input: string): { rootNode: TsNode } | null;
}
// Version-tolerant view over the two shipped APIs:
//   0.22 — default export is the Parser class; `Parser.Language.load`, `Parser.init`.
//   0.25 — named `Parser` + top-level `Language.load`; no default export.
interface ParserApi {
  init?: () => Promise<void>;
  loadLanguage: (pathOrBytes: string) => Promise<unknown>;
  create: () => ParserLike;
}

// Build the capability spec for `resolveCapability(cwd, spec)`. Dep-only gate at
// the seam; grammar resolution happens inside `isAvailable()` because the layer
// spans multiple grammar assets (one per language).
export function createTreesitterSpec(
  cwd: string,
  config: TreesitterAdapterConfig,
): CapabilitySpec<BuildInput, SymbolLayer> {
  return {
    id: "gdgraph.treesitter",
    optionalDependency: "web-tree-sitter",
    load: (ctx) => new TreesitterAdapter(cwd, config, ctx.dep),
  };
}

class TreesitterAdapter implements CapabilityAdapter<BuildInput, SymbolLayer> {
  readonly id = "gdgraph.treesitter";
  private grammars: ResolvedGrammar[] = [];

  constructor(
    private readonly cwd: string,
    private readonly config: TreesitterAdapterConfig,
    private readonly dep: unknown,
  ) {}

  async isAvailable(): Promise<boolean> {
    if (!this.dep) {
      return false;
    }
    const languages = toGrammarLanguages(this.config.languages);
    this.grammars = await resolveGrammars(this.cwd, languages, this.config.grammarsPath);
    return this.grammars.length > 0;
  }

  async run(input: BuildInput): Promise<SymbolLayer> {
    const available: GrammarLanguage[] = this.grammars.map((grammar) => grammar.language);
    const api = normalizeParserApi(this.dep);
    if (!api) {
      return { symbols: [], calls: [] };
    }
    if (typeof api.init === "function") {
      await api.init();
    }

    // Load + cache one parser per resolved grammar language.
    const parsers = new Map<GrammarLanguage, ParserLike>();
    for (const grammar of this.grammars) {
      try {
        const language = await api.loadLanguage(grammar.path);
        if (!language) {
          continue;
        }
        const parser = api.create();
        parser.setLanguage(language);
        parsers.set(grammar.language, parser);
      } catch {
        // Grammar load failure ⇒ skip this language (never throw out).
      }
    }

    const symbols: SymbolNode[] = [];
    const calls: CallEdge[] = [];
    for (const file of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const language = grammarForFile(file.path, available);
      if (!language) {
        continue;
      }
      const parser = parsers.get(language);
      if (!parser) {
        continue;
      }
      try {
        const tree = parser.parse(file.content);
        if (!tree?.rootNode) {
          continue;
        }
        const layer = extractSymbolLayer(tree.rootNode, file.path, symbolLanguage(language));
        symbols.push(...layer.symbols);
        calls.push(...layer.calls);
      } catch {
        // Parse failure on one file ⇒ skip it deterministically.
      }
    }

    return {
      symbols: symbols.sort(compareSymbols),
      // Global pass: resolve cross-file calls (per-file extraction can't) before
      // sorting, so callers/impact don't under-report across module boundaries.
      calls: resolveCrossFileCalls(symbols, calls).sort(compareCalls),
    };
  }
}

// Resolve a version-tolerant parser API from whatever `web-tree-sitter` shape the
// runtime provides (0.22 default-export class vs 0.25 named exports).
function normalizeParserApi(dep: unknown): ParserApi | null {
  if (!dep) {
    return null;
  }
  const ns = dep as { default?: unknown; Parser?: unknown; Language?: unknown; init?: unknown };
  const ParserClass =
    typeof ns.default === "function"
      ? (ns.default as new () => ParserLike)
      : typeof ns.Parser === "function"
        ? (ns.Parser as new () => ParserLike)
        : typeof dep === "function"
          ? (dep as new () => ParserLike)
          : null;
  if (!ParserClass) {
    return null;
  }

  const classInit = (ParserClass as unknown as { init?: unknown }).init;
  const init =
    typeof classInit === "function"
      ? (classInit as () => Promise<void>).bind(ParserClass)
      : typeof ns.init === "function"
        ? (ns.init as () => Promise<void>).bind(ns)
        : undefined;

  // Resolve the grammar loader LAZILY: in 0.22 `Parser.Language.load` only
  // becomes available AFTER `Parser.init()` runs, so binding it eagerly here
  // (before init) would miss it and wrongly disable the whole capability.
  const loadLanguage = (p: string): Promise<unknown> => {
    const classLoad = (ParserClass as unknown as { Language?: { load?: unknown } }).Language;
    if (typeof classLoad?.load === "function") {
      return (classLoad.load as (x: string) => Promise<unknown>).call(classLoad, p); // 0.22
    }
    const nsLoad = ns.Language as { load?: unknown } | undefined;
    if (typeof nsLoad?.load === "function") {
      return (nsLoad.load as (x: string) => Promise<unknown>).call(nsLoad, p); // 0.25
    }
    return Promise.reject(new Error("web-tree-sitter: no Language.load"));
  };

  return {
    ...(init ? { init } : {}),
    loadLanguage,
    create: () => new ParserClass(),
  };
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
