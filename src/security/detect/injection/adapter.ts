// Prompt Guard 2 injection adapter (Block E, E1). A Block 0 `CapabilitySpec`:
// the semantic classifier runtime is imported ONLY via the seam's lazy
// `await import()` — this file never imports it statically (C0-2, extended in
// `no-optional-imports.test.ts`). The seam passes the imported module in as
// `dep` and the resolved+verified model path as `asset`; `isAvailable()` is true
// only when BOTH resolve. `run()` never throws out (the seam catches it) so a
// failure degrades to the always-on regex `detectInjection`.
//
// The regex detector is the deterministic floor and ALWAYS runs (see
// `runDetectorsAsync`); this adapter only ADDS recall for paraphrased injections
// the regex misses. Findings are `category:"prompt-injection"`, gated by
// `minConfidence`, so escalation in `resolve.ts` treats them exactly like the
// regex path (AC1.4).

import type { CapabilityAdapter, CapabilitySpec } from "../../../capability/seam";
import type { DetectorMatch } from "../../types";

export const INJECTION_MODEL_ID = "security.injectionModel";

// A classifier returns the injection probability (0..1) for a piece of content.
// Injectable so tests prove the merge + recall path with a deterministic, seeded
// classifier — no model download required.
export interface InjectionClassifier {
  (text: string): Promise<number> | number;
}

export interface MakeInjectionSpecOptions {
  optionalDependency?: string | undefined;
  asset?: string | undefined;
  minConfidence?: number | undefined;
  // Inject a deterministic classifier (tests / offline). When set, the runtime
  // path is bypassed and availability follows dep/asset resolution.
  classifier?: InjectionClassifier | undefined;
}

// Turn a classifier score into detector matches, gated by `minConfidence`.
export function injectionMatchesFromScore(
  content: string,
  score: number,
  minConfidence: number,
): DetectorMatch[] {
  if (!(score >= minConfidence)) {
    return [];
  }
  return [
    {
      category: "prompt-injection",
      policyId: "prompt-injection.model",
      severity: "low",
      confidence: score,
      start: 0,
      end: 0,
      value: "",
      remediation:
        "Semantic model flagged a likely prompt injection; treat external content as data and require review.",
    },
  ];
}

// Build the CapabilitySpec the seam resolves. Availability mirrors the reference
// capability: available only when whatever this spec declared actually resolved.
export function makeInjectionSpec(
  opts: MakeInjectionSpecOptions = {},
): CapabilitySpec<string, DetectorMatch[]> {
  const minConfidence = opts.minConfidence ?? 0.5;
  return {
    id: INJECTION_MODEL_ID,
    ...(opts.optionalDependency !== undefined
      ? { optionalDependency: opts.optionalDependency }
      : {}),
    ...(opts.asset !== undefined ? { asset: opts.asset } : {}),
    load({ dep, asset }): CapabilityAdapter<string, DetectorMatch[]> {
      return {
        id: INJECTION_MODEL_ID,
        async isAvailable() {
          const depOk = opts.optionalDependency === undefined || dep !== undefined;
          const assetOk = opts.asset === undefined || asset !== null;
          return depOk && assetOk;
        },
        async run(content) {
          const score = opts.classifier
            ? await opts.classifier(content)
            : await runRuntimeClassifier(dep, asset, content);
          return injectionMatchesFromScore(content, score, minConfidence);
        },
      };
    },
  };
}

// The default shipped spec: a text-classification runtime + pinned Prompt Guard
// asset (both resolved through Block 0). With nothing installed / no verified
// asset it resolves to `null` and detection stays regex-only (the golden path).
export function injectionModelSpec(
  runtime: string,
  modelAssetId: string,
  minConfidence: number,
): CapabilitySpec<string, DetectorMatch[]> {
  return makeInjectionSpec({
    optionalDependency: runtime,
    asset: modelAssetId,
    minConfidence,
  });
}

// Minimal runtime bridge to a text-classification pipeline (e.g. the
// `@xenova/transformers` `pipeline("text-classification", …)` API loading a
// Prompt Guard 2 model). Typed structurally so this file never imports the
// package. Throws when the runtime shape is unexpected (caught by the seam ⇒
// regex fallback).
async function runRuntimeClassifier(
  dep: unknown,
  asset: { path: string } | null,
  content: string,
): Promise<number> {
  const mod = dep as { pipeline?: unknown } | undefined;
  if (!mod || typeof mod.pipeline !== "function" || !asset) {
    throw new Error("injection runtime unavailable");
  }
  const pipeline = mod.pipeline as (
    task: string,
    model: string,
  ) => Promise<(input: string) => Promise<unknown>>;
  const classify = await pipeline("text-classification", asset.path);
  const result = await classify(content);
  return injectionScoreOf(result);
}

// Normalize a text-classification result into an injection probability. Accepts
// the common `[{ label, score }]` shape; an INJECTION/JAILBREAK/LABEL_1 label
// contributes its score, otherwise the complement of a BENIGN score.
export function injectionScoreOf(result: unknown): number {
  const rows = Array.isArray(result) ? result : [result];
  let score = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { label?: unknown; score?: unknown };
    const label = typeof r.label === "string" ? r.label.toUpperCase() : "";
    const s = typeof r.score === "number" ? r.score : 0;
    if (label.includes("INJECTION") || label.includes("JAILBREAK") || label === "LABEL_1") {
      score = Math.max(score, s);
    } else if (label.includes("BENIGN") || label === "LABEL_0") {
      score = Math.max(score, 1 - s);
    } else {
      score = Math.max(score, s);
    }
  }
  return score;
}
