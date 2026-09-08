// Flow 242 (forgetting), lane E — AC1: "Удаление знания, существующего в
// нескольких слоях … либо распространяется на все связанные слои, либо
// возвращает перечень того, чего не тронуло, с причиной по каждому … висячая
// ссылка после удаления не допускается ни в одном."
//
// ---------------------------------------------------------------------------
// THE DESIGN DECISION: REPORT, NOT CASCADE, NOT REFUSE.
//
// The criterion offers two shapes and the description implies a third. All
// three were considered against what this codebase actually is.
//
// CASCADE — deleting in one layer deletes in the others — is rejected. Three
// reasons, in order of weight:
//
//   1. It multiplies a mistake. Keryx has no undo. A wiki page deleted by an
//      autonomous agent that also deletes the memory entry, the SAC evidence
//      and the graph node destroys four human-authored artifacts on one machine
//      inference. The whole programme this flow belongs to is about failures
//      rendered indistinguishable from successes; a cascade makes the blast
//      radius of exactly that class four times larger.
//   2. The layers are not peers. A wiki page and a memory entry are AUTHORED;
//      a graph node and a freshness cache are DERIVED. Deleting a derived
//      artifact is a rebuild. Deleting an authored one is a loss. A single
//      "propagate" verb over both is a category error, and the category error
//      is what would delete the wrong one.
//   3. A reference is not ownership. `charge-once.md` citing
//      `billing-charges.md` does not mean the page owns the entry. The entry
//      may well be the more durable record of the two — a decision survives the
//      architecture page describing it. Cascading down a citation edge deletes
//      the survivor.
//
// REFUSE — a layer refuses to delete while another still references it — is
// rejected too, and for a reason that is specific rather than philosophical:
// KERYX CANNOT REFUSE. There is no deletion operation for knowledge anywhere in
// this codebase. Probed directly on this branch: `wiki delete/remove/rm/forget`,
// `memory delete/remove/rm/forget`, `gdgraph delete/remove/prune`,
// `workspace delete/remove/destroy` — every one is "Unknown command", and the
// MCP registry exposes 44 tools of which 0 delete knowledge. Knowledge is
// deleted with `rm`. Every mechanism here observes a deletion AFTER it has
// happened; a refusal it could issue would be a refusal to acknowledge, which
// is the silence being fixed. (Refusal remains right where a WRITE is at stake,
// and lane B already put it there: `syncSectionRegistry` refuses over an
// unreadable registry. That is a different verb.)
//
// REPORT is what is implemented, and AC1 names it as a full answer rather than
// a fallback: "либо возвращает перечень того, чего не тронуло, с причиной по
// каждому". What makes it not a cop-out is the two properties below, without
// which "report" is just the silence with a heading on it:
//
//   * It is COMPLETE and it is MANDATORY. Every layer appears in the report,
//     including the layers that were left alone and including the layer this
//     reconcile does not inspect — each with a cause. A layer that is silently
//     absent from a propagation report is a dangling reference nobody was told
//     about, which is the thing AC1 forbids.
//   * It reports an OBSERVED RESPONSE, not an inventory. For each removed
//     identity the report carries what the system now ANSWERS when that
//     identity is looked up (`observedResponse`), obtained by running the
//     resolver. AC7 rejects evidence about ages, byte volumes and file counts;
//     a list of deleted files would be exactly that. What a reference into
//     deleted knowledge gets back is the only thing that confirms anything.
//
// The one place propagation DOES happen is the identity layer, because there
// the propagation is the recording: `wiki sections sync` turns "the page is
// gone" into "the page was removed, on this date". That write creates no risk
// of losing authored content — it only ever adds a tombstone — so it is done,
// not merely reported.

