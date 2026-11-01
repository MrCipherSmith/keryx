import type { DetectorMatch, SecurityConfig } from "../types";
import type { CapabilitySpec } from "../../capability/seam";
import { resolveCapability } from "../../capability/seam";
import { detectSecrets } from "./secrets";
import { detectEntropy } from "./entropy";
import { detectPii } from "./pii";
import { detectInjection } from "./injection";
import { detectEgress } from "./egress";
import { detectExfil } from "./exfil";
import { injectionModelSpec } from "./injection/adapter";
import { piiNerSpec } from "./pii/ner-adapter";

export { detectSecrets } from "./secrets";
export { detectEntropy } from "./entropy";
export { detectPii } from "./pii";
export { detectInjection } from "./injection";
export { detectEgress } from "./egress";
export { detectExfil } from "./exfil";

// The text-classification / NER runtime resolved lazily by the capability seam.
// No model runtime is shipped (the @xenova/onnx stack was removed for weight),
// so this is empty ⇒ the model backends stay off and detection runs on the
// deterministic floor (regex + entropy). Set to a transformers.js-API package to
// opt back into the Prompt-Guard / NER model backends.
export const SECURITY_MODEL_RUNTIME = "";

// Run every enabled detector over `content` and return raw matches. Policy
// enable flags gate which detector categories run; entropy is additionally gated
// by the entropy backend flag. De-duplicates overlapping secret spans so an
// entropy hit never doubles a precise secret hit at the same offset.
export function runDetectors(content: string, config: SecurityConfig): DetectorMatch[] {
  const matches: DetectorMatch[] = [];

  if (config.policies.secrets.enabled) {
    matches.push(...detectSecrets(content));
    if (config.backends.entropy.enabled) {
      matches.push(...detectEntropy(content));
    }
  }
  if (config.policies.pii.enabled) {
    matches.push(...detectPii(content));
  }
  if (config.policies.promptInjection.enabled) {
    matches.push(...detectInjection(content));
  }
  if (config.policies.egress.enabled) {
    const allowlist = config.policies.egress.allowlist ?? [];
    matches.push(...detectEgress(content, allowlist));
    matches.push(...detectExfil(content, allowlist));
  }

  return dedupeOverlaps(matches);
}

// Optional adapter specs, injectable so tests can drive the availability-true
// merge path with a deterministic classifier/recognizer (no model download).
export interface DetectorBackendSpecs {
  injection?: CapabilitySpec<string, DetectorMatch[]>;
  piiNer?: CapabilitySpec<string, DetectorMatch[]>;
}

// The async pipeline (Block E): the deterministic `runDetectors` result PLUS,
// when their capability is enabled AND resolves, the opt-in injection-model and
// NER adapter matches. Adapter resolution is `await`ed but NEVER throws out (the
// seam catches; a `run()` throw is caught here) so an unavailable/broken backend
// degrades to the byte-identical deterministic path (AC0.1, AC1.3, AC4.3).
export async function runDetectorsAsync(
  cwd: string,
  content: string,
  config: SecurityConfig,
  specs: DetectorBackendSpecs = {},
): Promise<DetectorMatch[]> {
  const matches = runDetectors(content, config);

  // E1 — semantic injection model. Only resolved when the config toggle is on,
  // so a disabled backend touches no dep and no asset (AC1.1).
  const injectionCfg = config.backends.injectionModel;
  if (
    config.policies.promptInjection.enabled &&
    injectionCfg?.enabled === true
  ) {
    const spec =
      specs.injection ??
      injectionModelSpec(
        SECURITY_MODEL_RUNTIME,
        injectionCfg.assetId,
        injectionCfg.minConfidence,
      );
    await mergeAdapter(cwd, content, spec, matches);
  }

  // E4-NER — optional NER PII backend, gated by `backends.piiModel.enabled`.
  const piiCfg = config.backends.piiModel;
  if (config.policies.pii.enabled && piiCfg.enabled === true && piiCfg.assetId) {
    const spec =
      specs.piiNer ?? piiNerSpec(SECURITY_MODEL_RUNTIME, piiCfg.assetId);
    await mergeAdapter(cwd, content, spec, matches);
  }

  return dedupeOverlaps(matches);
}

// Resolve one adapter and merge its matches, swallowing any run() error so the
// deterministic path is never broken by an opt-in backend.
async function mergeAdapter(
  cwd: string,
  content: string,
  spec: CapabilitySpec<string, DetectorMatch[]>,
  into: DetectorMatch[],
): Promise<void> {
  const adapter = await resolveCapability(cwd, spec);
  if (!adapter) {
    return;
  }
  try {
    into.push(...(await adapter.run(content)));
  } catch {
    // seam already warned; deterministic matches stand.
  }
}

// Drop a lower-confidence match whose span is fully contained by a
// higher-confidence match of the same category (e.g. entropy inside an exact
// secret). Keeps the strongest signal per region.
//
// "Is it inside a kept span?" is a prefix-max query: among kept spans of the
// category that start at or before the candidate, does the furthest end reach
// the candidate's end? A Fenwick tree over each category's starts answers it in
// O(log n). The linear `kept.some` it replaces was O(n^2) on a dense tool
// result, e.g. a log with an IP address on every line
// (review-performance-slice-35:F-003).
export function dedupeOverlaps(matches: DetectorMatch[]): DetectorMatch[] {
  const trees = new Map<string, { starts: number[]; maxEnd: number[] }>();
  for (const match of matches) {
    const tree = trees.get(match.category) ?? { starts: [], maxEnd: [] };
    tree.starts.push(match.start);
    trees.set(match.category, tree);
  }
  for (const tree of trees.values()) {
    tree.starts = [...new Set(tree.starts)].sort((a, b) => a - b);
    tree.maxEnd = new Array<number>(tree.starts.length + 1).fill(-Infinity);
  }

  const kept: DetectorMatch[] = [];
  const sorted = [...matches].sort((a, b) => b.confidence - a.confidence);
  for (const candidate of sorted) {
    const tree = trees.get(candidate.category) as { starts: number[]; maxEnd: number[] };
    // 1-based position of the candidate's start among the category's starts.
    const position = upperBound(tree.starts, candidate.start);
    let furthest = -Infinity;
    for (let i = position; i > 0; i -= i & -i) {
      furthest = Math.max(furthest, tree.maxEnd[i] as number);
    }
    if (furthest >= candidate.end) {
      continue;
    }
    kept.push(candidate);
    for (let i = position; i < tree.maxEnd.length; i += i & -i) {
      tree.maxEnd[i] = Math.max(tree.maxEnd[i] as number, candidate.end);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

// The number of values in the sorted array that are <= value.
function upperBound(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] as number) <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
