import { gitHead, readProvenance, recordProvenance, SYNCED_MODULES, type SyncedModule } from "../sync/provenance";
import { codeOnly, diffSince, totalChanges } from "../sync/diff";
import { describeSourceGate, HEAD_NOT_REQUESTED, resolveWikiSourceGate, type WikiSourceGate } from "../wiki/staleness";
import type { DeletionWindow, RemovalAttribution } from "../forgetting/service";

// `keryx sync` — reconcile the derived artifacts (graph, wiki, memory) with the
// current code. Each artifact records the commit it was built from (provenance);
// sync computes exactly what changed since (added / modified / deleted files) and
// reports it, or with `--apply` updates the artifact incrementally and advances
// its provenance. This is what the post-merge / post-checkout hooks call so a
// `git pull`/`fetch`/branch-switch keeps graph+wiki+memory in step.

export async function syncCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }
  if (args[0] === "install-hooks" || args[0] === "uninstall-hooks") {
    const { installSyncHooks, uninstallSyncHooks } = await import("../sync/hooks");
    const cwd = process.cwd();
    if (args[0] === "install-hooks") {
      const installed = await installSyncHooks(cwd);
      console.log(installed.length > 0
        ? `# keryx sync hooks installed: ${installed.join(", ")}\n\nOn git pull / branch switch, they run 'keryx sync' (advisory report). Run 'keryx sync --apply' to reconcile.`
        : "No .git directory — nothing installed.");
    } else {
      const removed = await uninstallSyncHooks(cwd);
      console.log(`# keryx sync hooks removed: ${removed.length > 0 ? removed.join(", ") : "none"}`);
    }
    return;
  }
  const cwd = process.cwd();
  const apply = args.includes("--apply");
  const at = new Date().toISOString();

  console.log("# keryx sync");
  console.log("");
  const head = await gitHead(cwd);
  if (!head) {
    console.log("Not a git repository — nothing to sync.");
    return;
  }
  console.log(`HEAD: ${head.commit.slice(0, 8)} (${head.branch})`);
  console.log("");

  // The deletion window, captured BEFORE the module loop.
  //
  // `applyModule` advances gdgraph's provenance to HEAD, so a window computed
  // after the loop is always empty and every unresolved import comes back
  // unattributable — measured on the fixture, where `src/billing.ts` had
  // demonstrably just been deleted and the stage still reported "the deletion
  // window was checked and is EMPTY". The window belongs to the state sync
  // FOUND, not the state it leaves.
  const window = await deletionWindow(cwd);

  // Whether this run rebuilt the graph, which is the only thing that removes a
  // deleted file's node from it. Tracked here because the loop below is the only
  // place that knows: the forgetting stage used to claim the graph layer had
  // propagated on every run, report-only ones included.
  let graphRebuilt = false;
  let anyStale = false;
  for (const module of SYNCED_MODULES) {
    const provenance = await readProvenance(cwd, module);
    console.log(`## ${module}`);

    if (!provenance) {
      anyStale = true;
      if (apply) {
        const outcome = await applyModule(cwd, module, null, at);
        graphRebuilt ||= module === "gdgraph";
        printApplyOutcome(outcome, "  → built + provenance recorded (baseline)", "  → built; provenance NOT recorded (baseline)");
      } else {
        console.log("  no provenance — run `keryx sync --apply` to build + record a baseline");
      }
      console.log("");
      continue;
    }

    const diff = await diffSince(cwd, provenance.commit);

    // `diffSince` returns null when git CANNOT ANSWER — most often because the
    // recorded commit no longer exists, which is the ordinary outcome of
    // building on a branch that was later squash-merged and deleted. That is a
    // different fact from "compared, nothing changed", and collapsing the two
    // is how this repository's own graph sat two days and ~30 files stale while
    // sync reported `up to date (built at b99290b6)` — a revision `git
    // cat-file` cannot resolve at all.
    //
    // An unresolvable baseline is treated as stale, not as clean: not knowing
    // whether the derived layer matches the code is a reason to rebuild, never
    // a reason to claim it does.
    if (diff === null) {
      anyStale = true;
      if (apply) {
        const outcome = await applyModule(cwd, module, null, at);
        graphRebuilt ||= module === "gdgraph";
        printApplyOutcome(
          outcome,
          `  → rebuilt from scratch; provenance named ${provenance.commit.slice(0, 8)}, which this repository does not have`,
          "  → rebuilt from scratch; provenance NOT re-recorded",
        );
      } else {
        console.log(
          `  cannot compare — provenance names ${provenance.commit.slice(0, 8)}, a revision this repository does not have`,
        );
        console.log("  (a branch that was squash-merged and deleted leaves exactly this)");
        console.log("  → run `keryx sync --apply` to rebuild and re-record");
      }
      console.log("");
      continue;
    }

    const code = codeOnly(diff);
    if (totalChanges(code) === 0) {
      console.log(`  up to date (built at ${provenance.commit.slice(0, 8)})`);
      console.log("");
      continue;
    }

    anyStale = true;
    console.log(
      `  since ${provenance.commit.slice(0, 8)}: +${code.added.length} added · ~${code.modified.length} changed · -${code.deleted.length} deleted`,
    );
    for (const f of code.added.slice(0, 5)) console.log(`    + ${f}`);
    for (const f of code.deleted.slice(0, 5)) console.log(`    - ${f}`);
    if (apply) {
      const outcome = await applyModule(cwd, module, provenance.commit, at);
      graphRebuilt ||= module === "gdgraph";
      printApplyOutcome(outcome, "  → updated + provenance advanced", "  → updated; provenance NOT advanced");
      if (module === "gdwiki" && code.deleted.length > 0) {
        const { wikiPruneOrphans } = await import("../wiki/service");
        const prune = await wikiPruneOrphans(cwd);
        for (const page of prune.pruned) console.log(`  - pruned orphan page (module removed): ${page}`);
        for (const page of prune.orphanedAccepted) {
          console.log(`  ! stale page — module removed but page is human-owned, delete manually if intended: ${page}`);
        }
      }
    } else {
      console.log("  → run `keryx sync --apply` to update");
    }
    console.log("");
  }

  await runForgettingStage(cwd, { apply, at, args, window, graphRebuilt });

  if (!apply && anyStale) {
    process.exitCode = 0; // advisory; hooks decide what to do with the report
  }
}

