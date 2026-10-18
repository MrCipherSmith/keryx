// Flow 458 (AC3 routing, AC4): a delta round splits its range into FIX slices (they hold only fix hunks, so they answer
// prior findings) and NEW slices (code no prior finding touched). A FIX slice is read by exactly the fix roster: logic,
// regression and the roles that authored the findings it answers (plus the code-level security reviewer when one of them
// is a security finding); the verifier is the orchestrator's, as in every round. A NEW slice is routed as in round 1.
//
// Flow 460 L6: the split is by changed line, not by slice. A hunk is FIX when it overlaps an attached prior finding's
// located lines (± `FIX_TOLERANCE`, prior-round.ts) or a commit names the finding; every other change of the same file is
// NEW. `partitionRegionsByFix` cuts the scoped regions apart before slicing, so a fix slice never carries new code: the
// 458 union with the slice's whole round-1 routing (the deep roster of every role a path gate allows) is not owed it.
// The other 458 reason (M3) still holds and is kept: a fix whose own changed lines hit a content rule — process spawning,
// git, input-derived paths, auth, exports, … (`contentRolesOf`, the rules that pick review-security-code and the other
// content reviewers) — gets those reviewers too, and the routing check holds a fix slice to that union.
// Everything here is pure: `review slice` classifies, the ledger/estimate/routing check read the result.

import type { ScopedRegion } from "./scope";
import { parseScopedDiff, type SliceEntry } from "./slice";
import { ALWAYS_ROLE, REGRESSION_ROLE, collapseOverlapGroups, contentRolesOf } from "./slice-routing";
import { isPriorDisposition, readPriorFindings, readRoundRecord, type FixHunk, type PriorDisposition, type PriorFinding, type RoundHunk, type RoundRecord } from "./round-record";

/** Roles every fix slice gets; the authors of its findings join them. */
export const FIX_BASE_ROLES: readonly string[] = [ALWAYS_ROLE, REGRESSION_ROLE];
/** The code-level security reviewer: joins a fix slice whose attached findings include a security one, and reads every second-look slice. */
export const FIX_SECURITY_ROLE = "review-security-code";

/**
 * Words of a problem statement that name a security class. Each entry matters: a stem (`secur\w*`) is never listed next
 * to a literal it already matches.
 */
const SECURITY_PROBLEM = new RegExp(
  String.raw`\b(` +
    [
      String.raw`secur\w*`, String.raw`inject\w*`, String.raw`travers\w*`, String.raw`secrets?`, String.raw`credentials?`, String.raw`passwords?`,
      String.raw`(token|secret|credential|key|data|information|path) leak\w*`, "xss", "csrf", "ssrf", "rce", String.raw`privilege\w*`, String.raw`auth(entication|orization)?`, String.raw`sandbox\w*`,
      String.raw`untrusted`, String.raw`unsaniti[sz]ed`, String.raw`unescaped`, String.raw`shell (string|command|escap\w*|quot\w*|metachar\w*)`, String.raw`sh -c`, String.raw`command line`, String.raw`exec(Sync|File\w*)?`,
      String.raw`spawn(Sync|s|ed|ing)?`, "argv", String.raw`path escape\w*`, String.raw`escapes? the (root|package|project|repository|sandbox)`, String.raw`symlink\w*`,
      "toctou", String.raw`denial of service`, "dos", "redos", String.raw`prototype pollution`, String.raw`sql`, String.raw`deserializ\w*`,
    ].join("|") +
    String.raw`)\b`,
  "i",
);

/** A prior finding about security: from a security reviewer, a `SEC` id, or a problem that names a security class. */
export function isSecurityFinding(finding: Pick<PriorFinding, "id" | "reviewer" | "problem">): boolean {
  return finding.reviewer.startsWith("review-security") || /(^|[:/])SEC[-_\w]*$/i.test(finding.id) || SECURITY_PROBLEM.test(finding.problem);
}

