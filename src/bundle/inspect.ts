// Flow 313 (W4 portability), T6 — `keryx bundle inspect`'s deterministic
// core: strictly read-only (W4-AC5). No temp files, no `mkdir`, no ledger
// write, and no process is spawned — reuses `planBundleImport`'s diff logic
// (itself read-only: it reads current file bytes and the applied-state
// ledger but never writes) and strips the entry `bytes` before returning.

import { generateCapabilityMatrix, type MatrixSurfaceState } from "../integrations/matrix";
import { openBundle } from "./archive";
import { parseManifest } from "./manifest";
import { planBundleImport, type PlanBucket } from "./plan";
import { verifyBundle, type VerifyResult } from "./verify";
import type { BundleManifest, BundleRefusal, BundleScope } from "./types";

export interface InspectPlanEntry {
  path: string;
  kind: string;
  entryScope: BundleScope;
  targetScope: BundleScope;
  targetRelative: string;
  displayId: string;
  bucket: PlanBucket;
  conflictReason?: string;
  forced: boolean;
}

export interface InspectResult {
  ok: boolean;
  refusals: BundleRefusal[];
  manifest?: BundleManifest;
  verify?: VerifyResult;
  entries: InspectPlanEntry[];
  warnings: string[];
}

export interface InspectBundleOptions {
  projectRoot: string;
  targetScope?: BundleScope | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
  capabilityHarnessStates?: ((harnessId: string) => MatrixSurfaceState | undefined) | undefined;
}

export async function inspectBundle(bundlePath: string, opts: InspectBundleOptions): Promise<InspectResult> {
  const opened = await openBundle(bundlePath);
  if (!opened.ok) {
    return { ok: false, refusals: [opened.refusal], entries: [], warnings: [] };
  }
  const parsed = parseManifest(opened.value.manifestBytes);
  if (!parsed.ok) {
    return { ok: false, refusals: parsed.refusals, entries: [], warnings: [] };
  }

  const verifyResult = verifyBundle(opened.value, parsed.manifest);

  const plan = await planBundleImport({
    source: opened.value,
    manifest: parsed.manifest,
    projectRoot: opts.projectRoot,
    targetScope: opts.targetScope,
    env: opts.env,
    homeDir: opts.homeDir,
  });

  const entries: InspectPlanEntry[] = plan.entries.map((e) => ({
    path: e.path,
    kind: e.kind,
    entryScope: e.entryScope,
    targetScope: e.targetScope,
    targetRelative: e.targetRelative,
    displayId: e.displayId,
    bucket: e.bucket,
    ...(e.conflictReason !== undefined ? { conflictReason: e.conflictReason } : {}),
    forced: e.forced,
  }));

  const warnings: string[] = [];
  const lookup = opts.capabilityHarnessStates ?? defaultCapabilityLookup();
  for (const harness of parsed.manifest.compat.targetHarnesses ?? []) {
    const state = lookup(harness);
    if (state !== "native" && state !== "adapter") {
      warnings.push(`advisory only: bundle author names ${harness}; the capability matrix reports ${state ?? "unknown"}`);
    }
  }

  const ok = verifyResult.ok && plan.refusals.length === 0;
  return { ok, refusals: plan.refusals, manifest: parsed.manifest, verify: verifyResult, entries, warnings };
}

function defaultCapabilityLookup(): (harnessId: string) => MatrixSurfaceState | undefined {
  const matrix = generateCapabilityMatrix();
  const byId = new Map(matrix.harnesses.map((h) => [h.id, h.state]));
  return (id) => byId.get(id);
}
