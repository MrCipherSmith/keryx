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

import { readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, pathExists } from "../lib/fs";
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

/**
 * Every layer this reconcile accounts for.
 *
 * The list was four and neither complete nor mandatory, which is a defect of
 * the same kind as the ones inside it: `.metaproject/wiki/index.md` goes on
 * linking a page after the page is deleted (it is regenerated only by
 * `--apply`, so a report-only run reads a stale one), and the freshness queue
 * named in this flow's description was not here either. A layer that is simply
 * absent from a completeness report is indistinguishable from a layer that was
 * checked and found clean — which is the thing AC1 forbids, committed by the
 * report that enforces it.
 *
 * Adding a layer to this union is the whole mechanism: `reportPropagation`
 * builds one outcome per layer and `propagation.test.ts` pins the rendered set
 * against this list, so a layer that is declared and not produced fails.
 */
export type KnowledgeLayer =
  | "wiki-identity"
  | "wiki-index"
  | "wiki-freshness"
  | "memory"
  | "graph"
  | "sac-evidence";

/**
 * WHOSE act a removal on record is.
 *
 * The distinction is the whole of T7. `registry.tombstones` is cumulative — it
 * holds every removal this project has ever recorded — and a run that reads it
 * as "what I removed" writes an audit record attributing its predecessors'
 * deletions to itself, under its own stated reason. An append-only trail cannot
 * take that back.
 *
 *   `this-run`       — this run's own write turned the identity into a
 *                      tombstone. This is the ONLY value a deletion record may
 *                      report as its own act.
 *   `an-earlier-run` — the tombstone was on disk before this run started. Still
 *                      reported (a reference into it still resolves to a
 *                      removal, which is AC7's evidence) — never as this run's.
 *   `not-recorded`   — the wiki no longer carries it and NO run has recorded
 *                      it. Observed, not attributed: the interruption window.
 */
export type RemovalAttribution = "this-run" | "an-earlier-run" | "not-recorded";

/** A knowledge identity the wiki no longer carries. */
export type RemovedIdentity = {
  ref: string;
  page: string | null;
  title: string | null;
  /** `tombstoned` — recorded. `pending` — gone from disk, not yet recorded. */
  state: "tombstoned" | "pending";
  /** Whose act this is. Never inferred from the registry's contents alone. */
  recordedBy: RemovalAttribution;
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
  /**
   * Every removal on record, each labelled with whose act it is. Cumulative on
   * purpose: a reference into a removal from last month still resolves to a
   * tombstone today, and AC7's evidence is that answer.
   *
   * Nothing may read this field as "what this run removed". Use
   * `removedInThisRun`.
   */
  removed: RemovedIdentity[];
  /**
   * The subset this run's own write produced — the only removals a record of
   * this run may claim. Empty means this run removed nothing.
   */
  removedInThisRun: RemovedIdentity[];
  /**
   * Identities the wiki no longer carries that NO run has recorded. Observed by
   * this run, attributed to none: the interruption window, and what a refusal
   * leaves behind.
   */
  observedUnrecorded: RemovedIdentity[];
  layers: LayerOutcome[];
  /** Layers this reconcile did not look at. Never silently empty. */
  notExamined: KnowledgeLayer[];
};

/**
 * The window an unresolved import is judged against — in THREE states, because
 * there are three facts and the caller had been sending one value for all of
 * them.
 *
 * `deletedCodeFiles` in `src/commands/sync.ts` returned `[]` for "gdgraph has
 * no provenance yet", for "the diff could not be computed" and for "nothing was
 * deleted" alike, and the report rendered all three as *"The deletion window was
 * checked and is EMPTY — git reports no code file deleted since the graph was
 * built"*. Measured on a clean project where `src/a.ts` had been deleted and
 * `src/b.ts` imports it: the first `sync --apply` printed exactly that sentence
 * and `status: clean`, while `keryx gdgraph query orphans` printed `src/b.ts`.
 * The report did not merely fail to notice the dangling reference; it denied it.
 *
 * `undetermined` is therefore not an optional field and not an omitted one — a
 * caller must decide and say which it has. The old shape reserved `undefined`
 * for the undecidable case and no surface ever sent it, so the branch was
 * unreachable from the CLI: the collapse this lane exists to remove, committed
 * inside the code written to remove it.
 */
