// `src/forgetting/service.ts` — the forgetting owner's public facade.
//
// Every other core owner in this tree that a transport calls into publishes one
// (`src/wiki/service.ts`, `src/memory/service.ts`, …), and
// `src/lib/import-policy.ts` encodes the rule: a client or adapter imports a
// core owner only through its `service.ts`. When this directory had no facade,
// `src/commands/sync.ts` had no compliant way to reach it and
// `import-policy.live.test.ts`'s facade-less set grew by one — the guard
// reporting, correctly, that the rule had become unsatisfiable for a directory
// that had just been declared core. This file is the answer to that, not a
// raised ceiling.
//
// It is deliberately NOT re-exported from `src/core.ts`. That entry publishes
// ten owner facades and `src/core-package.test.ts` pins the list exactly;
// widening the published package's surface is a packaging decision belonging to
// that lane, and nothing outside this repository asks for it yet.
//
// What the door exposes is one operation and the types needed to render its
// result. The reconcile decides; the transport prints. That split is what keeps
// "what does the system answer for a reference into deleted knowledge" a
// property of the owner rather than of the CLI that happens to ask.

import { applyIdentityLayer, reportOnlyIdentityOutcome, type IdentityLayerOutcome } from "./identity";
import {
  appendDeletionRecord,
  resolveGrounds,
  resolveRequestedBy,
  type Attribution,
  type JournalAppend,
} from "./journal";
import { reportPropagation, type DeletionWindow, type PropagationReport } from "./propagation";

export type { Attribution, DeletionRecord, JournalAppend, JournalRead } from "./journal";
export type {
  DanglingReference,
  DeletionWindow,
  KnowledgeLayer,
  LayerOutcome,
  PropagationReport,
  RemovalAttribution,
  RemovedIdentity,
} from "./propagation";
export type { IdentityLayerOutcome } from "./identity";
export { deletionJournalPath, readDeletionJournal } from "./journal";
// T9/F9: the trail's READ side, published through the same door the write side
// uses. `readDeletionJournal` was already exported here and still had no caller
// outside this directory — a facade that publishes an operation nothing can act
// on. These are the functions the CLI, `memory search`, `wiki check-links` and
// `gdgraph affected` reach the trail through, so `src/lib/import-policy.ts`'s
// rule (an adapter imports a core owner only via its `service.ts`) stays
// satisfied instead of gaining four new bypasses.
export {
  TRAIL_SCOPE_CAVEAT,
  describeAttribution,
  describeCoverageAgainst,
  describeOccurrence,
  describeRemovalLookup,
  explainAbsentGraphTarget,
  explainAbsentWikiPage,
  loadDeletionTrail,
  lookupRemoval,
  searchRemovals,
  trailCoverage,
} from "./trail";
export type {
  DeletionTrail,
  GraphAbsence,
  RemovalLookup,
  RemovalOccurrence,
  TrailCoverage,
  WikiAbsence,
} from "./trail";

export type ForgettingReconcileInput = {
  cwd: string;
  /** `--apply`. False means: observe and report, write nothing anywhere. */
  apply: boolean;
  /** The run's timestamp, so the tombstone and the journal record agree. */
  at: string;
  /** The command being run, recorded verbatim in the trail. */
  observedBy: string;
  /** `--reason`: the STATED basis. Absent means the journal records a derived one. */
  reason?: string | undefined;
  /** `--actor`: the STATED requester. */
  actor?: string | undefined;
  /** `KERYX_ACTOR`. Also stated — a human set the variable. */
  envActor?: string | undefined;
  /**
   * `git config user.email`, or undefined.
   *
   * Passed in by the caller rather than read here, and never promoted to a
   * stated requester: it answers "whose checkout is this", which is a different
   * question from "who asked for this deletion". See `./journal.ts`.
   */
  gitIdentity?: string | undefined;
  /**
   * The window an unresolved import is judged against, in its three states.
   * `undetermined` is a real answer the caller must be able to give: it used to
   * be an `undefined` no surface ever sent, so "I could not compute the window"
   * arrived here as "I computed it and it was empty".
   */
  deletionWindow: DeletionWindow;
  /**
   * Whether this run rebuilt the code graph. `keryx sync` without `--apply`
   * does not, and the graph then still asserts the deleted knowledge.
   */
  graphRebuilt: boolean;
};

