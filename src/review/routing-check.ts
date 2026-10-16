// Security review M3 (flow 457): slice routing is recorded in the slice manifest, which the orchestrating agent can
// edit. `ledger build` and `review complete` route each slice again from its own text and refuse a manifest whose
// recorded roles or depth are narrower than what the content needs (a security or architecture role routed out of a
// code slice, a code slice marked light). Reach and Jev scores only ever make a slice deeper and are not recomputed
// here, so the recomputation is a lower bound: the manifest may be wider, never narrower.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScopedDiff, type SliceEntry, type SliceManifest } from "./slice";
import { routeSliceRegions } from "./slice-routing";
import { expectedFixRoles, fixClaimBacked, fixContextOf, type FixContext } from "./round-split";

export type NarrowedSlice = { id: string; missingRoles: string[]; depth?: { recorded: string; needed: "deep" } };

/** Slices whose recorded routing is narrower than their content needs. `readText` returns undefined when unreadable. */
export function narrowedSlices(manifest: Pick<SliceManifest, "slices">, readText: (entry: SliceEntry) => string | undefined, fix?: FixContext): { narrowed: NarrowedSlice[]; unreadable: string[] } {
  const originals = manifest.slices.filter((entry) => entry.retryOf === undefined && Array.isArray(entry.roles));
  const changedFiles = [...new Set(manifest.slices.filter((entry) => entry.retryOf === undefined).flatMap((entry) => entry.files))];
  const narrowed: NarrowedSlice[] = [];
  const unreadable: string[] = [];
  for (const entry of originals) {
    const text = readText(entry);
    if (text === undefined) {
      unreadable.push(entry.id);
      continue;
    }
    // A fix slice of a delta round (flow 458) has its own roster, computed with the function `review slice` routes with. The
    // round must back the claim; one it does not back is routed, and so judged, as a new slice.
    if (fixClaimBacked(entry, fix)) {
      const recordedFix = new Set(entry.roles ?? []);
      const missingFix = expectedFixRoles(entry, fix!).filter((role) => !recordedFix.has(role));
      if (missingFix.length > 0) narrowed.push({ id: entry.id, missingRoles: missingFix });
      continue;
    }
    // Slice files are always written in the scoped format (like `routeSlices` reads them). Sniffing the format would let
    // an added line that starts with `++ ` pass for a git header and route the slice as an empty unified diff.
    const needed = routeSliceRegions(entry.id, parseScopedDiff(text), { changedFiles });
    const recorded = new Set(entry.roles ?? []);
    const missingRoles = needed.roles.filter((role) => !recorded.has(role));
    const shallow = needed.depth === "deep" && entry.depth !== "deep";
    if (missingRoles.length > 0 || shallow) {
      narrowed.push({ id: entry.id, missingRoles, ...(shallow ? { depth: { recorded: entry.depth ?? "unset", needed: "deep" as const } } : {}) });
    }
  }
  return { narrowed, unreadable };
}

/** Reads a slice's text next to its manifest. */
export function sliceTextReader(manifestDir: string): (entry: SliceEntry) => string | undefined {
  return (entry) => {
    try {
      return readFileSync(path.resolve(manifestDir, entry.path), "utf8");
    } catch {
      return undefined;
    }
  };
}

/**
 * The package's slice-manifest check: its own manifest (or the copy the ledger left), each slice's text read next to it,
 * in the package's slices/ or in the shared slice directory. `ledger build` runs it on the package beside the input
 * directory's manifest. With `refuseUnreadable` (`review complete`), a slice the manifest lists whose text is gone is
 * refused: its routing cannot be checked, so it is not taken on the manifest's word.
 */
export function packageRoutingRefusal(packageDir: string, projectRoot: string, options: { refuseUnreadable?: boolean } = {}): string | undefined {
  const shared = path.join(projectRoot, ".metaproject", "data", "review", "slices");
  const own = path.join(packageDir, "slices");
  for (const [file, dirs] of [[path.join(own, "manifest.json"), [own]], [path.join(packageDir, "slice-manifest.json"), [own, shared]]] as const) {
    let manifest: Pick<SliceManifest, "slices"> | undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SliceManifest>;
      manifest = Array.isArray(parsed.slices) ? { slices: parsed.slices } : undefined;
    } catch {
      manifest = undefined;
    }
    if (manifest === undefined) continue;
    const readers = dirs.map((dir) => sliceTextReader(dir));
    const { narrowed, unreadable } = narrowedSlices(manifest, (entry) => readers.map((read) => read(entry)).find((text) => text !== undefined), fixContextOf(packageDir));
    const label = path.relative(projectRoot, file) || file;
    const refusal = routingRefusal(label, narrowed);
    if (refusal !== undefined || options.refuseUnreadable !== true || unreadable.length === 0) return refusal;
    return (
      `${label} lists ${unreadable.length} slice(s) whose text is missing (${unreadable.slice(0, 8).join(", ")}${unreadable.length > 8 ? ", …" : ""}), so their routing cannot be checked against their content. ` +
      "Restore the slice files next to the manifest, or re-run `keryx review slice` and the round"
    );
  }
  return undefined;
}

/** The refusal for narrowed slices, or undefined when the manifest routes every slice at least as wide as its content needs. */
export function routingRefusal(manifestLabel: string, narrowed: readonly NarrowedSlice[]): string | undefined {
  if (narrowed.length === 0) return undefined;
  const lines = narrowed.slice(0, 8).map((entry) =>
    `${entry.id}: ${[
      entry.missingRoles.length > 0 ? `roles ${entry.missingRoles.join(", ")} are missing` : undefined,
      entry.depth !== undefined ? `recorded ${entry.depth.recorded}, its content needs deep` : undefined,
    ].filter(Boolean).join("; ")}`,
  );
  return (
    `${manifestLabel} routes ${narrowed.length} slice(s) narrower than their content needs (${lines.join(" | ")}${narrowed.length > 8 ? ` | … and ${narrowed.length - 8} more` : ""}). ` +
    "Routing is recomputed from each slice's text and the manifest may only be wider. Re-run `keryx review slice` to route the slices again, and do not edit roles or depth by hand."
  );
}