import {
  explainOrphans,
  getDanglingEdges,
  namesDeletedFile,
  type DanglingEdge,
} from "../gdgraph/dangling";
import { loadGraph } from "../gdgraph/query";
import type { GraphData } from "../gdgraph/types";
import { collectEntries } from "../memory/store";
import {
  checkMemoryCrossLayer,
  isDangling,
  loadWikiKnowledgeView,
  type CrossLayerFinding,
  type WikiKnowledgeView,
} from "../memory/cross-layer";
import { resolveSectionIdentity } from "../wiki/section-tombstone";

export type KnowledgeLayer = "wiki-identity" | "memory" | "graph" | "sac-evidence";

/** A knowledge identity the wiki no longer carries. */
export type RemovedIdentity = {
  ref: string;
  page: string | null;
  title: string | null;
  /** `tombstoned` — recorded. `pending` — gone from disk, not yet recorded. */
  state: "tombstoned" | "pending";
  removedAt: string | null;
  /**
   * What the system ANSWERS when this identity is looked up now. This is the
   * AC7 evidence: an observed response to a reference into deleted knowledge,
   * not a count of what was removed.
   */
  observedResponse: string;
};

export type DanglingReference = {
  layer: KnowledgeLayer;
  /** The file or node still holding the reference. */
  holder: string;
  /** The reference as written. */
  reference: string;
  /** The layer's own verdict on it. */
  verdict: string;
  detail: string;
};

export type LayerOutcome = {
  layer: KnowledgeLayer;
  /** True only when this reconcile actually changed the layer. */
  propagated: boolean;
  /**
   * Why. Required in both directions — a propagation with no stated cause and
   * a non-propagation with no stated cause are equally unreadable.
   */
  cause: string;
  /** References this layer still holds into knowledge that is gone. */
  dangling: DanglingReference[];
  /**
   * Three states, never two. An empty `dangling` list means something
   * different in each, and merging them is the collapse this flow is about:
   *
   *   `examined`     — checked; the `dangling` list is complete for this layer.
   *   `failed`       — tried and could not (unreadable registry, unloadable
   *                    graph). An empty list here is NOT "nothing is broken".
   *   `not-examined` — deliberately out of this reconcile's scope, with the
   *                    cause saying so. Also not "nothing is broken".
   */
  inspection: "examined" | "failed" | "not-examined";
  /**
   * References this layer holds that do not resolve, and which this reconcile
   * cannot attribute to a deletion.
   *
   * Reported as a count with a cause rather than listed, and deliberately NOT
   * folded into `dangling`. Run over this repository's own graph, dozens of
   * in-project imports do not resolve and nearly all are import statements
   * written inside test fixture strings — specifiers that never resolved and
   * never will. Calling those references into removed knowledge would be a
   * false claim; hiding them would be the silence this flow exists to remove.
   * Counted and named is the only honest third option.
   */
  unclassified: { count: number; cause: string } | null;
};

export type PropagationReport = {
  /**
   * The verdict OVER THE EXAMINED LAYERS ONLY — `notExamined` bounds it, and a
   * renderer that prints `status` without printing `notExamined` is making a
   * wider claim than this field carries.
   *
   * `clean` — every examined layer was checked and holds no reference into
   *           removed knowledge.
   * `dangling` — at least one examined layer still points at removed knowledge.
   * `undecidable` — at least one layer was tried and could not be read, so
   *           `clean` cannot be claimed even for the layers that did answer.
   */
  status: "clean" | "dangling" | "undecidable";
  removed: RemovedIdentity[];
  layers: LayerOutcome[];
  /** Layers this reconcile did not look at. Never silently empty. */
  notExamined: KnowledgeLayer[];
};

export type PropagationInput = {
  cwd: string;
  /**
   * Whether the identity layer was written in this call. The caller performs
   * that write (it is a `wiki sections sync`), and passes what happened —
   * this module never writes.
   */
  identityLayer: { propagated: true } | { propagated: false; cause: string };
  /**
   * Project-relative paths of code files the caller can show were deleted (the
   * git diff `keryx sync` already computes against each artifact's provenance).
   *
   * Without it, NO unresolved import is attributed to a deletion — the graph
   * alone cannot tell an import whose target was deleted from one that never
   * resolved, and guessing would be the fabrication. Omitted ⇒ every in-project
   * unresolved edge is reported as unclassified, with that stated.
   */
  deletedFiles?: ReadonlyArray<string> | undefined;
};