// --- forgetting (flow 242, lane E) -------------------------------------------
//
// `keryx sync` is the project's FULL RECONCILE — the thing the post-merge and
// post-checkout hooks run so the derived layers keep step with the code. It
// reconciled exactly one kind of change: code. Measured on a scratch project
// where a wiki page, a memory entry and a graph node all described the same
// thing and the page and its source file were deleted:
//
//     $ keryx sync --apply
//     ## gdgraph
//       since da61a595: +0 added · ~0 changed · -1 deleted
//         - src/billing.ts
//     ## gdwiki
//       → updated + provenance advanced
//       - pruned orphan page (module removed): …/components/src.md
//     ## memory
//       → updated + provenance advanced
//
// Not one word about the deleted wiki page. `diffSince` is filtered through
// `codeOnly`, so a deletion under `.metaproject/` is invisible to every module
// branch above; and nothing here has ever called `syncSectionRegistry`, so the
// one mechanism in the codebase that records a removal did not run. After a
// FULL reconcile, `wiki sections resolve` on the deleted identity still
// answered `pending-tombstone` — the deletion was unrecorded, and the reconcile
// that was supposed to notice it reported success.
//
// This stage is the answer, and it always runs — with and without `--apply`.
// Without it, the report is the whole output. With it, the identity layer is
// synced (the tombstone is written) and the deletion is journalled.
//
// Why the report is the answer rather than a cascade, and why the journal is a
// separate file: `../forgetting/propagation.ts` and `../forgetting/journal.ts`
// carry the reasoning at length.
//
// This function DECIDES nothing. It parses two flags, reads the local git
// identity (a property of the invocation, which is the transport's to know),
// hands all of it to `../forgetting/service.ts`, and prints. The reconcile —
// which layer is written, what each layer is asked, what goes in the trail —
// lives in the owner, reached through its one facade. That is the import-policy
// rule (`src/lib/import-policy.ts`) and it is also the right shape: what the
// system answers for a reference into deleted knowledge must not be a property
// of the CLI that happened to ask.
async function runForgettingStage(
  cwd: string,
  options: {
    apply: boolean;
    at: string;
    args: string[];
    window: DeletionWindow;
    graphRebuilt: boolean;
  },
): Promise<void> {
  const { reconcileForgetting, deletionJournalPath } = await import("../forgetting/service");

  console.log("## forgetting");

  const { identity, report, trail } = await reconcileForgetting({
    cwd,
    apply: options.apply,
    at: options.at,
    observedBy: options.apply ? "keryx sync --apply" : "keryx sync",
    reason: flagValue(options.args, "--reason"),
    actor: flagValue(options.args, "--actor"),
    envActor: process.env["KERYX_ACTOR"],
    gitIdentity: await gitUserEmail(cwd),
    // The deletion window, captured by the caller before the module loop
    // advanced any provenance — in whichever of its three states it is. An
    // undetermined window attributes nothing AND claims nothing, which is the
    // difference between it and the empty one it used to be flattened into.
    deletionWindow: options.window,
    graphRebuilt: options.graphRebuilt,
  });

  if (identity.refusal) {
    console.log(`  ! the identity layer REFUSED to record the removal — ${identity.refusal}`);
  }

  // The short form is only taken when there is genuinely nothing to say. A
  // layer holding unclassified references has something to say — suppressing
  // that behind a "nothing to report" line is the same silence in a new place.
  const anyUnclassified = report.layers.some((layer) => layer.unclassified !== null);
  if (report.removed.length === 0 && report.status === "clean" && !anyUnclassified) {
    console.log("  no removed knowledge on record, and no layer holds a reference into removed knowledge.");
    console.log(`  not examined: ${report.notExamined.join(", ") || "none"}`);
    console.log("");
    return;
  }

  console.log(`  status: ${report.status} (over the examined layers)`);
  console.log(`  not examined: ${report.notExamined.join(", ") || "none"}`);

  // What THIS run did, said before the history so it cannot be read off the
  // history. Every removal on record was printed under one undifferentiated
  // `- removed:` heading, so a sync that removed nothing rendered as a sync
  // that had removed everything the project ever had.
  console.log(
    report.removedInThisRun.length > 0
      ? `  this run removed: ${report.removedInThisRun.length} identit${
          report.removedInThisRun.length === 1 ? "y" : "ies"
        }`
      : "  this run removed: nothing",
  );

  for (const identityRecord of report.removed) {
    console.log(
      `  - removed (${describeRemovalAttribution(identityRecord.recordedBy)}): ${identityRecord.ref}${
        identityRecord.page ? ` (${identityRecord.page})` : ""
      }`,
    );
    // The observed response, not an inventory line. AC7: a confirmation has to
    // show what the system ANSWERS for a reference into deleted knowledge.
    console.log(`      looked up now, it ${identityRecord.observedResponse}`);
  }

  for (const layer of report.layers) {
    const verb = layer.propagated ? "propagated" : "NOT propagated";
    console.log(`  · ${layer.layer}: ${verb} [${layer.inspection}]`);
    console.log(`      ${layer.cause}`);
    for (const dangling of layer.dangling) {
      console.log(`      ! ${dangling.holder} → ${dangling.reference} [${dangling.verdict}]`);
      console.log(`        ${dangling.detail}`);
    }
    if (layer.unclassified) {
      // Counted, not listed, and never dropped: these are real unresolved
      // references that this run cannot attribute to a deletion. Listing them
      // would bury the ones it can; omitting them would be the silence.
      console.log(`      ? ${layer.unclassified.count} unclassified — ${layer.unclassified.cause}`);
    }
  }

  if (trail.kind !== "recorded") {
    // Both non-recording outcomes say WHY, because "no trail line" is exactly
    // the silence this stage exists to remove — and the two causes are not the
    // same fact.
    console.log(`  trail: no deletion record appended — ${trail.cause}`);
    console.log("");
    return;
  }

  const { append, requestedBy, grounds } = trail;
  if (append.status === "appended") {
    console.log(`  trail: appended to ${deletionJournalPath(cwd)}`);
    console.log(
      `      recording ${append.record.removed.length} removal(s) made by this run` +
        (append.record.observedUnrecorded.length > 0
          ? `, and ${append.record.observedUnrecorded.length} observed as removed that this run could NOT record`
          : ""),
    );
    console.log(
      `      requested by: ${requestedBy.value ?? "unknown"} [${requestedBy.basis}] — ${requestedBy.detail}`,
    );
    console.log(`      on the basis: ${grounds.value ?? "none recorded"} [${grounds.basis}] — ${grounds.detail}`);
  } else {
    // The removal may well have happened. Saying it was recorded when the
    // record did not land is the one thing this stage must never do.
    console.log(`  ! trail NOT recorded — ${append.reason}`);
  }
  console.log("");
}