/**
 * The finding-driven part of a fix slice's roster: logic, regression, the reviewers that authored `findingIds` (read from
 * the prior findings), and the code-level security reviewer when one of them is a security finding. A fix slice's full
 * roster adds what its own changed lines route ({@link fixSliceRoster}).
 */
export function fixRosterRoles(findingIds: readonly string[], prior: readonly PriorFinding[]): string[] {
  const wanted = new Set(findingIds);
  const attached = prior.filter((finding) => wanted.has(finding.id));
  const authors = attached.filter((finding) => finding.reviewer.startsWith("review-")).map((finding) => finding.reviewer);
  const security = attached.some(isSecurityFinding) ? [FIX_SECURITY_ROLE] : [];
  return [...new Set([...FIX_BASE_ROLES, ...authors, ...security])].sort();
}

/**
 * The content roles of a slice's own changed lines (flow 458 M3): every content/path rule of slice routing that its
 * regions hit — a fix that spawns a process, builds a git argv or touches an auth path brings review-security-code — and
 * not the deep roster a round-1 slice of the same files would get. Overlap groups collapse as in routing.
 */
export function fixContentRoles(text: string): string[] {
  const roles = new Set<string>();
  for (const region of parseScopedDiff(text)) for (const hit of contentRolesOf(region)) roles.add(hit.role);
  return collapseOverlapGroups(roles).sort();
}

/** A fix slice's roster: the finding-driven roster ({@link fixRosterRoles}) united with its own content roles ({@link fixContentRoles}). */
export function fixSliceRoster(findingIds: readonly string[], prior: readonly PriorFinding[], text: string): string[] {
  return [...new Set([...fixRosterRoles(findingIds, prior), ...fixContentRoles(text)])].sort();
}

/** Whether a changed line sits in a hunk: an added line at its new-side number, a removed one between `line - 1` and `line`. */
function lineInHunk(hunk: RoundHunk, file: string, line: number, removed: boolean): boolean {
  if (hunk.file !== file) return false;
  const within = (at: number): boolean => at >= hunk.startLine && at <= hunk.endLine;
  return within(line) || (removed && within(line - 1));
}

type WalkedLine = { raw: string; line: number; changed: boolean; removed: boolean };

/** A region's lines with their new-side numbers (a removed line carries the number of the next new-side line). */
function walkRegion(region: Pick<ScopedRegion, "startLine" | "text">): WalkedLine[] {
  let line = region.startLine;
  return region.text.split("\n").map((raw) => {
    const removed = raw.startsWith("-");
    const changed = removed || raw.startsWith("+");
    const walked = { raw, line, changed, removed };
    if (!removed && !raw.startsWith("\\")) line += 1;
    return walked;
  });
}

/**
 * Whether a slice text has at least one changed line and every one of them passes `inHunk` (given the region's path and
 * the walked line). The one walker both claim checks use, so fix and second-look lines are numbered the same way.
 */
function everyChangedLine(text: string, inHunk: (path: string, walked: WalkedLine) => boolean): boolean {
  let changed = 0;
  for (const region of parseScopedDiff(text)) {
    for (const walked of walkRegion(region)) {
      if (!walked.changed) continue;
      changed += 1;
      if (!inHunk(region.path, walked)) return false;
    }
  }
  return changed > 0;
}

/** The fix hunks a region's changed lines fall in. */
function fixHunksOfRegion(region: Pick<ScopedRegion, "path" | "startLine" | "text">, hunks: readonly FixHunk[]): FixHunk[] {
  const hit = new Set<FixHunk>();
  for (const walked of walkRegion(region)) {
    if (!walked.changed) continue;
    for (const hunk of hunks) if (lineInHunk(hunk, region.path, walked.line, walked.removed)) hit.add(hunk);
  }
  return [...hit];
}

/**
 * Label every line of a region fix (true) or other (false): a changed line by its kind, a context line by the nearest
 * change, the context between a fix change and a new one shared half and half. Two linear passes (nearest change before,
 * nearest after), so a large mixed region costs O(lines), not O(lines x changes).
 */
