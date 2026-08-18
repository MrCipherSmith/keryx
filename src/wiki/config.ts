// wiki RLM config loader + defaults (TRD §3.1, flow 169 T2).
//
// `.metaproject/wiki.config.json` is an OPTIONAL file, deep-merged over the
// built-in defaults. Missing OR malformed JSON degrades to the defaults so
// every wiki command keeps working deterministically (mirrors
// `gdgraph/config.ts`'s `loadGdgraphConfig` idiom exactly). Every field falls
// back individually. `rlm.enabled` defaults to `false` so absence of this file
// reproduces today's `wikiEnrich` behavior byte-for-byte (NFR-4).
//
// Numeric classify/deep thresholds are deliberately conservative starting
// values (PRD §11 defers the "real" numbers to a later baseline measurement):
// bias toward `light` over `deep` (high PageRank/fan-in bars for `deep`) and
// toward NOT skipping (a small `skipMaxBytes`), since this is new/unvalidated.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

export interface WikiConfig {
  rlm: {
    enabled: boolean;
    classify: {
      skipMaxBytes: number;
      deepMinPageRank: number;
      deepMinFanIn: number;
    };
    deep: {
      maxToolCalls: number;
      maxRuntimeMs: number;
    };
    batch: {
      enabled: boolean;
      maxPagesPerBatch: number;
    };
  };
}

export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  rlm: {
    enabled: false,
    classify: {
      skipMaxBytes: 256,
      deepMinPageRank: 0.75,
      deepMinFanIn: 25,
    },
    deep: {
      maxToolCalls: 20,
      maxRuntimeMs: 120_000,
    },
    batch: {
      enabled: true,
      maxPagesPerBatch: 5,
    },
  },
};

export function wikiConfigPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki.config.json");
}

// Deep-merge a partial user config over the defaults, field-by-field. Unknown
// keys are ignored; each known block falls back individually. Never throws.
export function mergeWikiConfig(parsed: DeepPartial<WikiConfig>): WikiConfig {
  const base = DEFAULT_WIKI_CONFIG;
  const rlm = parsed.rlm ?? {};
  const classify = rlm.classify ?? {};
  const deep = rlm.deep ?? {};
  const batch = rlm.batch ?? {};
  return {
    rlm: {
      enabled: booleanOr(rlm.enabled, base.rlm.enabled),
      classify: {
        skipMaxBytes: numberOr(classify.skipMaxBytes, base.rlm.classify.skipMaxBytes),
        deepMinPageRank: numberOr(classify.deepMinPageRank, base.rlm.classify.deepMinPageRank),
        deepMinFanIn: numberOr(classify.deepMinFanIn, base.rlm.classify.deepMinFanIn),
      },
      deep: {
        // `positiveNumberOr`, not `numberOr` (flow 169 T10, review finding
        // #3): these two fields gate the deep child's actual safety budget
        // (tool-call count / wall-clock runtime). `numberOr` alone only
        // rejects non-finite/non-numeric JSON — a configured `0` or a
        // negative number passed straight through and, downstream in
        // `deep-enrich.ts`, a non-positive `maxRuntimeMs` used to disable
        // the timeout entirely (`await turn` with no bound). Reject
        // non-positive values back to the built-in default here too, so a
        // malformed/hostile config can no longer reach that code path in the
        // first place.
        maxToolCalls: positiveNumberOr(deep.maxToolCalls, base.rlm.deep.maxToolCalls),
        maxRuntimeMs: positiveNumberOr(deep.maxRuntimeMs, base.rlm.deep.maxRuntimeMs),
      },
      batch: {
        enabled: booleanOr(batch.enabled, base.rlm.batch.enabled),
        maxPagesPerBatch: numberOr(batch.maxPagesPerBatch, base.rlm.batch.maxPagesPerBatch),
      },
    },
  };
}

// Load `.metaproject/wiki.config.json`, falling back to defaults when the
// file is absent OR malformed (advisory-safe, never throws).
export async function loadWikiConfig(cwd: string): Promise<WikiConfig> {
  const file = wikiConfigPath(cwd);
  if (!(await pathExists(file))) {
    return mergeWikiConfig({});
  }
  const parsed = await readJsonFileOr<DeepPartial<WikiConfig>>(file, {});
  return mergeWikiConfig(parsed);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Same "malformed degrades to default, never throws" contract as `numberOr`,
// but also floors out non-positive values (flow 169 T10, review finding #3).
// Reserved for fields where 0/negative does not mean "a smaller number" but
// actually REMOVES a safety guarantee downstream (see `deep.maxToolCalls`/
// `deep.maxRuntimeMs` above).
//
// Deliberately NOT applied to `classify.skipMaxBytes`, `classify.deepMinPageRank`,
// `classify.deepMinFanIn`, or `batch.maxPagesPerBatch` (checked all four while
// fixing this finding, per its own suggestion): 0 is a legitimate, load-bearing
// value for the three classify fields (e.g. `skipMaxBytes: 0` means "never
// classify skip", `deepMinFanIn: 0` means "always classify deep" — both are
// used deliberately by `enrich-rlm.test.ts`'s own fixtures) and a negative
// value behaves identically to 0 for all three (harmless, not a disabled
// guard). `batch.maxPagesPerBatch` is already floor-clamped to `>= 1` at its
// only call site (`groupLightPagesIntoBatches`'s `Math.max(1, ...)`), so a
// non-positive value there degrades to "batch of 1" rather than disabling
// anything.
function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};
