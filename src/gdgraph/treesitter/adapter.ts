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
import { extractSymbolLayer, type TsNode } from "./extract";
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
interface ParserModuleLike {
  init?: () => Promise<void>;
  Language?: { load(pathOrBytes: string): Promise<unknown> };
  new (): ParserLike;
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
    const parserModule = normalizeParserModule(this.dep);
    if (!parserModule) {
      return { symbols: [], calls: [] };
    }
    if (typeof parserModule.init === "function") {
      await parserModule.init();
    }

    // Load + cache one parser per resolved grammar language.
    const parsers = new Map<GrammarLanguage, ParserLike>();
    for (const grammar of this.grammars) {
      try {
        const language = await parserModule.Language?.load(grammar.path);
        if (!language) {
          continue;
        }
        const parser = new parserModule();
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
      calls: calls.sort(compareCalls),
    };
  }
}

function normalizeParserModule(dep: unknown): ParserModuleLike | null {
  if (!dep) {
    return null;
  }
  const candidate = dep as { default?: unknown };
  const chosen = candidate.default ?? dep;
  if (typeof chosen === "function") {
    return chosen as unknown as ParserModuleLike;
  }
  return null;
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