function labelLines(kinds: ReadonlyArray<boolean | undefined>): boolean[] {
  const before: number[] = new Array(kinds.length);
  const after: number[] = new Array(kinds.length);
  let last = -1;
  for (let index = 0; index < kinds.length; index += 1) {
    if (kinds[index] !== undefined) last = index;
    before[index] = last;
  }
  last = -1;
  for (let index = kinds.length - 1; index >= 0; index -= 1) {
    if (kinds[index] !== undefined) last = index;
    after[index] = last;
  }
  return kinds.map((kind, index) => {
    if (kind !== undefined) return kind;
    const prev = before[index]!;
    const next = after[index]!;
    if (prev === -1) return kinds[next]!;
    if (next === -1 || kinds[prev] === kinds[next]) return kinds[prev]!;
    return index - prev <= Math.ceil((next - prev - 1) / 2) ? kinds[prev]! : kinds[next]!;
  });
}

/**
 * Cut a walked region into runs of one label. A piece next to another piece lost the context lines its neighbour kept,
 * so it says `contextTruncated`; the region's own flag carries over to every piece.
 */
function cutPieces(region: ScopedRegion, lines: readonly WalkedLine[], labels: readonly boolean[]): Array<{ on: boolean; region: ScopedRegion }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 1; index <= lines.length; index += 1) {
    if (index < lines.length && labels[index] === labels[start]) continue;
    runs.push({ start, end: index });
    start = index;
  }
  return runs.map(({ start: from, end }) => {
    const piece = lines.slice(from, end);
    const kept = piece.filter((walked) => !walked.removed);
    const startLine = piece[0]!.line;
    return {
      on: labels[from]!,
      region: {
        path: region.path,
        startLine,
        endLine: Math.max(startLine, kept.at(-1)?.line ?? startLine),
        changedLines: piece.filter((walked) => walked.changed).length,
        contextTruncated: region.contextTruncated || runs.length > 1,
        text: piece.map((walked) => walked.raw).join("\n"),
      },
    };
  });
}

/**
 * Cut scoped regions into the lines that answer prior findings and the rest (flow 460 L6). A changed line is FIX when it
 * lies in one of the round's fix hunks; a region holding both kinds is split between them ({@link labelLines},
 * {@link cutPieces}), so each piece is still a readable window. A fix slice built from the `fix` regions therefore
 * carries no new code, and the new code is routed as in round 1.
 */
export function partitionRegionsByFix(regions: readonly ScopedRegion[], hunks: readonly FixHunk[]): { fix: ScopedRegion[]; other: ScopedRegion[] } {
  const { on: fix, off: other } = splitRegions(regions, (file, walked) => hunks.some((hunk) => lineInHunk(hunk, file, walked.line, walked.removed)));
  return { fix, other };
}

/**
 * Split regions by a changed-line predicate: a region whose changed lines all pass goes to `on`, one with none to `off`,
 * and a mixed one is cut between them ({@link labelLines}, {@link cutPieces}). Region order is kept within each side.
 */
function splitRegions(regions: readonly ScopedRegion[], isOn: (file: string, walked: WalkedLine) => boolean): { on: ScopedRegion[]; off: ScopedRegion[] } {
  const on: ScopedRegion[] = [];
  const off: ScopedRegion[] = [];
  for (const region of regions) {
    const lines = walkRegion(region);
    const kinds = lines.map((walked) => (walked.changed ? isOn(region.path, walked) : undefined));
    const changedKinds = kinds.filter((kind): kind is boolean => kind !== undefined);
    if (!changedKinds.some(Boolean)) off.push(region);
    else if (changedKinds.every(Boolean)) on.push(region);
    else for (const piece of cutPieces(region, lines, labelLines(kinds))) (piece.on ? on : off).push(piece.region);
  }
  return { on, off };
}

/** The roles that read a second-look slice, once: logic and the code-level security reviewer. */
export const SECOND_LOOK_ROLES: readonly string[] = [ALWAYS_ROLE, FIX_SECURITY_ROLE];

