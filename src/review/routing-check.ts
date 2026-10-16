// Security review M3 (flow 457): slice routing is recorded in the slice manifest, which the orchestrating agent can
// edit. `ledger build` and `review complete` route each slice again from its own text and refuse a manifest whose
// recorded roles or depth are narrower than what the content needs (a security or architecture role routed out of a
// code slice, a code slice marked light). Reach and Jev scores only ever make a slice deeper and are not recomputed
// here, so the recomputation is a lower bound: the manifest may be wider, never narrower.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type SliceEntry, type SliceManifest, sliceSourceFromDiff } from "./slice";
import { routeSliceRegions } from "./slice-routing";

export type NarrowedSlice = { id: string; missingRoles: string[]; depth?: { recorded: string; needed: "deep" } };

/** Slices whose recorded routing is narrower than their content needs. `readText` returns undefined when unreadable. */
export function narrowedSlices(manifest: Pick<SliceManifest, "slices">, readText: (entry: SliceEntry) => string | undefined): { narrowed: NarrowedSlice[]; unreadable: string[] } {
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
    const needed = routeSliceRegions(entry.id, sliceSourceFromDiff(text).regions, { changedFiles });
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
 * `review complete`'s check: the package's slice manifest (its own, or the copy the ledger left), each slice's text read
 * next to it, in the package's slices/ or in the shared slice directory. A slice whose text is gone is not judged here:
 * the ledger, which needs the text for its content hash, already checked it.
 */
export function packageRoutingRefusal(packageDir: string, projectRoot: string): string | undefined {
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
    const { narrowed } = narrowedSlices(manifest, (entry) => readers.map((read) => read(entry)).find((text) => text !== undefined));
    return routingRefusal(path.relative(projectRoot, file) || file, narrowed);
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