/**
 * Build the report. Pure with respect to the project: reads every layer,
 * writes none.
 */
export async function reportPropagation(input: PropagationInput): Promise<PropagationReport> {
  const { cwd } = input;
  const view = await loadWikiKnowledgeView(cwd);
  const removed = await collectRemovedIdentities(cwd, view);

  const layers: LayerOutcome[] = [
    identityOutcome(input.identityLayer, view, removed),
    await memoryOutcome(cwd, view),
    // `undefined` (no window at all) and `[]` (a window that found nothing
    // deleted) are different facts and the report says which it had — so the
    // two are carried apart rather than merged by a `?? []`.
    await graphOutcome(cwd, input.deletedFiles ? new Set(input.deletedFiles) : null),
    sacOutcome(),
  ];

  const anyDangling = layers.some((layer) => layer.dangling.length > 0);
  const anyFailed = layers.some((layer) => layer.inspection === "failed");
  return {
    status: anyFailed ? "undecidable" : anyDangling ? "dangling" : "clean",
    removed,
    layers,
    notExamined: layers.filter((layer) => layer.inspection === "not-examined").map((layer) => layer.layer),
  };
}

/**
 * Everything the wiki once carried and does not now — both already-recorded
 * tombstones and identities that are gone from disk with the record not yet
 * written. The second group is the one that matters most here: it is the
 * interruption window, in which a deleted identity used to read as
 * never-existed.
 */
