// Flow 242 (forgetting), T9/F9 — the deletion trail's READ side.
//
// `./journal.ts` gave the project a trail with the four properties AC6 asks for
// (separate tree, append-only, unfakeable attribution) and exactly one caller:
// `./service.ts` appends to it. `readDeletionJournal` was exported and, outside
// its own module and tests, called by nothing — no CLI, no agent tool, no MCP
// operation ever opened the file. A record nobody can read is not a trail; it is
// a write-only log that happens to be JSON.
//
// That gap and the blocker filed as T9/F3 are the same missing thing. Measured
// on this repository before this module:
//
//     keryx memory search "charge once"           -> Results: 0
//     keryx memory search "quantum flux capacitor" -> Results: 0
//     keryx gdgraph affected src/billing.ts        -> code: target-not-indexed
//     keryx gdgraph affected src/nonexistent.ts    -> code: target-not-indexed
//     keryx wiki check-links                       -> "(target not found)" for both
//
// In each pair the first item was REMOVED and the second NEVER EXISTED, and
// every surface gave one answer for both. The evidence that separates them was
// already on disk. Nothing read it.
//
// WHAT THIS MODULE REFUSES TO CLAIM
//
// The trail records removals a reconcile OBSERVED. `keryx sync --apply` walks
// the wiki, notices identities the wiki no longer carries, and appends a record.
// An entry deleted with `rm` and never reconciled produces no record at all, and
// neither does any layer the reconcile does not write for. So the absence of a
// record supports exactly one statement — "nothing here records a removal" — and
// NOT the statement a reader wants, which is "this never existed".
//
// Those are different claims and this module keeps them different: the verdict
// is `no-removal-recorded`, never `never-existed`, and every rendering of it
// carries `TRAIL_SCOPE_CAVEAT` plus the measured coverage that bounds it — how
// many records exist, which layers have ever had a removal recorded, and which
// layers every record names as untouched. A caller that reads "no record" also
// reads why that is weaker than it sounds.
//
// The vocabulary is deliberately borrowed, not invented. `src/wiki/section-
// tombstone.ts` already answers `tombstoned` with a `removedAt` and a reason and
// says there is no redirect; `src/harness/tool/metaproject-operations.ts`
// already renders `store-unreadable` / `absent` / `tombstoned` as three visibly
// different answers. `trail-unreadable` is `store-unreadable`'s shape for this
// file; `recorded-removed` is `tombstoned`'s. Nothing here is a second spelling
// of an answer the project already has.

import { getDanglingEdges, namesDeletedFile } from "../gdgraph/dangling";
import type { GraphData } from "../gdgraph/types";
import { readSectionRegistryState } from "../wiki/section-tombstone";
import {
  readDeletionJournal,
  type Attribution,
  type DeletionRecord,
} from "./journal";

/**
 * The one sentence every "no record" answer must carry.
 *
 * Stated once and shared, because the failure mode is a surface that renders the
 * verdict and drops the bound — at which point `no-removal-recorded` reads as
 * "never existed" again and this module has achieved nothing.
 */
export const TRAIL_SCOPE_CAVEAT =
  "This trail records removals a reconcile OBSERVED (`keryx sync --apply` appends to it). Anything deleted " +
  "without one — an `rm` that was never reconciled — leaves no record here. \"No record of a removal\" is " +
  'therefore NOT the claim "this never existed".';

/**
 * The trail as it is on disk, in the three states a reader has to tell apart.
 *
 * `records` is present in every state so a caller can count without branching;
 * it is empty in the two states where a count would be a lie if believed, and
 * those states carry the reason that says so.
 */
export type DeletionTrail =
  | { state: "absent"; path: string; records: readonly DeletionRecord[] }
  | { state: "present"; path: string; records: readonly DeletionRecord[] }
  | { state: "unreadable"; path: string; reason: string; records: readonly DeletionRecord[] };

export async function loadDeletionTrail(cwd: string): Promise<DeletionTrail> {
  const read = await readDeletionJournal(cwd);
  if (read.state === "present") {
    return { state: "present", path: read.path, records: read.records };
  }
  if (read.state === "absent") {
    return { state: "absent", path: read.path, records: [] };
  }
  return { state: "unreadable", path: read.path, reason: read.reason, records: [] };
}