/**
 * The window of code deletions the graph's unresolved edges are judged against —
 * and, when it cannot be computed, the fact that it cannot.
 *
 * This function returned `string[]` and answered `[]` to three different
 * questions: "gdgraph has no provenance, so there is no baseline", "git could
 * not diff against the baseline it has", and "I compared and nothing was
 * deleted". The report then printed the third for all three. Measured on a
 * clean project with `src/a.ts` deleted and `src/b.ts` importing it, first
 * `sync --apply`:
 *
 *     status: clean (over the examined layers)
 *     · graph: propagated [examined]
 *         ? 1 unclassified — … The deletion window was checked and is EMPTY —
 *           git reports no code file deleted since the graph was built — so none
 *           of these can be a reference into knowledge removed in this window.
 *     $ keryx gdgraph query orphans
 *     src/b.ts
 *
 * The report did not overlook the dangling reference. It asserted there could
 * not be one, and closed the reconcile as clean — the exact collapse this lane
 * exists to remove, inside the code written to remove it. The three answers are
 * now three values, and the undecidable one makes the layer's inspection fail
 * rather than pass.
 */
async function deletionWindow(cwd: string): Promise<DeletionWindow> {
  const provenance = await readProvenance(cwd, "gdgraph");
  if (!provenance) {
    return {
      state: "undetermined",
      cause:
        "gdgraph has recorded no provenance in this project, so there is no commit to diff against and no " +
        "window exists to be checked. This is the ordinary state of a project's FIRST sync — the graph being " +
        "built in this very run — and it is the state in which a deletion is least likely to be noticed, not " +
        "most.",
    };
  }
  const diff = await diffSince(cwd, provenance.commit);
  if (diff === null) {
    return {
      state: "undetermined",
      cause:
        `git could not diff against ${provenance.commit.slice(0, 8)}, the commit gdgraph records as its ` +
        "baseline — most often a branch that was squash-merged and deleted. The deletions since that commit " +
        "are unknown here, not absent.",
    };
  }
  return {
    state: "determined",
    deleted: codeOnly(diff).deleted,
    basis: `git, diffing ${provenance.commit.slice(0, 8)}..HEAD,`,
  };
}

