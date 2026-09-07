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

import { isCapabilityEnabled, resolveCapability, type CapabilityAdapter, type CapabilitySpec } from "../../capability/seam";
import { warnCapabilityDegraded } from "../../capability/warn-once";
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

// Per-language probe outcome (AFC-13 / AC5). "missing" and "incompatible" are
// deliberately distinct: a grammar that never resolved (not installed, or
// failed the Asset Resolver's checksum) has a different remedy — install it —
// from one that resolved and verified on disk but the installed
// `web-tree-sitter` runtime refuses to load it (an ABI/version mismatch
// between the pinned grammar build and the runtime) — whose remedy is
// reinstalling a matching build, not installing anything new. Collapsing
// these into one "unavailable" outcome is the defect class AC5 targets.
export type GrammarDiagnosisStatus = "ok" | "missing" | "incompatible";

export interface GrammarDiagnosis {
  language: GrammarLanguage;
  status: GrammarDiagnosisStatus;
  // Human-actionable detail; empty for "ok".
  reason: string;
}

// Render diagnoses into one warn-once-friendly summary line, grouped by
// status so a mixed missing+incompatible result stays legible.
export function describeGrammarDiagnoses(diagnoses: GrammarDiagnosis[]): string {
  if (diagnoses.length === 0) {
    return "no grammar languages configured";
  }
  const byStatus = (status: GrammarDiagnosisStatus) =>
    diagnoses.filter((d) => d.status === status).map((d) => d.language);
  const missing = byStatus("missing");
  const incompatible = byStatus("incompatible");
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing grammar for [${missing.join(", ")}]`);
  }
  if (incompatible.length > 0) {
    parts.push(`incompatible grammar for [${incompatible.join(", ")}]`);
  }
  if (parts.length === 0) {
    return "no configured grammar resolved to a usable parser";
  }
  return parts.join("; ");
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

// Compiled-binary fast path (T6, keryx-native-distribution).
//
// `bun build --compile` cannot statically trace `src/capability/seam.ts`'s
// generic `await import(spec.optionalDependency)` (a runtime string variable —
// oven-sh/bun#11732), so in a compiled binary gate 2 of `resolveCapability`
// always throws for THIS capability even when `web-tree-sitter` is genuinely
// bundled in. A LITERAL `await import("web-tree-sitter")` DOES bundle and work
// in a compiled binary (verified empirically this flow).
//
// This function tries the literal import first. When it succeeds, it drives
// the SAME gates the seam applies (1: manifest-enabled, 4: adapter build +
// isAvailable, with the identical warn-once-on-degrade contract) — it only
// replaces the ONE line that loads the dependency itself. When the literal
// import throws (dependency genuinely not installed, e.g. a minimal npm
// install without optional deps, or `bun run` dev mode where the package is
// simply missing from node_modules), it falls through UNCHANGED to
// `resolveCapability(cwd, spec)` — today's exact dev-mode behavior, including
// the seam's own variable-based `await import(spec.optionalDependency)`
// attempt and its warn-once messaging. `seam.ts` itself is never modified.
async function loadTreesitterDepLiteral(): Promise<unknown | undefined> {
  try {
    return await import("web-tree-sitter");
  } catch {
    return undefined;
  }
}

export async function resolveTreesitterCapability(
  cwd: string,
  config: TreesitterAdapterConfig,
  resolve: (
    cwd: string,
    spec: CapabilitySpec<BuildInput, SymbolLayer>,
  ) => Promise<CapabilityAdapter<BuildInput, SymbolLayer> | null> = resolveCapability,
): Promise<CapabilityAdapter<BuildInput, SymbolLayer> | null> {
  const spec = createTreesitterSpec(cwd, config);

  try {
    // Gate 1 FIRST — identical check the seam performs, no dep load, no
    // warning when disabled (the normal default path per `seam.ts`'s own
    // contract: "Disabled ⇒ null with NO dep load, NO asset touch, and NO
    // warning"). This MUST run before the literal `import("web-tree-sitter")`
    // below: with the check after, every `gdgraph build` call paid the
    // literal-import cost even with the capability disabled — the bug this
    // ordering fixes.
    if (!(await isCapabilityEnabled(cwd, spec.id))) {
      return null;
    }

    const literalDep = await loadTreesitterDepLiteral();
    if (literalDep === undefined) {
      // Literal import failed (dependency not actually installed) — defer to
      // the seam's normal variable-based gate 2, unchanged. The seam
      // re-checks gate 1, which is cheap and idempotent.
      return await resolve(cwd, spec);
    }

    // Gate 2 replaced: the dependency is already loaded via the literal
    // import above, so it is supplied directly instead of re-resolving
    // `spec.optionalDependency` through the seam.
    const adapter = spec.load({ dep: literalDep, asset: null });

    // Gate 4: `isAvailable()` — same catch-and-degrade contract as the seam
    // (AC0-8): a probe that throws degrades to the deterministic fallback.
    let available: boolean;
    try {
      available = await adapter.isAvailable();
    } catch {
      warnCapabilityDegraded(spec.id, "adapter availability check threw");
      return null;
    }
    if (!available) {
      // Prefer the per-language diagnoses when the concrete adapter exposes
      // them (only `TreesitterAdapter` does — this cast is local and narrow,
      // never leaks into the shared `CapabilityAdapter` interface), so the
      // one-line warn-once already names missing vs incompatible instead of
      // a generic "unavailable".
      const diagnoses = getGrammarDiagnoses(adapter as unknown as { getDiagnoses?: () => GrammarDiagnosis[] });
      const reason =
        diagnoses.length > 0 ? describeGrammarDiagnoses(diagnoses) : "adapter reported unavailable";
      warnCapabilityDegraded(spec.id, reason);
      return null;
    }

    return adapter;
  } catch {
    // Absolute backstop, mirrors the seam's own contract: never throw out.
    return null;
  }
}

// Read `getDiagnoses()` off a `CapabilityAdapter` when the concrete instance
// is a `TreesitterAdapter` (the only implementation today). A generic
// `CapabilityAdapter` from another module simply has no such method, so this
// is a safe narrow probe rather than an assumption about the seam's shared
// interface.
function getGrammarDiagnoses(adapter: { getDiagnoses?: () => GrammarDiagnosis[] }): GrammarDiagnosis[] {
  return typeof adapter.getDiagnoses === "function" ? adapter.getDiagnoses() : [];
}

class TreesitterAdapter implements CapabilityAdapter<BuildInput, SymbolLayer> {
  readonly id = "gdgraph.treesitter";
  private grammars: ResolvedGrammar[] = [];
  private diagnoses: GrammarDiagnosis[] = [];
  // Populated by `isAvailable()`'s probe so `run()` never re-attempts a
  // `loadLanguage()` call the probe already made (and, for a language that
  // probed "incompatible", never attempts it at all).
  private loadedLanguages = new Map<GrammarLanguage, unknown>();

  constructor(
    private readonly cwd: string,
    private readonly config: TreesitterAdapterConfig,
    private readonly dep: unknown,
  ) {}

  // Exposes the per-language missing-vs-incompatible breakdown from the most
  // recent `isAvailable()` probe (AFC-13 / AC5, requirement 3). Empty before
  // `isAvailable()` has run.
  getDiagnoses(): GrammarDiagnosis[] {
    return this.diagnoses;
  }

  async isAvailable(): Promise<boolean> {
    const languages = toGrammarLanguages(this.config.languages);
    this.diagnoses = [];
    this.loadedLanguages = new Map();
    this.grammars = [];

    if (!this.dep) {
      this.diagnoses = languages.map((language) => ({
        language,
        status: "missing",
        reason: 'optional dependency "web-tree-sitter" is not installed',
      }));
      return false;
    }

    const resolved = await resolveGrammars(this.cwd, languages, this.config.grammarsPath);
    const resolvedByLanguage = new Map(resolved.map((grammar) => [grammar.language, grammar]));

    const api = normalizeParserApi(this.dep);
    if (typeof api?.init === "function") {
      try {
        await api.init();
      } catch {
        // Runtime init failure ⇒ every resolved grammar is unloadable; each
        // still gets its own diagnosis below (loadLanguage will also throw).
      }
    }

    for (const language of languages) {
      const grammar = resolvedByLanguage.get(language);
      if (!grammar) {
        this.diagnoses.push({
          language,
          status: "missing",
          reason: `grammar asset "tree-sitter-${language}" is not resolved (not installed, or failed checksum verification)`,
        });
        continue;
      }
      if (!api) {
        this.diagnoses.push({
          language,
          status: "incompatible",
          reason: 'the "web-tree-sitter" module shape was not recognized (no usable Parser export)',
        });
        continue;
      }
      try {
        const loaded = await api.loadLanguage(grammar.path);
        if (!loaded) {
          this.diagnoses.push({
            language,
            status: "incompatible",
            reason: `grammar at "${grammar.path}" loaded but produced no Language object`,
          });
          continue;
        }
        this.loadedLanguages.set(language, loaded);
        this.grammars.push(grammar);
        this.diagnoses.push({ language, status: "ok", reason: "" });
      } catch (error) {
        // The grammar resolved and verified on disk, but the installed
        // `web-tree-sitter` runtime refused to load it — an ABI/version
        // mismatch between the pinned grammar build and the runtime, NOT a
        // missing asset. Distinct cause, distinct remedy (AFC-13).
        this.diagnoses.push({
          language,
          status: "incompatible",
          reason: `grammar at "${grammar.path}" failed to load in the installed web-tree-sitter runtime (likely an ABI/version mismatch): ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    return this.diagnoses.some((d) => d.status === "ok");
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

    // Load + cache one parser per resolved grammar language. Reuse the
    // Language object the `isAvailable()` probe already loaded when present
    // (the common path); fall back to loading directly for a caller that
    // invokes `run()` without having called `isAvailable()` first.
    const parsers = new Map<GrammarLanguage, ParserLike>();
    for (const grammar of this.grammars) {
      try {
        const language = this.loadedLanguages.get(grammar.language) ?? (await api.loadLanguage(grammar.path));
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