export type DeletionWindow =
  /**
   * The window was computed. `deleted` may legitimately be empty — that is
   * "nothing was deleted", and it is a real observation.
   */
  | { state: "determined"; deleted: ReadonlyArray<string>; basis: string }
  /** It could not be computed, and this says why. NOT an empty window. */
  | { state: "undetermined"; cause: string };

export type PropagationInput = {
  cwd: string;
  /**
   * Whether the identity layer was written in this call. The caller performs
   * that write (it is a `wiki sections sync`), and passes what happened —
   * this module never writes.
   *
   * `tombstonedNow` is what that write actually recorded. It is required on the
   * propagated branch rather than optional: an absent value would default to
   * "everything", which is the misattribution.
   */
  identityLayer:
    | { propagated: true; tombstonedNow: ReadonlyArray<string> }
    | { propagated: false; cause: string };
  graphLayer: {
    /**
     * Whether THIS run rebuilt the code graph. Without a rebuild the graph
     * still carries the deleted file's node, so nothing propagated there — and
     * this layer used to report `propagated: true` unconditionally on its
     * success path, including on a report-only run where `gdgraph affected`
     * still answered with the deleted file.
     */
    rebuiltInThisRun: boolean;
    window: DeletionWindow;
  };
};

/**
 * Build the report. Pure with respect to the project: reads every layer,
 * writes none.
 */