/**
 * What this trail is in a position to answer about, measured from its own
 * contents rather than asserted.
 *
 * `layersWithRemovals` is the honest scope of a positive answer, and
 * `layersRecordedUntouched` is the scope of a negative one: a layer that every
 * record names as untouched is a layer this trail has never recorded a removal
 * for, so "no record" about it carries almost no information. Both are derived,
 * so the day another lane starts recording memory removals here, every "no
 * record" answer about memory gets correspondingly stronger with no edit to this
 * file.
 */
export type TrailCoverage = {
  records: number;
  removalsRecorded: number;
  layersWithRemovals: string[];
  layersRecordedUntouched: string[];
  observedBy: string[];
  earliest: string | null;
  latest: string | null;
};

export function trailCoverage(trail: DeletionTrail): TrailCoverage {
  const withRemovals = new Set<string>();
  const untouched = new Set<string>();
  const observedBy = new Set<string>();
  let removalsRecorded = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const record of trail.records) {
    observedBy.add(record.observedBy);
    for (const item of record.removed ?? []) {
      withRemovals.add(item.layer);
      removalsRecorded += 1;
    }
    for (const layer of record.untouched ?? []) {
      untouched.add(layer.layer);
    }
    if (earliest === null || record.at < earliest) {
      earliest = record.at;
    }
    if (latest === null || record.at > latest) {
      latest = record.at;
    }
  }

  return {
    records: trail.records.length,
    removalsRecorded,
    layersWithRemovals: [...withRemovals].sort(),
    layersRecordedUntouched: [...untouched].sort(),
    observedBy: [...observedBy].sort(),
    earliest,
    latest,
  };
}

/** One recorded removal, flattened with the record it came from. */
export type RemovalOccurrence = {
  at: string;
  observedBy: string;
  outcome: string;
  layer: string;
  ref: string;
  page: string | null;
  title: string | null;
  requestedBy: Attribution;
  grounds: Attribution;
  refusals: readonly string[];
  /** Which field of the record the query matched. Never inferred by the reader. */
  matchedOn: "ref" | "page" | "title";
};

export type RemovalLookup =
  | { verdict: "trail-unreadable"; path: string; reason: string }
  | { verdict: "trail-absent"; path: string; reason: string }
  | {
      verdict: "recorded-removed";
      path: string;
      occurrences: RemovalOccurrence[];
      reason: string;
    }
  | {
      verdict: "no-removal-recorded";
      path: string;
      reason: string;
      coverage: TrailCoverage;
    };