async function collectRemovedIdentities(
  cwd: string,
  view: WikiKnowledgeView,
): Promise<RemovedIdentity[]> {
  if (view.registry.state !== "present") {
    return [];
  }
  const registry = view.registry.registry;
  const identities: RemovedIdentity[] = [];

  const liveRefs = new Set<string>();
  for (const section of view.index.sections) {
    liveRefs.add(section.sectionRef);
  }
  for (const identity of view.index.pageIdentities.values()) {
    liveRefs.add(identity.pageId);
  }

  for (const tombstone of registry.tombstones) {
    identities.push({
      ref: tombstone.ref,
      page: tombstone.page,
      title: tombstone.title,
      state: "tombstoned",
      removedAt: tombstone.removedAt,
      observedResponse: describeObservedResponse(view, tombstone.ref),
    });
  }
  for (const entry of registry.entries) {
    if (liveRefs.has(entry.ref)) {
      continue;
    }
    identities.push({
      ref: entry.ref,
      page: entry.page,
      title: entry.title,
      state: "pending",
      removedAt: null,
      observedResponse: describeObservedResponse(view, entry.ref),
    });
  }

  return identities.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * Run the identity resolver and render its answer.
 *
 * This is deliberately the SAME call `keryx wiki sections resolve` makes, not a
 * restatement of what the registry holds: an inventory read off the registry
 * would be a claim about the data, and what AC7 asks for is what the system
 * says when asked.
 */
function describeObservedResponse(view: WikiKnowledgeView, ref: string): string {
  const resolution = resolveSectionIdentity(view.index, view.registry, ref);
  switch (resolution.kind) {
    case "tombstoned":
      return `resolves to a tombstone: removed ${resolution.tombstone.removedAt} — ${resolution.tombstone.reason}`;
    case "pending-tombstone":
      return `resolves to "pending-tombstone": ${resolution.reason}`;
    case "reoccupied":
      return `resolves to "reoccupied": ${resolution.reason}`;
    case "registry-unreadable":
      return `cannot be resolved: ${resolution.reason}`;
    case "found":
    case "page-found":
      return "resolves to live wiki knowledge — this identity is present again.";
    case "stale-locator":
      return `resolves to "stale-locator": ${resolution.reason}`;
    default:
      return `resolves to "unknown": ${resolution.reason}`;
  }
}

function identityOutcome(
  identityLayer: PropagationInput["identityLayer"],
  view: WikiKnowledgeView,
  removed: RemovedIdentity[],
): LayerOutcome {
  if (view.registry.state === "unreadable") {
    return {
      layer: "wiki-identity",
      propagated: false,
      cause: `the section registry could not be read, so nothing about removals can be established here: ${view.registry.reason}`,
      dangling: [],
      inspection: "failed",
      unclassified: null,
    };
  }
  const pending = removed.filter((identity) => identity.state === "pending");
  if (identityLayer.propagated) {
    return {
      layer: "wiki-identity",
      propagated: true,
      cause:
        "the identity registry was synced in this run: every identity the wiki no longer carries now has a " +
        "tombstone, so a reference to it resolves to a removal record rather than to nothing.",
      dangling: [],
      inspection: "examined",
      unclassified: null,
    };
  }
  return {
    layer: "wiki-identity",
    propagated: false,
    cause: identityLayer.cause,
    dangling: pending.map((identity) => ({
      layer: "wiki-identity" as const,
      holder: ".metaproject/wiki/.sections.json",
      reference: identity.ref,
      verdict: "pending-tombstone",
      detail:
        `registered${identity.page ? ` from ${identity.page}` : ""} and no longer carried by the wiki, with no ` +
        "tombstone written yet.",
    })),
    inspection: "examined",
    unclassified: null,
  };
}

async function memoryOutcome(cwd: string, view: WikiKnowledgeView): Promise<LayerOutcome> {
  const entries = await collectEntries(cwd);
  const findings = await checkMemoryCrossLayer(cwd, entries, view);
  const dangling = findings.filter(isDangling);
  // A reference the wiki could not decide about makes the MEMORY layer's answer
  // a failed inspection, not a clean one: the entry may or may not be citing
  // removed knowledge, and reporting the layer as examined would turn "I could
  // not tell" into "I checked".
  const couldNotDecide = dangling.some((finding) => finding.state === "undecidable");

  return {
    layer: "memory",
    propagated: false,
    cause:
      "NOT PROPAGATED, by design. A memory entry is authored, not derived: deleting it because a page it cites " +
      "was removed would destroy the more durable of the two records — a decision outlives the architecture page " +
      "describing it. Every entry still pointing at removed knowledge is named below instead, and " +
      "`keryx memory check` now reports the same references as issues.",
    dangling: dangling.map(toMemoryDangling),
    inspection: couldNotDecide ? "failed" : "examined",
    unclassified: null,
  };
}

function toMemoryDangling(finding: CrossLayerFinding): DanglingReference {
  return {
    layer: "memory",
    holder: `${finding.reference.entry}:${finding.reference.line}`,
    reference: finding.reference.raw,
    verdict: finding.state,
    detail: finding.detail,
  };
}

async function graphOutcome(
  cwd: string,
  deletedFiles: ReadonlySet<string> | null,
): Promise<LayerOutcome> {
  let graph: GraphData;
  try {
    graph = await loadGraph(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      layer: "graph",
      propagated: false,
      cause: `the code graph could not be loaded (${message}), so its references cannot be reported either way.`,
      dangling: [],
      inspection: "failed",
      unclassified: null,
    };
  }

  // Two filters, and both are needed for the report to say anything true.
  // Scope first: only a relative specifier addresses this project's own tree
  // (`../gdgraph/dangling.ts`). Then attribution: an unresolved import is a
  // reference into REMOVED knowledge only when it names a file that can be
  // shown to have been deleted. On this repository's own graph the unfiltered
  // set is dozens of import statements sitting inside test fixture strings.
  const inProject = getDanglingEdges(graph, { scope: "in-project" });
  const intoDeleted = deletedFiles
    ? inProject.filter((edge) => namesDeletedFile(edge, deletedFiles))
    : [];
  const intoDeletedFiles = new Set(intoDeleted.map((edge) => edge.from));
  const unattributed = inProject.length - intoDeleted.length;

  // An orphan is reported here only when the import that made it an orphan is
  // one of the deleted ones. A file orphaned by a fixture string was already an
  // orphan yesterday and has nothing to do with this deletion.
  const orphanedByDeletion = explainOrphans(graph).filter(
    (orphan) => orphan.cause === "dangling-only" && intoDeletedFiles.has(orphan.path),
  );

  return {
    layer: "graph",
    propagated: true,
    cause:
      "PROPAGATED for the node, NOT for the edges. A rebuild removes the deleted file's node, but every import " +
      "of it survives as an unresolved edge, which `dependencies`, `dependents` and `orphans` all filter out " +
      "before answering — so the importer reported `Dependencies: none` and then appeared in `query orphans`. " +
      "Those three answers are unchanged (an unresolved edge has no node to close a dependency over); the edges " +
      "they drop are listed here.",
    dangling: [
      ...intoDeleted.map((edge) => toGraphDangling(edge)),
      ...orphanedByDeletion.map((orphan) => ({
        layer: "graph" as const,
        holder: orphan.path,
        reference: "(reported as an orphan)",
        verdict: "orphaned-by-dangling",
        detail:
          "`keryx gdgraph query orphans` lists this file. It is not isolated: it holds " +
          `${orphan.cause === "dangling-only" ? orphan.unresolved.length : 0} in-project import(s) that do not ` +
          "resolve. \"Nothing uses this, delete it\" and \"its dependency was deleted\" are opposite conclusions " +
          "from that one line of output.",
      })),
    ],
    inspection: "examined",
    unclassified:
      unattributed > 0
        ? {
            count: unattributed,
            cause:
              deletedFiles === null
                ? "in-project imports that resolve to no file. NO deletion window was supplied to this run, so " +
                  "none of them is attributed to a deletion: the graph alone cannot tell an import whose target " +
                  "was removed from one that never resolved, and guessing would be the fabrication. " +
                  "`keryx gdgraph query orphans` and a build's `Unresolved imports` line list them."
                : deletedFiles.size === 0
                ? "in-project imports that resolve to no file. The deletion window was checked and is EMPTY — " +
                  "git reports no code file deleted since the graph was built — so none of these can be a " +
                  "reference into knowledge removed in this window. They resolve to nothing for some other " +
                  "reason (most are import statements inside test fixture strings) and are counted, not hidden."
                : "further in-project imports that resolve to no file and do NOT name any file deleted in this " +
                  "window. Most are import statements written inside test fixture strings, which never resolved " +
                  "and never will — they are counted rather than listed so the references that ARE into removed " +
                  "knowledge stay visible, and counted rather than dropped so the count is not hidden.",
          }
        : null,
  };
}

function toGraphDangling(edge: DanglingEdge): DanglingReference {
  return {
    layer: "graph",
    holder: edge.from,
    reference: edge.specifier,
    verdict: "unresolved-import",
    detail:
      `imports \`${edge.specifier}\`, which names a file deleted in this window and resolves to nothing. The ` +
      "edge is kept in the graph as `unresolved` and is filtered out of every dependency answer, so without " +
      "this line the importer reads as having no dependencies at all.",
  };
}

/**
 * The fourth layer, named rather than omitted.
 *
 * SAC workspace evidence is not inspected by this reconcile, and saying so is
 * the point: AC1 requires a cause for each layer left untouched, and a layer
 * that simply does not appear in a propagation report is indistinguishable from
 * a layer that was checked and found clean. This is an under-claim on purpose.
 */
function sacOutcome(): LayerOutcome {
  return {
    layer: "sac-evidence",
    propagated: false,
    cause:
      "NOT INSPECTED by this reconcile. SAC workspace evidence resolves its own references through the " +
      "workspace surfaces (`keryx workspace …`), which this command does not drive. This layer is listed with " +
      'no findings rather than omitted: "not checked" must not read as "checked and clean".',
    dangling: [],
    inspection: "not-examined",
    unclassified: null,
  };
}

