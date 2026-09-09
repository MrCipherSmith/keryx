// `keryx forgetting` — the deletion trail's read surface (flow 242, T9/F9).
//
// F9 was filed as "the deletion trail has no read surface": `readDeletionJournal`
// was exported from `src/forgetting/service.ts` and called by nothing outside
// its own module and tests. The programme's most-repeated defect is a capability
// whose only caller is its own test, so this command exists to be the one a
// person or an agent actually runs, and three other surfaces (`memory search`,
// `wiki check-links`, `gdgraph affected`) reach the same module underneath —
// the trail is consulted whether or not anyone types this verb.
//
// Transport only. Every decision — what the trail says, how far its silence
// reaches, how attribution is rendered — belongs to `src/forgetting/trail.ts`
// and is reached through `../forgetting/service`, the owner's facade. This file
// parses flags and prints lines.
//
// Exit codes follow `keryx wiki sections resolve`'s convention rather than
// inventing one: 0 for a completed answer (including "no record", which IS an
// answer), 2 for "cannot tell" — an unreadable trail, where removed and
// never-recorded cannot be separated at all. 1 stays what it is everywhere else
// in this CLI: a bad argument.

import {
  describeRemovalLookup,
  loadDeletionTrail,
  lookupRemoval,
  searchRemovals,
  trailCoverage,
  TRAIL_SCOPE_CAVEAT,
  type RemovalLookup,
} from "../forgetting/service";
import { optionValue } from "../lib/args";

export async function forgettingCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || args.includes("--help")) {
    printHelp();
    return;
  }

  if (command === "trail") {
    await runTrail(args.slice(1));
    return;
  }
  if (command === "lookup") {
    await runLookup(args.slice(1));
    return;
  }

  console.error(`Unknown forgetting command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runTrail(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const limitArg = optionValue(args, "--limit");
  const limit = limitArg === undefined ? 20 : Number(limitArg);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("keryx forgetting trail: --limit must be a positive integer");
    process.exitCode = 1;
    return;
  }

  const trail = await loadDeletionTrail(process.cwd());
  const coverage = trailCoverage(trail);
  // Newest first: the question a reader brings to a trail is "what happened
  // recently", and `--limit` truncating from the old end would answer it with
  // the least relevant records.
  const shown = [...trail.records].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          path: trail.path,
          state: trail.state,
          ...(trail.state === "unreadable" ? { reason: trail.reason } : {}),
          coverage,
          scopeCaveat: TRAIL_SCOPE_CAVEAT,
          shown: shown.length,
          records: shown,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("# forgetting trail");
    console.log("");
    console.log(`path: ${trail.path}`);
    console.log(`state: ${trail.state}`);
    if (trail.state === "unreadable") {
      console.log(`reason: ${trail.reason}`);
    }
    console.log(`records: ${coverage.records} (showing ${shown.length})`);
    console.log(`removals recorded: ${coverage.removalsRecorded}`);
    console.log(`layers with recorded removals: ${coverage.layersWithRemovals.join(", ") || "none"}`);
    console.log(
      `layers every record names as untouched: ${coverage.layersRecordedUntouched.join(", ") || "none"}`,
    );
    console.log("");
    for (const record of shown) {
      console.log(`- ${record.at} \`${record.observedBy}\` (${record.outcome})`);
      for (const item of record.removed ?? []) {
        const title = item.title ? ` "${item.title}"` : "";
        console.log(`    removed: [${item.layer}] ${item.ref}${title}`);
      }
      for (const refusal of record.refusals ?? []) {
        console.log(`    refusal: ${refusal}`);
      }
    }
    if (shown.length > 0) {
      console.log("");
    }
    console.log(TRAIL_SCOPE_CAVEAT);
  }

  process.exitCode = trail.state === "unreadable" ? 2 : 0;
}

async function runLookup(args: string[]): Promise<void> {
  const asJson = args.includes("--json");
  const asSearch = args.includes("--search");
  const layer = optionValue(args, "--layer");
  const ref = positional(args);
  if (ref === undefined) {
    console.error(
      'Usage: keryx forgetting lookup "<ref-or-path>" [--layer <layer>] [--search] [--json]',
    );
    process.exitCode = 1;
    return;
  }

  const trail = await loadDeletionTrail(process.cwd());
  // `--search` is a DIFFERENT question and is never a fallback for the identity
  // lookup. Silently widening an exact lookup to a phrase match on a miss is how
  // a caller ends up shown an adjacent record and reading it as this one.
  const lookup: RemovalLookup = asSearch
    ? searchRemovals(trail, ref)
    : lookupRemoval(trail, { candidates: [ref], ...(layer !== undefined ? { layer } : {}) });

  if (asJson) {
    console.log(JSON.stringify({ query: ref, mode: asSearch ? "search" : "identity", lookup }, null, 2));
  } else {
    for (const line of describeRemovalLookup(lookup)) {
      console.log(line);
    }
  }

  process.exitCode = lookup.verdict === "trail-unreadable" ? 2 : 0;
}

function positional(args: string[]): string | undefined {
  const valueOptions = new Set(["--layer", "--limit"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined || value.startsWith("--")) {
      continue;
    }
    if (index > 0 && valueOptions.has(args[index - 1] ?? "")) {
      continue;
    }
    return value;
  }
  return undefined;
}

function printHelp(): void {
  console.log(`keryx forgetting

Read the deletion trail (.metaproject/data/forgetting/journal.jsonl): what was
removed, when, at whose request, and on what basis.

Usage:
  keryx forgetting trail [--limit <n>] [--json]
  keryx forgetting lookup "<ref-or-path>" [--layer <layer>] [--search] [--json]

Verdicts:
  recorded-removed      the trail names this as removed, with when/who/why
  no-removal-recorded   the trail was read and names no removal of it — NOT the
                        same claim as "it never existed"
  trail-absent          nothing has ever been appended to the trail here
  trail-unreadable      the trail exists and could not be read; removed and
                        never-recorded cannot be told apart (exit 2)

${TRAIL_SCOPE_CAVEAT}
`);
}