export async function reportPropagation(input: PropagationInput): Promise<PropagationReport> {
  const { cwd } = input;
  const view = await loadWikiKnowledgeView(cwd);
  const removed = await collectRemovedIdentities(
    view,
    new Set(input.identityLayer.propagated ? input.identityLayer.tombstonedNow : []),
  );

  const layers: LayerOutcome[] = [
    identityOutcome(input.identityLayer, view, removed),
    await wikiIndexOutcome(cwd),
    freshnessOutcome(),
    await memoryOutcome(cwd, view),
    await graphOutcome(cwd, input.graphLayer),
    sacOutcome(),
  ];

  const anyDangling = layers.some((layer) => layer.dangling.length > 0);
  const anyFailed = layers.some((layer) => layer.inspection === "failed");
  return {
    status: anyFailed ? "undecidable" : anyDangling ? "dangling" : "clean",
    removed,
    removedInThisRun: removed.filter((identity) => identity.recordedBy === "this-run"),
    observedUnrecorded: removed.filter((identity) => identity.recordedBy === "not-recorded"),
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
function collectRemovedIdentities(
  view: WikiKnowledgeView,
  tombstonedNow: ReadonlySet<string>,
): RemovedIdentity[] {
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
      // The whole of the attribution fix is this one line. `registry.tombstones`
      // is what the project has EVER removed; only the refs this run's own write
      // produced are this run's act.
      recordedBy: tombstonedNow.has(tombstone.ref) ? "this-run" : "an-earlier-run",
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
      recordedBy: "not-recorded",
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

/**
 * The generated wiki index — the fifth layer, and the one that was missing.
 *
 * `.metaproject/wiki/index.md` is a table of contents linking every page by
 * relative path. It is rewritten by `wikiGenerateIndex`, which runs only inside
 * `keryx sync --apply`; a report-only run therefore reads an index generated
 * before the deletion, still linking the page that is gone. That is a dangling
 * reference in a layer AC1 requires to be accounted for, and it was not one of
 * the four.
 *
 * The check is deliberately the plain one: a link whose target file is not
 * there. No title matching, no nearest-page fallback — the same rule
 * `resolveSectionIdentity` follows, for the same reason.
 */
async function wikiIndexOutcome(cwd: string): Promise<LayerOutcome> {
  const wikiRoot = path.join(cwd, ".metaproject", "wiki");
  const indexPath = path.join(wikiRoot, "index.md");
  let content: string;
  try {
    content = await readFile(indexPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return {
        layer: "wiki-index",
        propagated: false,
        cause:
          "no index has been generated in this project (`.metaproject/wiki/index.md` does not exist), so it " +
          "holds no link into anything. This is an examined empty, not an unchecked one.",
        dangling: [],
        inspection: "examined",
        unclassified: null,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      layer: "wiki-index",
      propagated: false,
      cause:
        `the wiki index exists and could not be read (${message}), so whether it links removed knowledge cannot ` +
        'be established here. This is not "the index links nothing".',
      dangling: [],
      inspection: "failed",
      unclassified: null,
    };
  }

  const dangling: DanglingReference[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (!target || !target.endsWith(".md") || /^[a-z]+:/i.test(target) || target.startsWith("#")) {
      continue;
    }
    const relative = target.split("#")[0] ?? target;
    if (seen.has(relative)) {
      continue;
    }
    seen.add(relative);
    if (await pathExists(path.join(wikiRoot, relative))) {
      continue;
    }
    dangling.push({
      layer: "wiki-index",
      holder: ".metaproject/wiki/index.md",
      reference: relative,
      verdict: "index-links-a-missing-page",
      detail:
        "the generated index still lists this page and the file is not there. The index is rewritten only by " +
        "`keryx sync --apply`, so every report-only run — and every reader following the index — is offered a " +
        "link into knowledge that has been removed.",
    });
  }

  return {
    layer: "wiki-index",
    propagated: false,
    cause:
      dangling.length > 0
        ? "NOT PROPAGATED in this run: the index is regenerated by `keryx sync --apply`, not by this report. " +
          "The links it still holds into missing pages are named below."
        : "the index links no page that is missing. It is regenerated by `keryx sync --apply`; nothing needed " +
          "changing here.",
    dangling,
    inspection: "examined",
    unclassified: null,
  };
}

/**
 * The freshness queue, listed rather than omitted — and listed with what it
 * actually holds, rather than with a shrug.
 *
 * `.metaproject/data/wiki/freshness-queue.jsonl` is named in this flow's
 * description as a layer a deletion touches, and it was not in the report at
 * all. Examined against its own schema (`../wiki/freshness/queue.ts`), each row
 * is `{event, rev, recordedAt, paths}` — "these code paths changed at this
 * revision". A deleted path in a row is a true statement about a past commit
 * and stays true after the deletion; there is no identity in it that a removal
 * could invalidate and no lookup it can answer wrongly. So it is reported as
 * NOT EXAMINED with that as the cause, which is an under-claim and not a
 * silence: the alternative — omitting it — is the one thing AC1 rules out,
 * because a layer that is not in the report reads exactly like a layer that was
 * checked and found clean.
 */
function freshnessOutcome(): LayerOutcome {
  return {
    layer: "wiki-freshness",
    propagated: false,
    cause:
      "NOT INSPECTED for dangling references, and not because it was overlooked. Each row of " +
      "`.metaproject/data/wiki/freshness-queue.jsonl` records that a set of code paths changed at a given " +
      "revision; a path that was later deleted makes that row no less true, and the queue resolves no knowledge " +
      "identity that a removal could turn into a wrong answer. What the queue's DRAIN then claims is a property " +
      "of the freshness surfaces (`keryx wiki freshness …`), which this command does not drive. Listed here " +
      'because a layer absent from a completeness report reads as "checked and clean".',
    dangling: [],
    inspection: "not-examined",
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
  input: PropagationInput["graphLayer"],
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
  const window = input.window;
  const inProject = getDanglingEdges(graph, { scope: "in-project" });
  const deletedFiles = window.state === "determined" ? new Set(window.deleted) : null;
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

  // An undetermined window with unresolved in-project edges in hand is a FAILED
  // inspection, and `reportPropagation` turns that into `undecidable` rather
  // than `clean`. The graph was read; what could not be decided is whether any
  // of these edges points into knowledge removed in a window that could not be
  // computed. Reporting `examined` there is how a clean project with `src/a.ts`
  // deleted and `src/b.ts` importing it came back `status: clean`.
  //
  // With NO unresolved in-project edge, there is nothing a window could have
  // decided about, so `examined` is honest — which is also what keeps this from
  // being a guard that fires on every run and therefore means nothing.
  const undecidable = window.state === "undetermined" && inProject.length > 0;

  return {
    layer: "graph",
    // Only a rebuild removes the node. On a report-only run nothing was rebuilt
    // and `gdgraph dependencies`/`affected` still answer with the deleted file,
    // so claiming propagation here is a write reported as having happened.
    propagated: input.rebuiltInThisRun,
    cause:
      (input.rebuiltInThisRun
        ? "PROPAGATED for the node, NOT for the edges. A rebuild removes the deleted file's node, but every " +
          "import of it survives as an unresolved edge, which `dependencies`, `dependents` and `orphans` all " +
          "filter out before answering — so the importer reported `Dependencies: none` and then appeared in " +
          "`query orphans`. Those three answers are unchanged (an unresolved edge has no node to close a " +
          "dependency over); the edges they drop are listed here."
        : "NOT PROPAGATED: this run did not rebuild the code graph, so the graph still carries a node for every " +
          "file deleted since it was built — `gdgraph dependencies`, `dependents` and `affected` keep answering " +
          "with knowledge that is gone. Run `keryx sync --apply` (or `keryx gdgraph build`) to rebuild it. What " +
          "is reported below was read from the graph as it stands, which is the state BEFORE the deletion.") +
      (undecidable
        ? " The deletion window could not be determined in this run, so the edges below are reported without a " +
          "verdict on whether they point into removed knowledge — see the unclassified line."
        : ""),
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
    inspection: undecidable ? "failed" : "examined",
    unclassified:
      unattributed > 0
        ? { count: unattributed, cause: unclassifiedCause(window) }
        : null,
  };
}

/**
 * What the count of unattributed unresolved imports actually means — which is a
 * different sentence in each of the window's three states.
 *
 * The middle one is the only one entitled to say "checked and is EMPTY", and it
 * is now reachable only when a diff genuinely ran and genuinely found no
 * deletion.
 */
function unclassifiedCause(window: DeletionWindow): string {
  if (window.state === "undetermined") {
    return (
      "in-project imports that resolve to no file. THE DELETION WINDOW COULD NOT BE DETERMINED: " +
      `${window.cause} Whether any of these is a reference into knowledge removed since the graph was built is ` +
      "UNDECIDED here — this is not \"the window was checked and is empty\", and it is not \"these are fine\". " +
      "The layer is reported as a failed inspection for that reason, so this run cannot come back `clean`. " +
      "`keryx gdgraph query orphans` lists the files these imports leave stranded."
    );
  }
  if (window.deleted.length === 0) {
    return (
      "in-project imports that resolve to no file. The deletion window was checked and is EMPTY — " +
      `${window.basis} reports no code file deleted since the graph was built — so none of these can be a ` +
      "reference into knowledge removed in this window. They resolve to nothing for some other reason (most " +
      "are import statements inside test fixture strings) and are counted, not hidden."
    );
  }
  return (
    "further in-project imports that resolve to no file and do NOT name any file deleted in this window. Most " +
    "are import statements written inside test fixture strings, which never resolved and never will — they are " +
    "counted rather than listed so the references that ARE into removed knowledge stay visible, and counted " +
    "rather than dropped so the count is not hidden."
  );
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