/** Whether a region of the full range overlaps one of the second-look hunks (same file, intersecting new-side lines). */
export function regionInSecondLook(region: { path: string; startLine: number; endLine: number }, hunks: readonly { file: string; startLine: number; endLine: number }[]): boolean {
  return hunks.some((hunk) => hunk.file === region.path && region.startLine <= hunk.endLine && region.endLine >= hunk.startLine);
}

/**
 * Whether a changed line lies in a second-look hunk: same file, its new-side number inside the hunk. Unlike a fix line, a
 * removed line gets no `line - 1` tolerance: the second-look hunks are head-side ranges of unchanged code, and a removal
 * just past one is not in it. The one predicate `review slice` cuts second-look slices by and the routing check
 * ({@link secondLookClaimBacked}) judges them by, so the two agree by construction (flow 460).
 */
function inSecondLookHunk(hunks: readonly RoundHunk[], file: string, walked: WalkedLine): boolean {
  return hunks.some((hunk) => hunk.file === file && walked.line >= hunk.startLine && walked.line <= hunk.endLine);
}

/**
 * Cut the merge-base..head regions that touch a second-look hunk (flow 460): `secondLook` holds exactly the changed lines
 * inside the hunks ({@link inSecondLookHunk}), cut as {@link partitionRegionsByFix} cuts fix lines, so every second-look
 * slice built from it passes {@link secondLookClaimBacked}. Every other changed line goes to `outside`, to be routed as a
 * new slice — except an added line inside one of the round's fix or new hunks (`deltaHunks`): that line is in the delta
 * range, which the round's own fix/new cut already slices, so it is not read twice. A removed line outside the hunks (a
 * pure deletion the previous round read, or the merge-base side of a line the delta changed again) stays in `outside`.
 */
