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
import { reportPropagation, type PropagationReport } from "./propagation";

export type { Attribution, DeletionRecord, JournalAppend, JournalRead } from "./journal";
export type {
  DanglingReference,
  KnowledgeLayer,
  LayerOutcome,
  PropagationReport,
  RemovedIdentity,
} from "./propagation";
export type { IdentityLayerOutcome } from "./identity";
export { deletionJournalPath, readDeletionJournal } from "./journal";

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
   * Code files git shows deleted since the graph was built — the window an
   * unresolved import is judged against. An empty window attributes nothing.
   */
  deletedFiles: ReadonlyArray<string>;
};

export type ForgettingTrail = {
  append: JournalAppend;
  requestedBy: Attribution;
  grounds: Attribution;
};

export type ForgettingReconcile = {
  identity: IdentityLayerOutcome;
  report: PropagationReport;
  /**
   * Null exactly when the run did not write — a report-only run journals
   * nothing because nothing happened, which is different from a write whose
   * record failed to land (`append.status === "failed"`).
   */
  trail: ForgettingTrail | null;
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
    identityLayer: identity.propagated ? { propagated: true } : { propagated: false, cause: identity.cause },
    deletedFiles: input.deletedFiles,
  });

  if (!input.apply) {
    return { identity, report, trail: null };
  }

  const requestedBy = resolveRequestedBy({
    stated: input.actor,
    env: input.envActor,
    gitIdentity: input.gitIdentity,
  });
  const grounds = resolveGrounds({
    stated: input.reason,
    observed:
      report.removed.length > 0
        ? `${report.removed.length} registered wiki identit${
            report.removed.length === 1 ? "y is" : "ies are"
          } no longer carried by the wiki, observed by \`${input.observedBy}\``
        : undefined,
  });

  const append = await appendDeletionRecord(input.cwd, {
    at: input.at,
    observedBy: input.observedBy,
    outcome: identity.refusal ? "refused" : identity.propagated ? "propagated" : "reported-only",
    removed: report.removed.map((entry) => ({
      layer: "wiki-identity",
      ref: entry.ref,
      page: entry.page,
      title: entry.title,
    })),
    untouched: report.layers
      .filter((layer) => !layer.propagated)
      .map((layer) => ({ layer: layer.layer, cause: layer.cause })),
    requestedBy,
    grounds,
    danglingAfter: report.layers.reduce((total, layer) => total + layer.dangling.length, 0),
    refusals: identity.refusal ? [identity.refusal] : [],
  });

  return { identity, report, trail: { append, requestedBy, grounds } };
}
