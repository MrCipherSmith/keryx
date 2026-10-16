// Flow 458 (AC3 routing, AC4): a delta round splits its range into FIX slices (they hold a fix hunk, so they answer prior
// findings) and NEW slices (code no prior finding touched). A FIX slice is read by logic, regression and the roles that
// authored the findings it answers; the verifier is the orchestrator's, as in every round. A NEW slice is routed as in
// round 1. Everything here is pure: `review slice` classifies, the ledger/estimate/routing check read the result.

import { parseScopedDiff, type SliceEntry } from "./slice";
import { ALWAYS_ROLE, REGRESSION_ROLE } from "./slice-routing";
import { isPriorDisposition, readPriorFindings, readRoundRecord, type PriorDisposition, type PriorFinding, type RoundRecord } from "./round-record";

/** Roles every fix slice gets; the authors of its findings join them. */
export const FIX_BASE_ROLES: readonly string[] = [ALWAYS_ROLE, REGRESSION_ROLE];

/** The roster of a fix slice: logic, regression and the reviewers that authored `findingIds` (read from the prior findings). */
export function fixRosterRoles(findingIds: readonly string[], prior: readonly PriorFinding[]): string[] {
  const wanted = new Set(findingIds);
  const authors = prior.filter((finding) => wanted.has(finding.id) && finding.reviewer.startsWith("review-")).map((finding) => finding.reviewer);
  return [...new Set([...FIX_BASE_ROLES, ...authors])].sort();
}

/** Only a delta round splits; a first or fallback-first round routes every slice as before. */
export function isDeltaRound(round: RoundRecord | undefined): round is RoundRecord {
  return round !== undefined && round.mode === "delta" && round.range.base !== null && round.range.head !== null;
}

/** Finding ids of the round's fix hunks that a slice's regions overlap (same file, intersecting new-side lines). */
export function fixFindingIdsOf(slice: Pick<SliceEntry, "files"> & { text: string }, round: RoundRecord): string[] {
  const regions = parseScopedDiff(slice.text);
  const ids = new Set<string>();
  for (const hunk of round.fixHunks) {
    if (regions.some((region) => region.path === hunk.file && region.startLine <= hunk.endLine && region.endLine >= hunk.startLine)) for (const id of hunk.findingIds) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Tag the routed slices of a delta round. A slice holding any fix hunk becomes `kind: "fix"` with its `findingIds`, the
 * fix roster and a deep read (audit and escalation marks drop: they belong to light routing); every other slice becomes
 * `kind: "new"` and keeps the routing it was given. Retry pieces are left alone.
 */
export function classifyDeltaSlices<T extends SliceEntry & { text: string }>(slices: readonly T[], round: RoundRecord, prior: readonly PriorFinding[]): T[] {
  return slices.map((slice) => {
    if (slice.retryOf !== undefined) return slice;
    const findingIds = fixFindingIdsOf(slice, round);
    if (findingIds.length === 0) return { ...slice, kind: "new" as const };
    const { audit: _audit, escalated: _escalated, ...rest } = slice;
    return {
      ...(rest as T),
      kind: "fix" as const,
      findingIds,
      roles: fixRosterRoles(findingIds, prior),
      depth: "deep" as const,
      risk: { score: Math.max(slice.risk?.score ?? 0, 0.5), why: [...(slice.risk?.why ?? []).filter((why) => !why.startsWith("audit sample")), `fix slice: answers ${findingIds.length} prior finding(s) ${findingIds.slice(0, 4).join(", ")}${findingIds.length > 4 ? ", …" : ""}`] },
    };
  });
}

/** Facts a routing check needs to honour a fix slice: the round and the prior findings it was cut from. */
export type FixContext = { round: RoundRecord | undefined; prior: readonly PriorFinding[] };

export function fixContextOf(packageDir: string): FixContext {
  return { round: readRoundRecord(packageDir), prior: readPriorFindings(packageDir) };
}

/**
 * Whether the round backs a manifest entry's claim to be a fix slice: a delta round, whose fix hunks name every finding
 * the entry lists and sit in one of its files. A slice that only says `fix` is routed as a new slice, so tagging a slice
 * `fix` cannot narrow its roster.
 */
export function fixClaimBacked(entry: Pick<SliceEntry, "kind" | "findingIds" | "files">, context: FixContext | undefined): boolean {
  if (entry.kind !== "fix" || context === undefined || !isDeltaRound(context.round)) return false;
  const ids = entry.findingIds ?? [];
  if (ids.length === 0) return false;
  const hunks = context.round.fixHunks;
  return ids.every((id) => hunks.some((hunk) => hunk.findingIds.includes(id) && entry.files.includes(hunk.file)));
}

/** The roster a fix slice must at least have, from the same function `review slice` routes with. */
export function expectedFixRoles(entry: Pick<SliceEntry, "findingIds">, context: FixContext): string[] {
  return fixRosterRoles(entry.findingIds ?? [], context.prior);
}

/** Roles that own at least one original fix slice of the manifest (they join the round's required set). */
export function fixSliceRoles(manifest: { slices: readonly SliceEntry[] }): string[] {
  return [...new Set(manifest.slices.filter((slice) => slice.retryOf === undefined && slice.kind === "fix").flatMap((slice) => slice.roles ?? []))].sort();
}

export type SplitCounts = { fix: number; new: number };

export function splitCounts(manifest: { slices: readonly SliceEntry[] }): SplitCounts | undefined {
  const originals = manifest.slices.filter((slice) => slice.retryOf === undefined);
  if (!originals.some((slice) => slice.kind !== undefined)) return undefined;
  return { fix: originals.filter((slice) => slice.kind === "fix").length, new: originals.filter((slice) => slice.kind !== "fix").length };
}

/** The dispositions a reviewer result gives to prior findings: `prior_dispositions: [{ id, disposition }]`, unknown words dropped. */
export function priorDispositionsOf(result: { prior_dispositions?: unknown } | undefined): Map<string, PriorDisposition> {
  const out = new Map<string, PriorDisposition>();
  const list = result?.prior_dispositions;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as { id?: unknown; finding?: unknown; disposition?: unknown; status?: unknown };
    const id = typeof item.id === "string" ? item.id : typeof item.finding === "string" ? item.finding : undefined;
    const disposition = item.disposition ?? item.status;
    if (id !== undefined && isPriorDisposition(disposition)) out.set(id, disposition);
  }
  return out;
}

/**
 * Fix slices that count covered because every finding attached to them has a disposition (a reviewer's `prior_dispositions`
 * or a carried finding's recorded one). A fix slice with no attached finding never counts: nothing says what it answered.
 */
export function fixSlicesCoveredByDispositions(manifest: { slices: readonly SliceEntry[] }, dispositioned: ReadonlySet<string>): string[] {
  return manifest.slices
    .filter((slice) => slice.retryOf === undefined && slice.kind === "fix" && (slice.findingIds ?? []).length > 0 && (slice.findingIds ?? []).every((id) => dispositioned.has(id)))
    .map((slice) => slice.id);
}