/** Whose act a removal on record is, in the words the report prints. */
function describeRemovalAttribution(attribution: RemovalAttribution): string {
  switch (attribution) {
    case "this-run":
      return "this run";
    case "an-earlier-run":
      return "an earlier run — not this one";
    default:
      return "not recorded by any run yet";
  }
}

/** `--flag value` (and `--flag=value`). Returns undefined when absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) {
    const next = args[index + 1];
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  }
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

/**
 * The local git identity, or undefined.
 *
 * Undefined is a real answer here and is passed through as such: it becomes an
 * `unknown` requester, never a blank one and never a fabricated one.
 */
async function gitUserEmail(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "config", "user.email"], { cwd, stdout: "pipe", stderr: "ignore" });
    if ((await proc.exited) !== 0) {
      return undefined;
    }
    const value = (await new Response(proc.stdout).text()).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Print an `applyModule` outcome honestly: the gate's reasons when it declined to record. */
function printApplyOutcome(
  outcome: { recorded: boolean; gate?: WikiSourceGate },
  recordedLine: string,
  skippedLine: string,
): void {
  if (outcome.recorded) {
    console.log(recordedLine);
    return;
  }
  console.log(`${skippedLine} — ${describeSourceGate(outcome.gate!)}`);
  for (const reason of outcome.gate?.reasons ?? []) {
    console.log(`    - ${reason}`);
  }
}

