// Optional NER PII adapter (Block E, E4-NER). A Block 0 `CapabilitySpec` over
// `backends.piiModel`: the NER runtime is imported ONLY via the seam's lazy
// `await import()` — never statically here (C0-2). When available it merges
// person/location/org spans as `category:"pii"` findings; unavailable ⇒ the
// deterministic PII detectors are the byte-identical floor (AC4.3). `run()` never
// throws out (the seam catches it) so a failure degrades to deterministic PII.

import type { CapabilityAdapter, CapabilitySpec } from "../../../capability/seam";
import type { DetectorMatch } from "../../types";

export const PII_NER_ID = "security.piiNer";

// A recognized entity span produced by the NER runtime.
export interface NerEntity {
  start: number;
  end: number;
  value: string;
  label: string; // PERSON | LOCATION | ORG | …
  score?: number;
}

// Injectable recognizer so tests prove the merge path with a deterministic,
// seeded recognizer — no model download required.
export interface NerRecognizer {
  (text: string): Promise<NerEntity[]> | NerEntity[];
}

// Map an entity label to a typed, fixed-width mask (leak-safe, E-9).
function maskForLabel(label: string): string {
  const l = label.toUpperCase();
  if (l.includes("LOC") || l.includes("GPE")) return "address";
  return "name"; // PERSON / ORG / default
}

export function nerMatchesFrom(entities: NerEntity[]): DetectorMatch[] {
  const out: DetectorMatch[] = [];
  for (const e of entities) {
    if (e.end <= e.start || !e.value) continue;
    out.push({
      category: "pii",
      policyId: "pii.ner",
      severity: "low",
      confidence: typeof e.score === "number" ? e.score : 0.6,
      start: e.start,
      end: e.end,
      value: e.value,
      mask: maskForLabel(e.label),
      remediation: "Redact recognized personal entities before persisting or publishing.",
    });
  }
  return out;
}

export interface MakeNerSpecOptions {
  optionalDependency?: string | undefined;
  asset?: string | undefined;
  recognizer?: NerRecognizer | undefined;
}

export function makeNerSpec(
  opts: MakeNerSpecOptions = {},
): CapabilitySpec<string, DetectorMatch[]> {
  return {
    id: PII_NER_ID,
    ...(opts.optionalDependency !== undefined
      ? { optionalDependency: opts.optionalDependency }
      : {}),
    ...(opts.asset !== undefined ? { asset: opts.asset } : {}),
    load({ dep, asset }): CapabilityAdapter<string, DetectorMatch[]> {
      return {
        id: PII_NER_ID,
        async isAvailable() {
          const depOk = opts.optionalDependency === undefined || dep !== undefined;
          const assetOk = opts.asset === undefined || asset !== null;
          return depOk && assetOk;
        },
        async run(content) {
          const entities = opts.recognizer
            ? await opts.recognizer(content)
            : await runRuntimeRecognizer(dep, asset, content);
          return nerMatchesFrom(entities);
        },
      };
    },
  };
}

// The default shipped spec: an NER runtime + pinned model asset (both resolved
// through Block 0). With nothing installed / no verified asset it resolves to
// `null` and PII detection stays deterministic (the golden path).
export function piiNerSpec(
  runtime: string,
  modelAssetId: string,
): CapabilitySpec<string, DetectorMatch[]> {
  return makeNerSpec({ optionalDependency: runtime, asset: modelAssetId });
}

// Minimal runtime bridge to a token-classification NER pipeline. Typed
// structurally so this file never imports the package. Throws on an unexpected
// shape (caught by the seam ⇒ deterministic fallback).
async function runRuntimeRecognizer(
  dep: unknown,
  asset: { path: string } | null,
  content: string,
): Promise<NerEntity[]> {
  const mod = dep as { pipeline?: unknown } | undefined;
  if (!mod || typeof mod.pipeline !== "function" || !asset) {
    throw new Error("NER runtime unavailable");
  }
  const pipeline = mod.pipeline as (
    task: string,
    model: string,
  ) => Promise<(input: string) => Promise<unknown>>;
  const recognize = await pipeline("token-classification", asset.path);
  const result = await recognize(content);
  const rows = Array.isArray(result) ? result : [];
  const entities: NerEntity[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const start = typeof r.start === "number" ? r.start : undefined;
    const end = typeof r.end === "number" ? r.end : undefined;
    const word = typeof r.word === "string" ? r.word : typeof r.entity === "string" ? "" : "";
    const label = typeof r.entity_group === "string" ? r.entity_group : typeof r.entity === "string" ? r.entity : "PERSON";
    if (start !== undefined && end !== undefined) {
      entities.push({
        start,
        end,
        value: word || content.slice(start, end),
        label,
        ...(typeof r.score === "number" ? { score: r.score } : {}),
      });
    }
  }
  return entities;
}
