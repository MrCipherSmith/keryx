import { packWaves, waveBytesOf, type SliceManifest } from "./slice";
import { REVIEW_TURN_MAX_WAVES, REVIEW_WAVE_MAX_CHILDREN } from "./wave-limits";

// Admission uses the same original slice packing and limits as the native spawn tool.
export function desktopPassAllocator(manifest: SliceManifest) {
  const slicePass = new Map<string, string>();
  packWaves(manifest.slices.filter(slice => !slice.retryOf), waveBytesOf(manifest)).forEach((group, index) => {
    for (const slice of group) slicePass.set(slice.id, `slices-${String(index + 1).padStart(3, "0")}`);
  });
  const counts = new Map<string, number>();
  return (slices: readonly string[]) => {
    const candidates = [...new Set(slices.map(id => slicePass.get(id)).filter((pass): pass is string => !!pass))];
    const pass = (candidates.length ? candidates : ["round"]).find(key =>
      (counts.get(key) ?? 0) < REVIEW_WAVE_MAX_CHILDREN && (counts.has(key) || counts.size < REVIEW_TURN_MAX_WAVES));
    if (!pass) throw new Error("The review assignments cannot fit the native wave admission limits for one turn. Reduce the review scope or its reviewer wave limit, or split the plan.");
    counts.set(pass, (counts.get(pass) ?? 0) + 1);
    return pass;
  };
}

/** Reserve the same original-slice pools before an automatic or human approval is recorded. */
export function preflightDesktopPasses(
  manifest: SliceManifest,
  assignments: readonly { reviewer: string; slices: string[]; wave: number }[],
  maxWaves?: number,
): void {
  const allocate = desktopPassAllocator(manifest);
  for (const { reviewer, slices, wave } of assignments) {
    if (maxWaves !== undefined && wave > maxWaves) continue;
    try {
      allocate(slices);
    } catch (cause) {
      throw new Error(`Native wave admission limits prevent assigning ${reviewer} wave ${wave}. Reduce the review scope or split the plan.`, { cause });
    }
  }
}
