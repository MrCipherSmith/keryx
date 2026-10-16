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

/** The roles that read a second-look slice, once: logic and the code-level security reviewer. */
export const SECOND_LOOK_ROLES: readonly string[] = [ALWAYS_ROLE, "review-security-code"];

/** Whether a region of the full range overlaps one of the second-look hunks (same file, intersecting new-side lines). */
export function regionInSecondLook(region: { path: string; startLine: number; endLine: number }, hunks: readonly { file: string; startLine: number; endLine: number }[]): boolean {
  return hunks.some((hunk) => hunk.file === region.path && region.startLine <= hunk.endLine && region.endLine >= hunk.startLine);
}

/**
 * Tag slices cut from the second-look regions: `kind: "second-look"`, read once by logic and security-code, deep. Audit and
 * escalation marks drop (they belong to light routing); findings from these slices are ordinary findings.
 */
export function tagSecondLookSlices<T extends SliceEntry & { text: string }>(slices: readonly T[], previousRound: number): T[] {
  return slices.map((slice) => {
    const { audit: _audit, escalated: _escalated, ...rest } = slice;
    return {
      ...(rest as T),
      kind: "second-look" as const,
      roles: [...SECOND_LOOK_ROLES].sort(),
      depth: "deep" as const,
      risk: { score: slice.risk?.score ?? 0.3, why: [...(slice.risk?.why ?? []).filter((why) => !why.startsWith("audit sample")), `second look: unchanged since round ${previousRound}, which may have missed something in it`] },
    };
  });
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
 * Tag the routed slices of a delta round. A slice holding any fix hunk becomes `kind: "fix"` with its `findingIds`, a
 * deep read (audit and escalation marks drop: they belong to light routing) and a roster that is the fix roster PLUS the
 * routing its own content gets as a round-1 slice (M2/M3): a fix slice may hold new lines too, and a fix touching
 * process spawning still gets the security reviewer. Every other slice becomes `kind: "new"` and keeps the routing it
 * was given. Retry pieces are left alone.
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
      roles: [...new Set([...fixRosterRoles(findingIds, prior), ...(slice.roles ?? [])])].sort(),
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

/**
 * Whether the round backs a manifest entry's claim to be a second-look slice: a delta round that recorded second-look
 * hunks in one of its files. A slice that only says `second-look` is routed as a new slice, so the tag cannot narrow its roster.
 */
export function secondLookClaimBacked(entry: Pick<SliceEntry, "kind" | "files">, context: FixContext | undefined, text: string): boolean {
  if (entry.kind !== "second-look" || context === undefined || !isDeltaRound(context.round)) return false;
  const hunks = context.round.secondLookHunks ?? [];
  if (hunks.length === 0) return false;
  // By the slice's own text, not its file list: every changed line must lie in a second-look hunk (and so in no fix or new
  // hunk, which the round keeps disjoint from them). A new slice tagged second-look in a file that merely has unchanged
  // lines elsewhere is judged as new.
  let changed = 0;
  for (const region of parseScopedDiff(text)) {
    let line = region.startLine;
    for (const entryLine of region.text.split("\n")) {
      if (entryLine.startsWith("+") || entryLine.startsWith("-")) {
        changed += 1;
        if (!hunks.some((hunk) => hunk.file === region.path && line >= hunk.startLine && line <= hunk.endLine)) return false;
      }
      if (!entryLine.startsWith("-")) line += 1;
    }
  }
  return changed > 0;
}

/** Roles that own at least one original fix or second-look slice of the manifest (they join the round's required set). */
export function fixSliceRoles(manifest: { slices: readonly SliceEntry[] }): string[] {
  return [...new Set(manifest.slices.filter((slice) => slice.retryOf === undefined && (slice.kind === "fix" || slice.kind === "second-look")).flatMap((slice) => slice.roles ?? []))].sort();
}

export type SplitCounts = { fix: number; new: number; secondLook?: number };

export function splitCounts(manifest: { slices: readonly SliceEntry[] }): SplitCounts | undefined {
  const originals = manifest.slices.filter((slice) => slice.retryOf === undefined);
  if (!originals.some((slice) => slice.kind !== undefined)) return undefined;
  const secondLook = originals.filter((slice) => slice.kind === "second-look").length;
  return {
    fix: originals.filter((slice) => slice.kind === "fix").length,
    new: originals.filter((slice) => slice.kind !== "fix" && slice.kind !== "second-look").length,
    ...(secondLook === 0 ? {} : { secondLook }),
  };
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
 * Which fix slices are covered (M4). A fix slice is covered only when every reviewer on its roster read it (`readBy`: the
 * slices each finished run accounted for) — a reviewer the operator confirmed skipping excepted — and every finding
 * attached to it has a disposition from a reviewer ON THAT ROSTER (`dispositionsBy`: reviewer → finding id →
 * disposition, from finished results of this scope only). Another reviewer's word, or a carried record, covers nothing:
 * a fix slice with no attached finding never counts, since nothing says what it answered.
 */
export function fixSliceCoverage(
  manifest: { slices: readonly SliceEntry[] },
  readBy: ReadonlyMap<string, ReadonlySet<string>>,
  dispositionsBy: ReadonlyMap<string, ReadonlyMap<string, string>>,
  skipped: ReadonlySet<string> = new Set(),
): { covered: string[]; gaps: Array<{ detail: string; next: string }> } {
  const covered: string[] = [];
  const gaps: Array<{ detail: string; next: string }> = [];
  for (const slice of manifest.slices) {
    if (slice.retryOf !== undefined || slice.kind !== "fix") continue;
    const roster = (slice.roles ?? []).filter((role) => !skipped.has(role));
    const ids = slice.findingIds ?? [];
    const unread = roster.filter((role) => readBy.get(role)?.has(slice.id) !== true);
    const undisposed = ids.filter((id) => !roster.some((role) => dispositionsBy.get(role)?.has(id) === true));
    if (ids.length > 0 && unread.length === 0 && undisposed.length === 0) {
      covered.push(slice.id);
      continue;
    }
    const why = [
      ids.length === 0 ? "it names no prior finding" : undefined,
      unread.length > 0 ? `not read by ${unread.join(", ")}` : undefined,
      undisposed.length > 0 ? `no disposition from its roster for ${undisposed.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    gaps.push({
      detail: `fix slice ${slice.id}: ${why}`,
      next: `dispatch ${unread.length > 0 ? unread.join(", ") : "a reviewer of its roster"} on ${slice.id} with the prior findings attached, and have it return prior_dispositions for ${ids.join(", ") || "them"}`,
    });
  }
  return { covered, gaps };
}
