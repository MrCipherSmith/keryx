// gdgraph config loader + defaults (specification.md §5; T-B2, C0-8).
//
// `.metaproject/gdgraph.config.json` is an OPTIONAL file, deep-merged over the
// built-in defaults. Missing OR malformed JSON degrades to the defaults so every
// gdgraph command keeps working deterministically (mirrors `loadSecurityConfig`
// and the `ctx.ts` config idiom). Every field falls back individually.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

export type TokenEstimator = "chars-div-4";

export interface GdgraphConfig {
  affected: {
    // MUST default to 1 for back-compat (B-3): depth-1 == today's dependents.
    defaultDepth: number;
  };
  repomap: {
    tokenBudget: number;
    tokenEstimator: TokenEstimator;
    maxSymbolsPerFile: number;
    // PageRank params — FIXED ⇒ deterministic convergence (B-4, B-5).
    damping: number;
    iterations: number;
    tolerance: number;
    // CALL edge weight for personalized PageRank (import=1.0, defines=0.5).
    callWeight: number;
  };
  treesitter: {
    // T1 user-provided dir of *.wasm grammars (A-1); null ⇒ resolver cache/pull.
    grammarsPath: string | null;
    // Bounded to the languages this project extracts (NG-B3/B-8).
    languages: string[];
  };
}

export const DEFAULT_GDGRAPH_CONFIG: GdgraphConfig = {
  affected: {
    defaultDepth: 1,
  },
  repomap: {
    tokenBudget: 8000,
    tokenEstimator: "chars-div-4",
    maxSymbolsPerFile: 12,
    damping: 0.85,
    iterations: 50,
    tolerance: 1e-8,
    callWeight: 1.5,
  },
  treesitter: {
    grammarsPath: null,
    languages: ["typescript", "tsx", "javascript"],
  },
};

export function gdgraphConfigPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "gdgraph.config.json");
}

// Deep-merge a partial user config over the defaults, field-by-field. Unknown
// keys are ignored; each known block falls back individually. Never throws.
export function mergeGdgraphConfig(parsed: DeepPartial<GdgraphConfig>): GdgraphConfig {
  const base = DEFAULT_GDGRAPH_CONFIG;
  const affected = parsed.affected ?? {};
  const repomap = parsed.repomap ?? {};
  const treesitter = parsed.treesitter ?? {};
  return {
    affected: {
      defaultDepth: numberOr(affected.defaultDepth, base.affected.defaultDepth),
    },
    repomap: {
      tokenBudget: numberOr(repomap.tokenBudget, base.repomap.tokenBudget),
      tokenEstimator:
        repomap.tokenEstimator === "chars-div-4"
          ? repomap.tokenEstimator
          : base.repomap.tokenEstimator,
      maxSymbolsPerFile: numberOr(repomap.maxSymbolsPerFile, base.repomap.maxSymbolsPerFile),
      damping: numberOr(repomap.damping, base.repomap.damping),
      iterations: numberOr(repomap.iterations, base.repomap.iterations),
      tolerance: numberOr(repomap.tolerance, base.repomap.tolerance),
      callWeight: numberOr(repomap.callWeight, base.repomap.callWeight),
    },
    treesitter: {
      grammarsPath:
        typeof treesitter.grammarsPath === "string"
          ? treesitter.grammarsPath
          : base.treesitter.grammarsPath,
      languages: Array.isArray(treesitter.languages)
        ? treesitter.languages.filter((entry): entry is string => typeof entry === "string")
        : base.treesitter.languages,
    },
  };
}

// Load `.metaproject/gdgraph.config.json`, falling back to defaults when the
// file is absent OR malformed (advisory-safe, never throws).
export async function loadGdgraphConfig(cwd: string): Promise<GdgraphConfig> {
  const file = gdgraphConfigPath(cwd);
  if (!(await pathExists(file))) {
    return mergeGdgraphConfig({});
  }
  const parsed = await readJsonFileOr<DeepPartial<GdgraphConfig>>(file, {});
  return mergeGdgraphConfig(parsed);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};