// AFC-08 (flow 236 T9): `wikiCollect` (`../wiki/service.ts`) already declines
// to advance gdwiki's OWN internal provenance record when `resolveWikiSourceGate`
// finds the code graph is not demonstrably fresh — the gate a sibling lane put
// inside the collector so `keryx sync` can never claim gdwiki reflects a
// source it did not actually read. This function used to call
// `recordProvenance(cwd, module, at)` again, unconditionally, for every
// module right after applying it — including gdwiki. That second, ungated
// write re-stamped gdwiki's provenance at the current commit regardless of
// what the gate had just decided, going around it entirely. Measured live: a
// fixture where gdgraph/memory already read "up to date" to sync's own
// commit-diff check (so their branches in the loop never ran) but the graph
// was genuinely stale by `checkGraphStaleness`'s own git-status signal (an
// untracked file) recorded gdwiki's provenance at HEAD anyway
// (`sync.test.ts`).
//
// The fix re-checks the SAME gate here — `resolveWikiSourceGate`, not a
// second freshness mechanism — before the shared `recordProvenance` call, and
// only for the module that carries the gate at all. Chosen over "record
// something else" or "refuse the apply": `wikiCollect` itself already applies
// (writes the page tree) and simply skips advancing ITS OWN provenance when
// not fresh, leaving the previous (older, or absent) record standing — an
// under-claim, never an over-claim. This mirrors that choice exactly rather
// than inventing a third answer (e.g. stamping an "unknown" sentinel), and
// keeps gdgraph/memory's existing unconditional recording unchanged: neither
// module has an equivalent staleness gate today, and gdgraph's own apply step
// (`gdgraph build`) always makes itself the fresh ground truth by definition.
async function applyModule(
  cwd: string,
  module: SyncedModule,
  base: string | null,
  at: string,
): Promise<{ recorded: boolean; gate?: WikiSourceGate }> {
  if (module === "gdgraph") {
    const { gdgraphCommand } = await import("./gdgraph");
    await gdgraphCommand(["build"]);
  } else if (module === "gdwiki") {
    const { wikiCollect, wikiGenerateIndex } = await import("../wiki/service");
    await wikiCollect({ cwd, changed: base !== null, ...(base ? { since: base } : {}) });
    await wikiGenerateIndex(cwd);
    // No revision at stake on this path — it gates gdwiki's own provenance
    // record, never a page's `VerifiedAt` (AFC-22, T13).
    const gate = await resolveWikiSourceGate(cwd, HEAD_NOT_REQUESTED);
    if (gate.status !== "fresh") {
      return { recorded: false, gate };
    }
  } else if (module === "memory") {
    const { memoryCommand } = await import("./memory");
    await memoryCommand(["index"]);
  }
  await recordProvenance(cwd, module, at);
  return { recorded: true };
}

function printHelp(): void {
  console.log(`keryx sync — reconcile graph/wiki/memory with the current code

Usage:
  keryx sync              # report what changed (added/changed/deleted) since each artifact was built
  keryx sync --apply      # update the artifacts incrementally + advance provenance
  keryx sync install-hooks    # run sync on git pull (post-merge) + branch switch (post-checkout)
  keryx sync uninstall-hooks

Options for the forgetting stage (with --apply):
  --reason <text>   why the knowledge was removed. Recorded on the tombstone and
                    in the deletion journal as a STATED basis. Without it the
                    journal records a machine-derived basis, marked as derived.
  --actor <who>     at whose request. Also read from KERYX_ACTOR. Without either,
                    the journal records the requester as unknown — it is never
                    filled in from the local git identity, which says who ran the
                    command, not who asked.

Each artifact records the commit it was built from; sync diffs it against HEAD.
Wired to post-merge / post-checkout git hooks so pull/fetch/branch-switch keep
the derived layers in step.

The forgetting stage runs every time. It reports every knowledge identity the
wiki no longer carries, what the system now ANSWERS when that identity is looked
up, and — for every layer — whether the removal propagated there, with a cause
either way. It does not cascade: a removal in one layer never deletes authored
content in another.

A deletion record is appended only by a run that actually removed something (or
that was refused), and it names only THAT run's removals — removals already on
record belong to the runs that made them.
`);
}