export function partitionRegionsBySecondLook(regions: readonly ScopedRegion[], secondLook: readonly RoundHunk[], deltaHunks: readonly RoundHunk[]): { secondLook: ScopedRegion[]; outside: ScopedRegion[] } {
  const touching = regions.filter((region) => regionInSecondLook(region, secondLook));
  const { on, off } = splitRegions(touching, (file, walked) => inSecondLookHunk(secondLook, file, walked));
  const inDelta = (file: string, walked: WalkedLine): boolean => !walked.removed && deltaHunks.some((hunk) => hunk.file === file && walked.line >= hunk.startLine && walked.line <= hunk.endLine);
  return { secondLook: on, outside: splitRegions(off, inDelta).off };
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

/** Finding ids of the round's fix hunks that a slice's changed lines fall in (same file, new-side lines). */
export function fixFindingIdsOf(slice: { text: string }, round: Pick<RoundRecord, "fixHunks">): string[] {
  const ids = new Set<string>();
  for (const region of parseScopedDiff(slice.text)) for (const hunk of fixHunksOfRegion(region, round.fixHunks)) for (const id of hunk.findingIds) ids.add(id);
  return [...ids].sort();
}

/** Whether every changed line of a slice lies in one of the round's fix hunks (and it has at least one). */
export function onlyFixLines(text: string, round: Pick<RoundRecord, "fixHunks">): boolean {
  return everyChangedLine(text, (file, walked) => round.fixHunks.some((hunk) => lineInHunk(hunk, file, walked.line, walked.removed)));
}

/**
 * Tag the routed slices of a delta round. A slice whose changed lines all lie in fix hunks (what `review slice` cuts
 * from {@link partitionRegionsByFix}'s `fix` regions) becomes `kind: "fix"` with its `findingIds`, a deep read (audit and
 * escalation marks drop: they belong to light routing) and the fix slice roster ({@link fixSliceRoster}: the fix roster
 * plus the content roles of its own lines). Every other slice becomes
 * `kind: "new"` and keeps its round-1 routing — including one that mixes fix and new lines (a cut that was not
 * partitioned first): its new lines are owed round-1 roles, and its findings stay open for the next round rather than
 * being answered by a narrower roster. Retry pieces are left alone.
 */
export function classifyDeltaSlices<T extends SliceEntry & { text: string }>(slices: readonly T[], round: RoundRecord, prior: readonly PriorFinding[]): T[] {
  return slices.map((slice) => {
    if (slice.retryOf !== undefined) return slice;
    const findingIds = fixFindingIdsOf(slice, round);
    if (findingIds.length === 0 || !onlyFixLines(slice.text, round)) return { ...slice, kind: "new" as const };
    const { audit: _audit, escalated: _escalated, ...rest } = slice;
    return {
      ...(rest as T),
      kind: "fix" as const,
      findingIds,
      roles: fixSliceRoster(findingIds, prior, slice.text),
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
 * the entry lists and sit in one of its files, and — by the slice's own text, since a fix slice gets the fix roster rather
 * than the deep round-1 one — every changed line of the slice lies in a fix hunk. A slice that only says `fix`, or that
 * carries a new line, is routed as a new slice, so tagging a slice `fix` cannot narrow its roster.
 */
export function fixClaimBacked(entry: Pick<SliceEntry, "kind" | "findingIds" | "files">, context: FixContext | undefined, text: string): boolean {
  if (entry.kind !== "fix" || context === undefined || !isDeltaRound(context.round)) return false;
  const ids = entry.findingIds ?? [];
  if (ids.length === 0) return false;
  const hunks = context.round.fixHunks;
  if (!ids.every((id) => hunks.some((hunk) => hunk.findingIds.includes(id) && entry.files.includes(hunk.file)))) return false;
  return onlyFixLines(text, context.round);
}

/**
 * The roster a fix slice must at least have, from the same function `review slice` routes with ({@link fixSliceRoster}):
 * over the findings it lists AND those of the fix hunks its text touches (so dropping an id from the manifest cannot
 * drop that id's author), plus the content roles of its text (so a fix that spawns a process keeps the security reviewer).
 */
export function expectedFixRoles(entry: Pick<SliceEntry, "findingIds">, context: FixContext, text: string): string[] {
  const touched = context.round === undefined ? [] : fixFindingIdsOf({ text }, context.round);
  return fixSliceRoster([...new Set([...(entry.findingIds ?? []), ...touched])], context.prior, text);
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
  // lines elsewhere is judged as new. The predicate is the one `review slice` cuts by (partitionRegionsBySecondLook).
  return everyChangedLine(text, (file, walked) => inSecondLookHunk(hunks, file, walked));
}

/** Roles that own at least one original fix or second-look slice of the manifest (they join the round's required set). */
export function fixSliceRoles(manifest: { slices: readonly SliceEntry[] }): string[] {
  return [...new Set(manifest.slices.filter((slice) => slice.retryOf === undefined && (slice.kind === "fix" || slice.kind === "second-look")).flatMap((slice) => slice.roles ?? []))].sort();
}

/**
 * Roles slice routing gives a slice that the round runs whatever its depth: review-security-code, routed by content to
 * process, argv, git, input-derived path, env or network code. A light round's required set is path-only (coverage.ts),
 * so without this a small diff that spawns a process would be routed to the security reviewer and never dispatched to it
 * (review SEC-R3-001).
 */
export const ALWAYS_DISPATCHED_ROUTED_ROLES: ReadonlySet<string> = new Set(["review-security-code"]);

/**
 * The roles a slice manifest adds to the round's required set: the roles of its fix and second-look slices
 * ({@link fixSliceRoles}), and each {@link ALWAYS_DISPATCHED_ROUTED_ROLES} role that slice routing gave any original
 * slice. The one roster extension the estimate (plan.json), the drivers, `review required` and `ledger build` share.
 */
export function manifestRosterRoles(manifest: { slices: readonly SliceEntry[] }): string[] {
  const routed = manifest.slices.filter((slice) => slice.retryOf === undefined).flatMap((slice) => (slice.roles ?? []).filter((role) => ALWAYS_DISPATCHED_ROUTED_ROLES.has(role)));
  return [...new Set([...fixSliceRoles(manifest), ...routed])].sort();
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