function normalizeCandidate(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

const UNKNOWN_ATTRIBUTION: Attribution = {
  value: null,
  basis: "unknown",
  detail: "this record predates the attribution fields, or carried none.",
};

function occurrence(
  record: DeletionRecord,
  item: { layer: string; ref: string; page: string | null; title: string | null },
  matchedOn: RemovalOccurrence["matchedOn"],
): RemovalOccurrence {
  return {
    at: record.at,
    observedBy: record.observedBy,
    outcome: record.outcome,
    layer: item.layer,
    ref: item.ref,
    page: item.page ?? null,
    title: item.title ?? null,
    requestedBy: record.requestedBy ?? UNKNOWN_ATTRIBUTION,
    grounds: record.grounds ?? UNKNOWN_ATTRIBUTION,
    refusals: record.refusals ?? [],
    matchedOn,
  };
}

function nonMatchLookup(trail: DeletionTrail, layer: string | undefined, what: string): RemovalLookup {
  if (trail.state === "unreadable") {
    return {
      verdict: "trail-unreadable",
      path: trail.path,
      reason:
        `${trail.reason} While it is unreadable, "removed" and "never recorded as removed" cannot be told ` +
        "apart here at all — this is not an empty history.",
    };
  }
  if (trail.state === "absent") {
    return {
      verdict: "trail-absent",
      path: trail.path,
      reason:
        `there is no deletion trail at ${trail.path} — nothing has ever appended to it in this project, so it ` +
        `holds no record of ${what} or of anything else. ${TRAIL_SCOPE_CAVEAT}`,
    };
  }
  const coverage = trailCoverage(trail);
  return {
    verdict: "no-removal-recorded",
    path: trail.path,
    reason: `${describeCoverageAgainst(coverage, layer, what)} ${TRAIL_SCOPE_CAVEAT}`,
    coverage,
  };
}

/**
 * Why this particular "no record" is as weak or as strong as it is.
 *
 * Written from the coverage rather than from a hardcoded belief about which
 * layers the reconcile writes for, because the belief would go stale silently
 * and the measurement cannot.
 */
export function describeCoverageAgainst(
  coverage: TrailCoverage,
  layer: string | undefined,
  what: string,
): string {
  if (coverage.records === 0) {
    return (
      `the deletion trail exists but holds no records at all, so it names no removal of ${what} and no removal ` +
      "of anything else."
    );
  }
  const scope =
    `the deletion trail holds ${coverage.records} record(s) covering ${coverage.removalsRecorded} recorded ` +
    `removal(s)${coverage.earliest !== null ? ` (${coverage.earliest} … ${coverage.latest})` : ""}, and none of ` +
    `them names ${what}.`;
  if (layer === undefined) {
    return scope;
  }
  if (coverage.layersWithRemovals.includes(layer)) {
    return (
      `${scope} This trail HAS recorded removals in the \`${layer}\` layer ` +
      `(${coverage.layersWithRemovals.join(", ")}), so its silence about this one is meaningful — but only as far ` +
      "as the caveat below allows."
    );
  }
  const untouched = coverage.layersRecordedUntouched.includes(layer)
    ? ` Records here instead list \`${layer}\` among the layers the reconcile left UNTOUCHED, with a cause.`
    : "";
  return (
    `${scope} No record in this trail has ever named the \`${layer}\` layer as removed — the layers it does ` +
    `record are [${coverage.layersWithRemovals.join(", ") || "none"}].${untouched} For \`${layer}\`, therefore, ` +
    "this trail cannot tell a removal from something that never existed, and says so rather than answering."
  );
}

/**
 * Exact-identity lookup: does the trail record THIS ref (or page) as removed?
 *
 * No fuzzy fallback and no nearest match, for the reason `resolveSectionIdentity`
 * states about substitution: a lookup that answers with something adjacent is
 * worse than one that answers "no record", because the caller cannot tell which
 * it got. `searchRemovals` below is the separate, explicitly-labelled fuzzy
 * surface for a query that is a phrase rather than an identity.
 */
export function lookupRemoval(
  trail: DeletionTrail,
  query: { candidates: readonly string[]; layer?: string | undefined },
): RemovalLookup {
  const wanted = new Set(query.candidates.map(normalizeCandidate).filter((value) => value.length > 0));
  const what = [...wanted].map((value) => `"${value}"`).join(" or ") || "the requested identity";

  const occurrences: RemovalOccurrence[] = [];
  for (const record of trail.records) {
    for (const item of record.removed ?? []) {
      if (query.layer !== undefined && item.layer !== query.layer) {
        continue;
      }
      if (wanted.has(normalizeCandidate(item.ref))) {
        occurrences.push(occurrence(record, item, "ref"));
        continue;
      }
      if (item.page !== null && item.page !== undefined && wanted.has(normalizeCandidate(item.page))) {
        occurrences.push(occurrence(record, item, "page"));
      }
    }
  }

  if (occurrences.length > 0) {
    return {
      verdict: "recorded-removed",
      path: trail.path,
      occurrences: occurrences.sort((a, b) => a.at.localeCompare(b.at)),
      reason: renderRemovedReason(occurrences, what),
    };
  }
  return nonMatchLookup(trail, query.layer, what);
}

/**
 * Phrase lookup, labelled as one.
 *
 * A memory search query is a phrase, not an identity, so an identity lookup
 * cannot answer it and pretending otherwise would make `memory search` report
 * "no record" for a term that the trail plainly contains. Matching is over the
 * removal's `ref`, `page` and `title`; every hit carries `matchedOn` and its
 * `layer`, so a wiki identity surfaced by a memory query is visibly a wiki
 * identity and not a memory entry.
 */
export function searchRemovals(trail: DeletionTrail, query: string): RemovalLookup {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.#/-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 2);
  const what = `anything matching "${query}"`;
  if (terms.length === 0) {
    return nonMatchLookup(trail, undefined, what);
  }

  const occurrences: RemovalOccurrence[] = [];
  for (const record of trail.records) {
    for (const item of record.removed ?? []) {
      const fields: ReadonlyArray<[RemovalOccurrence["matchedOn"], string | null]> = [
        ["title", item.title ?? null],
        ["ref", item.ref],
        ["page", item.page ?? null],
      ];
      for (const [field, value] of fields) {
        if (value === null) {
          continue;
        }
        const haystack = value.toLowerCase();
        if (terms.some((term) => haystack.includes(term))) {
          occurrences.push(occurrence(record, item, field));
          break;
        }
      }
    }
  }

  if (occurrences.length > 0) {
    return {
      verdict: "recorded-removed",
      path: trail.path,
      occurrences: occurrences.sort((a, b) => a.at.localeCompare(b.at)),
      reason: renderRemovedReason(occurrences, what),
    };
  }
  return nonMatchLookup(trail, undefined, what);
}

function renderRemovedReason(occurrences: readonly RemovalOccurrence[], what: string): string {
  const first = occurrences[0];
  if (first === undefined) {
    return `the deletion trail records ${what} as removed.`;
  }
  return (
    `the deletion trail records ${what} as REMOVED: ${occurrences.length} record(s), the first on ${first.at}, ` +
    `observed by \`${first.observedBy}\`. This is not "never existed".`
  );
}

/** Attribution as one line that never presents a derived value as a stated one. */
export function describeAttribution(label: string, attribution: Attribution): string {
  if (attribution.basis === "unknown" || attribution.value === null) {
    return `${label}: unknown (${attribution.detail})`;
  }
  return `${label}: ${attribution.value} [${attribution.basis}] (${attribution.detail})`;
}

/** One occurrence rendered for a human/model surface. */
export function describeOccurrence(item: RemovalOccurrence): string[] {
  const title = item.title !== null && item.title.length > 0 ? ` "${item.title}"` : "";
  const page = item.page !== null && item.page.length > 0 ? ` in ${item.page}` : "";
  return [
    `  - [${item.layer}] ${item.ref}${title}${page} — removed ${item.at}, outcome ${item.outcome} ` +
      `(matched on ${item.matchedOn}, observed by \`${item.observedBy}\`)`,
    `      ${describeAttribution("requested by", item.requestedBy)}`,
    `      ${describeAttribution("grounds", item.grounds)}`,
    ...item.refusals.map((refusal) => `      refusal: ${refusal}`),
  ];
}

/**
 * The whole lookup as lines, tag first — the shape
 * `formatWikiResolve`/`formatRetrievalOutcome` already use, so a reader never
 * has to guess which part is the machine-readable verdict.
 */
export function describeRemovalLookup(lookup: RemovalLookup): string[] {
  if (lookup.verdict === "recorded-removed") {
    return [
      `[${lookup.verdict}] ${lookup.reason}`,
      ...lookup.occurrences.flatMap((item) => describeOccurrence(item)),
    ];
  }
  return [`[${lookup.verdict}] ${lookup.reason}`];
}

/**
 * A graph target that is not a node, explained from both pieces of evidence on
 * disk.
 *
 * The trail is the authoritative one and it does not cover code files today, so
 * on its own it would answer `no-removal-recorded` for every deleted file and
 * this surface would be no better than before. The second piece is the graph's
 * own unresolved edges: `getDanglingEdges` + `namesDeletedFile`
 * (`../gdgraph/dangling.ts`) find the imports that name this path and land
 * nowhere. That is circumstantial and is labelled as such — something imported
 * this path, which is evidence AGAINST "never existed" and is not by itself
 * proof of a removal (a typo'd import produces the same edge).
 *
 * Ordering is by strength: a recorded removal outranks circumstantial evidence,
 * which outranks "cannot tell", which outranks "no record".
 */
export type GraphAbsence = {
  verdict:
    | "recorded-removed"
    | "referenced-but-unindexed"
    | "trail-unreadable"
    | "trail-absent"
    | "no-removal-recorded";
  reason: string;
  removal: RemovalLookup;
  /** Unresolved in-project imports naming this target. Evidence, never a resolution. */
  referencedBy: Array<{ from: string; specifier: string }>;
};

/**
 * A wiki path that is not on disk, explained from the registry first and the
 * trail second.
 *
 * `keryx wiki check-links` printed `(target not found)` for a tombstoned page
 * and for one that never existed, with the tombstone sitting in
 * `.metaproject/wiki/.sections.json` the whole time. The registry is the direct
 * evidence and is consulted first; the `tombstoned` / `pending-tombstone` /
 * `registry-unreadable` answers are `resolveSectionIdentity`'s own words, not a
 * second vocabulary invented for links.
 *
 * It lives here rather than in `src/commands/wiki.ts` because deciding what a
 * missing target MEANS is owner work, and because a transport reaching into
 * `../wiki/section-tombstone` directly is the facade bypass
 * `src/lib/import-policy.ts` ratchets — measured: writing it in the command
 * first pushed that count from 150 to 151 and the ratchet said so.
 */
export type WikiAbsence = {
  verdict:
    | "tombstoned"
    | "pending-tombstone"
    | "registry-unreadable"
    | "recorded-removed"
    | "trail-unreadable"
    | "trail-absent"
    | "no-removal-recorded";
  reason: string;
};

export async function explainAbsentWikiPage(
  cwd: string,
  wikiRelativePath: string,
  alsoTry: readonly string[] = [],
): Promise<WikiAbsence> {
  const registry = await readSectionRegistryState(cwd);
  if (registry.state === "unreadable") {
    return {
      verdict: "registry-unreadable",
      reason:
        `${registry.reason} With the removal history unreadable, "removed" and "never existed" cannot be ` +
        "separated for this link, so neither is claimed.",
    };
  }
  if (registry.state === "present") {
    const tombstone = registry.registry.tombstones.find(
      (entry) => entry.kind === "page" && entry.page === wikiRelativePath,
    );
    if (tombstone) {
      return {
        verdict: "tombstoned",
        reason:
          `removed ${tombstone.removedAt} — ${tombstone.reason}. There is no redirect; a page with the same ` +
          "title elsewhere is NOT this one.",
      };
    }
    const registered = registry.registry.entries.find(
      (entry) => entry.kind === "page" && entry.page === wikiRelativePath,
    );
    if (registered) {
      return {
        verdict: "pending-tombstone",
        reason:
          `the registry records this page as "${registered.title}" (${registered.ref}) and nothing is at that ` +
          'path now. It was REMOVED and `keryx wiki sections sync` has not run since. This is not "never existed".',
      };
    }
  }

  const lookup = lookupRemoval(await loadDeletionTrail(cwd), {
    candidates: [wikiRelativePath, ...alsoTry],
  });
  if (lookup.verdict === "recorded-removed") {
    const first = lookup.occurrences[0];
    return {
      verdict: "recorded-removed",
      reason: `the deletion trail records this as removed on ${first?.at} (observed by \`${first?.observedBy}\`).`,
    };
  }
  if (lookup.verdict === "trail-unreadable") {
    return { verdict: "trail-unreadable", reason: lookup.reason };
  }
  return {
    verdict: lookup.verdict,
    reason: `neither the section registry nor the deletion trail records this path as removed. ${TRAIL_SCOPE_CAVEAT}`,
  };
}

export function explainAbsentGraphTarget(
  graph: GraphData,
  target: string,
  trail: DeletionTrail,
): GraphAbsence {
  const normalized = normalizeCandidate(target);
  const removal = lookupRemoval(trail, { candidates: [normalized], layer: "graph" });
  const deleted = new Set([normalized]);
  const referencedBy = getDanglingEdges(graph, { scope: "in-project" })
    .filter((edge) => namesDeletedFile(edge, deleted))
    .map((edge) => ({ from: edge.from, specifier: edge.specifier }));

  if (removal.verdict === "recorded-removed") {
    return { verdict: "recorded-removed", reason: removal.reason, removal, referencedBy };
  }
  if (referencedBy.length > 0) {
    const holders = referencedBy.map((edge) => `${edge.from} -> ${edge.specifier}`).join(", ");
    return {
      verdict: "referenced-but-unindexed",
      reason:
        `${referencedBy.length} in-project import(s) still name this path and resolve to nothing (${holders}). ` +
        'Something imported it, so this is evidence AGAINST "never existed" — it is not proof of a removal: a ' +
        "misspelled import produces the same unresolved edge. The deletion trail itself holds no record either " +
        `way (${removal.verdict}); \`keryx forgetting lookup "${normalized}" --layer graph\` prints why that ` +
        "silence is weak.",
      removal,
      referencedBy,
    };
  }
  return { verdict: removal.verdict, reason: removal.reason, removal, referencedBy };
}
