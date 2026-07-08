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
// Reuses the already-declared optional runtime (never a top-level import).
export const SECURITY_MODEL_RUNTIME = "@xenova/transformers";

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
function dedupeOverlaps(matches: DetectorMatch[]): DetectorMatch[] {
  const kept: DetectorMatch[] = [];
  const sorted = [...matches].sort((a, b) => b.confidence - a.confidence);
  for (const candidate of sorted) {
    const covered = kept.some(
      (existing) =>
        existing.category === candidate.category &&
        candidate.start >= existing.start &&
        candidate.end <= existing.end,
    );
    if (!covered) {
      kept.push(candidate);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}
