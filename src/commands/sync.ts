import { gitHead, readProvenance, recordProvenance, SYNCED_MODULES, type SyncedModule } from "../sync/provenance";
import { codeOnly, diffSince, totalChanges } from "../sync/diff";

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

  let anyStale = false;
  for (const module of SYNCED_MODULES) {
    const provenance = await readProvenance(cwd, module);
    console.log(`## ${module}`);

    if (!provenance) {
      anyStale = true;
      if (apply) {
        await applyModule(cwd, module, null, at);
        console.log("  → built + provenance recorded (baseline)");
      } else {
        console.log("  no provenance — run `keryx sync --apply` to build + record a baseline");
      }
      console.log("");
      continue;
    }

    const diff = await diffSince(cwd, provenance.commit);
    const code = diff ? codeOnly(diff) : null;
    if (!code || totalChanges(code) === 0) {
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
      await applyModule(cwd, module, provenance.commit, at);
      console.log("  → updated + provenance advanced");
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

  if (!apply && anyStale) {
    process.exitCode = 0; // advisory; hooks decide what to do with the report
  }
}

async function applyModule(
  cwd: string,
  module: SyncedModule,
  base: string | null,
  at: string,
): Promise<void> {
  if (module === "gdgraph") {
    const { gdgraphCommand } = await import("./gdgraph");
    await gdgraphCommand(["build"]);
  } else if (module === "gdwiki") {
    const { wikiCollect, wikiGenerateIndex } = await import("../wiki/service");
    await wikiCollect({ cwd, changed: base !== null, ...(base ? { since: base } : {}) });
    await wikiGenerateIndex(cwd);
  } else if (module === "memory") {
    const { memoryCommand } = await import("./memory");
    await memoryCommand(["index"]);
  }
  await recordProvenance(cwd, module, at);
}

function printHelp(): void {
  console.log(`keryx sync — reconcile graph/wiki/memory with the current code

Usage:
  keryx sync              # report what changed (added/changed/deleted) since each artifact was built
  keryx sync --apply      # update the artifacts incrementally + advance provenance
  keryx sync install-hooks    # run sync on git pull (post-merge) + branch switch (post-checkout)
  keryx sync uninstall-hooks

Each artifact records the commit it was built from; sync diffs it against HEAD.
Wired to post-merge / post-checkout git hooks so pull/fetch/branch-switch keep
the derived layers in step.
`);
}