/**
 * What became of the deletion trail for this run — three outcomes, because a
 * missing record has three different meanings and only one of them is a fault.
 *
 * `not-a-write` and `nothing-removed` were the same `null` before, and the
 * second did not exist at all: every `--apply` run appended a record, so a sync
 * that removed nothing wrote a permanent `outcome: "propagated"` entry naming
 * its operator, their stated reason, and every removal the project had ever
 * recorded.
 */
export type ForgettingTrail =
  | { kind: "not-a-write"; cause: string }
  | { kind: "nothing-removed"; cause: string }
  | { kind: "recorded"; append: JournalAppend; requestedBy: Attribution; grounds: Attribution };

export type ForgettingReconcile = {
  identity: IdentityLayerOutcome;
  report: PropagationReport;
  trail: ForgettingTrail;
};

/**
 * Observe what the wiki no longer carries, record it where recording is safe,
 * and report every layer with a cause either way.
 *
 * The order matters and is not incidental: the identity layer is written FIRST,
 * so the propagation report that follows describes the state this run leaves
 * behind rather than the one it found. A report taken before the tombstones
 * were written would list every removed identity as `pending-tombstone` in the
 * same breath as saying the tombstones had been written.
 */
export async function reconcileForgetting(input: ForgettingReconcileInput): Promise<ForgettingReconcile> {
  const identity = input.apply
    ? await applyIdentityLayer(input.cwd, input.reason, input.at)
    : reportOnlyIdentityOutcome();

  const report = await reportPropagation({
    cwd: input.cwd,
    identityLayer: identity.propagated
      ? { propagated: true, tombstonedNow: identity.tombstonedNow }
      : { propagated: false, cause: identity.cause },
    graphLayer: { rebuiltInThisRun: input.graphRebuilt, window: input.deletionWindow },
  });

  if (!input.apply) {
    return {
      identity,
      report,
      trail: {
        kind: "not-a-write",
        cause:
          "this run wrote nothing anywhere, so there is no deletion to record. `keryx sync --apply` writes the " +
          "tombstones and appends the record.",
      },
    };
  }

  // What this run may claim. `report.removed` is every removal on record and
  // saying so is the fix: a run that reads the cumulative set as its own act
  // writes an append-only record attributing its predecessors' deletions to
  // itself, under its own stated reason.
  const removedNow = report.removedInThisRun;
  const observedUnrecorded = report.observedUnrecorded;

  // A run that removed nothing and refused nothing is not a deletion, and
  // journalling it as one is exactly the false record this trail exists to
  // prevent. The absence is announced rather than silent — the caller prints
  // this cause.
  if (removedNow.length === 0 && observedUnrecorded.length === 0 && identity.refusal === null) {
    return {
      identity,
      report,
      trail: {
        kind: "nothing-removed",
        cause:
          "no identity was removed in this run and no layer refused, so no deletion record was appended. " +
          "Removals already on record stay on record; they belong to the runs that made them.",
      },
    };
  }

  const requestedBy = resolveRequestedBy({
    stated: input.actor,
    env: input.envActor,
    gitIdentity: input.gitIdentity,
  });
  const observedCount = removedNow.length > 0 ? removedNow.length : observedUnrecorded.length;
  const grounds = resolveGrounds({
    stated: input.reason,
    observed:
      observedCount > 0
        ? `${observedCount} registered wiki identit${observedCount === 1 ? "y is" : "ies are"} no longer ` +
          `carried by the wiki, observed by \`${input.observedBy}\``
        : undefined,
  });

  const item = (entry: (typeof removedNow)[number]) => ({
    layer: "wiki-identity",
    ref: entry.ref,
    page: entry.page,
    title: entry.title,
  });

  const append = await appendDeletionRecord(input.cwd, {
    at: input.at,
    observedBy: input.observedBy,
    outcome: identity.refusal ? "refused" : identity.propagated ? "propagated" : "reported-only",
    removed: removedNow.map(item),
    observedUnrecorded: observedUnrecorded.map(item),
    untouched: report.layers
      .filter((layer) => !layer.propagated)
      .map((layer) => ({ layer: layer.layer, cause: layer.cause })),
    requestedBy,
    grounds,
    danglingAfter: report.layers.reduce((total, layer) => total + layer.dangling.length, 0),
    refusals: identity.refusal ? [identity.refusal] : [],
  });

  return { identity, report, trail: { kind: "recorded", append, requestedBy, grounds } };
}
