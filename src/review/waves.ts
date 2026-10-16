import { BUNDLED_PATH_GATES } from "./coverage";
import type { SliceEntry, SliceManifest } from "./slice";
import { ROUTABLE_ROLES } from "./slice-routing";

/**
 * Slices a reviewer must have seen: the manifest's original slices it owns. A slice that carries `roles` (slice routing)
 * is owned by those roles; a reviewer routing does not decide for (a project reviewer, `review-pr-contract`) and a slice
 * without `roles` keep the old rule: every slice whose files its path gate matches.
 */
export function requiredSlices(manifest: Pick<SliceManifest, "slices">, reviewer: string): string[] {
  const gate = BUNDLED_PATH_GATES[reviewer];
  const routable = ROUTABLE_ROLES.has(reviewer);
  return manifest.slices
    // A fix slice of a delta round (flow 458) belongs to exactly its roster, whether or not a role is routable: an author
    // that is a project reviewer reads the slice that answers its finding, and no other project reviewer is owed it.
    .filter((s) => s.retryOf === undefined && ((s.kind === "fix" || s.kind === "second-look") && Array.isArray(s.roles) ? s.roles.includes(reviewer) : routable && Array.isArray(s.roles) ? s.roles.includes(reviewer) : gate === undefined || s.files.some(gate)))
    .map((s) => s.id);
}

type Cut = { attempt: number; parents: string[]; members: SliceEntry[] };

export type SliceGraph = {
  /** Every slice id the claimed ids account for: themselves, and a slice whose smaller re-cut was covered in full. */
  accounted(claimed: Iterable<string>): Set<string>;
  /** The slices still to hand out for `ids`, as small as the latest re-cut made them. Covered ones are skipped. */
  open(ids: readonly string[], accounted: ReadonlySet<string>): SliceEntry[];
};

/**
 * How a reviewer's slices relate to the smaller re-cuts a retry made of them. A re-cut piece covers its original only
 * when every piece of that cut is covered: crediting the original for one piece would hide the rest of its text.
 * Pieces carry a `reviewer`; one without it (a hand-written manifest) is shared.
 */
export function sliceGraph(manifest: SliceManifest, reviewer: string): SliceGraph {
  const byId = new Map(manifest.slices.map((s) => [s.id, s]));
  const cuts = new Map<string, Cut>();
  for (const s of manifest.slices) {
    if (s.retryOf === undefined || s.retryOf.length === 0) continue;
    if (s.reviewer !== undefined && s.reviewer !== reviewer) continue;
    const parents = [...s.retryOf].sort();
    const key = `${s.attempt ?? 0}|${parents.join(",")}`;
    const cut = cuts.get(key) ?? { attempt: s.attempt ?? 0, parents, members: [] };
    cut.members.push(s);
    cuts.set(key, cut);
  }
  const cutsOf = new Map<string, Cut[]>();
  for (const cut of cuts.values()) {
    for (const parent of cut.parents) cutsOf.set(parent, [...(cutsOf.get(parent) ?? []), cut]);
  }

  return {
    accounted(claimed) {
      const given = new Set(claimed);
      const memo = new Map<string, boolean>();
      const walking = new Set<string>();
      const covers = (id: string): boolean => {
        if (given.has(id)) return true;
        const known = memo.get(id);
        if (known !== undefined) return known;
        if (walking.has(id)) return false;
        walking.add(id);
        const yes = (cutsOf.get(id) ?? []).some((cut) => cut.members.every((m) => covers(m.id)));
        walking.delete(id);
        memo.set(id, yes);
        return yes;
      };
      const out = new Set(given);
      for (const id of byId.keys()) if (covers(id)) out.add(id);
      return out;
    },
    open(ids, accounted) {
      const out: SliceEntry[] = [];
      const seen = new Set<string>();
      const visit = (id: string): void => {
        if (accounted.has(id) || seen.has(id)) return;
        seen.add(id);
        const entry = byId.get(id);
        if (entry === undefined) return;
        const latest = (cutsOf.get(id) ?? []).reduce<Cut | undefined>((best, cut) => (best === undefined || cut.attempt > best.attempt ? cut : best), undefined);
        if (latest === undefined) out.push(entry);
        else for (const member of latest.members) visit(member.id);
      };
      for (const id of ids) visit(id);
      return out;
    },
  };
}

export type WaveSummary = { slices: number; bytes: number; waves: number };

export function summarizeWaves(waves: ReadonlyArray<ReadonlyArray<{ bytes: number }>>): WaveSummary {
  const all = waves.flat();
  return { slices: all.length, bytes: all.reduce((total, s) => total + s.bytes, 0), waves: waves.length };
}
