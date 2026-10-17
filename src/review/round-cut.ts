// How one round's scope is cut into slices (flow 458, 460). A first round cuts the whole source, routed as round 1. A
// delta round cuts the lines that answer prior findings (fix), the new lines, and the unchanged code the previous round
// read (second look) apart, each routed by its own roster. Pure: `review slice` reads the diffs and writes the result.

import { classifyDeltaSlices, partitionRegionsByFix, tagSecondLookSlices } from "./round-split";
import type { PriorFinding, RoundRecord } from "./round-record";
import type { ScopedRegion } from "./scope";
import { type BuiltSlice, type SliceManifest, type SliceOmission, type SliceSource, buildSlices, ledgerOmissions } from "./slice";
import { type RoutingOptions, routeSlices } from "./slice-routing";

export type SliceSizes = { maxBytes: number; waveBytes: number };
/** What one round's cut produces: the slices (with text), every omission once, and the manifest fields of the cut. */
export type RoundCut = { slices: BuiltSlice[]; omissions: SliceOmission[]; manifest: SliceManifest; totals: SliceManifest["totals"] };
/** The second-look cut of a delta round: `regions` hold only second-look lines; `outside` the other changed lines no other cut carries. */
export type SecondLookSource = SliceSource & { outside: ScopedRegion[] };

/** A first or fallback-first round: one cut over the whole source, routed as round 1. */
export function firstRoundCut(source: SliceSource, sizes: SliceSizes, routing: RoutingOptions): RoundCut {
  const built = buildSlices(source, sizes);
  return { slices: routeSlices(built.slices, routing), omissions: built.manifest.omissions, manifest: built.manifest, totals: built.manifest.totals };
}

/** `regions` without those of a file the ledger judgement omitted whole. */
function withoutOmitted(regions: readonly ScopedRegion[], omitted: readonly SliceOmission[]): ScopedRegion[] {
  const files = new Set(omitted.map((omission) => omission.path));
  return regions.filter((region) => !files.has(region.path));
}

/**
 * The slices of `regions`, cut from `from` with ledgers kept (the caller judged them over the whole source). A source's
 * pre-filter drops are recorded by its main cut only (`withDrops`), so a side cut of the same source never repeats them.
 */
function cutRegions(from: SliceSource, regions: ScopedRegion[], sizes: SliceSizes, withDrops: boolean): ReturnType<typeof buildSlices> {
  return buildSlices({ ...from, regions, drops: withDrops ? from.drops : [] }, { ...sizes, keepLedgers: true });
}

/**
 * A delta round (flow 458, 460 L6): the lines that answer prior findings are cut apart from the new lines before slicing,
 * so a fix slice holds only fix hunks (fix roster plus its own content roles) while every new line, even in the same file,
 * is routed as in round 1; unchanged code the previous round read gets its second look. Ledgers are judged once over the
 * whole source before the fix/new partition, so a file is omitted (with its full size) or sliced, never both.
 */
export function deltaRoundCut(input: { source: SliceSource; delta: RoundRecord; prior: readonly PriorFinding[]; sizes: SliceSizes; routing: RoutingOptions; secondLook: SecondLookSource | undefined }): RoundCut {
  const { source, delta, prior, sizes, routing } = input;
  const routeAsDelta = (slices: BuiltSlice[]): BuiltSlice[] => classifyDeltaSlices(routeSlices(slices, routing), delta, prior);
  const ledgers = ledgerOmissions(source.regions);
  const parts = partitionRegionsByFix(withoutOmitted(source.regions, ledgers), delta.fixHunks);
  const built = cutRegions(source, parts.other, sizes, true);
  const fixSlices = parts.fix.length === 0 ? [] : routeAsDelta(cutRegions(source, parts.fix, sizes, false).slices);
  const classified = routeAsDelta(built.slices);
  const look = input.secondLook === undefined ? undefined : secondLookCut(input.secondLook, delta, sizes, routing, routeAsDelta);
  const ordered = [...fixSlices, ...classified, ...(look?.outside ?? []), ...(look?.second ?? [])];
  const slices = ordered.length === classified.length ? classified : renumberSlices(ordered);
  const omissions = [...built.manifest.omissions, ...ledgers, ...(look?.omissions ?? [])].filter((omission, index, all) => all.findIndex((known) => known.path === omission.path) === index);
  return { slices, omissions, manifest: built.manifest, totals: built.manifest.totals };
}

/**
 * Second look (flow 460): ledgers are judged over the second-look and outside regions together, then each side is cut
 * apart, so a second-look slice holds only second-look lines (what the routing check backs) and the rest is new.
 */
function secondLookCut(look: SecondLookSource, delta: RoundRecord, sizes: SliceSizes, routing: RoutingOptions, routeAsDelta: (slices: BuiltSlice[]) => BuiltSlice[]): { second: BuiltSlice[]; outside: BuiltSlice[]; omissions: SliceOmission[] } {
  const ledgers = ledgerOmissions([...look.regions, ...look.outside]);
  const secondBuilt = cutRegions(look, withoutOmitted(look.regions, ledgers), sizes, true);
  const outsideRegions = withoutOmitted(look.outside, ledgers);
  const outside = outsideRegions.length === 0 ? [] : routeAsDelta(cutRegions(look, outsideRegions, sizes, false).slices);
  const second = tagSecondLookSlices(routeSlices(secondBuilt.slices, { head: routing.head }), delta.round - 1);
  return { second, outside, omissions: [...ledgers, ...secondBuilt.manifest.omissions] };
}

/** Renumber slices `slice-NN` in order, so ids and file names stay one sequence after two cuts are joined. */
export function renumberSlices<T extends { id: string; path: string }>(slices: readonly T[]): T[] {
  const width = Math.max(2, String(slices.length).length);
  return slices.map((slice, index) => {
    const id = `slice-${String(index + 1).padStart(width, "0")}`;
    return { ...slice, id, path: `${id}.diff` };
  });
}
