import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryService } from "../memory/service";
import { loadMemoryConfig } from "../memory/config";
import { reflectMemory } from "../memory/reflect";
import { renderSearchMarkdown } from "../memory/search";
import { renderMemorySearchReport } from "../memory/report";
import { computeLifecycle, type LifecycleResult } from "../memory/lifecycle";
import { optionValue } from "../lib/args";
import {
  describeRemovalLookup,
  loadDeletionTrail,
  searchRemovals,
  type RemovalLookup,
} from "../forgetting/service";
import { runAssetsSubcommand } from "../assets/command";
import { MEMORY_CLASS_VALUES, MEMORY_TYPES } from "../memory/types";
import { memoryRoot } from "../memory/store";
import { isNotFound } from "../lib/fs";
import { MemoryValidationError } from "../memory/validation";
import type { MemoryClass, MemoryStatus, ScoredEntry, SearchFilters } from "../memory/types";

let service: ReturnType<typeof createMemoryService> | null = null;

function getService(): ReturnType<typeof createMemoryService> {
  service ??= createMemoryService();
  return service;
}

const INGEST_FLAGS: Record<string, string> = {
  "--from-review": "review",
  "--from-health": "health",
  "--from-job": "job",
  "--from-skill-verifier": "skill-verifier",
};

export async function memoryCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "new") {
    await runNew(args.slice(1));
    return;
  }
  if (command === "index") {
    await runIndex(args.slice(1));
    return;
  }
  if (command === "search") {
    await runSearch(args.slice(1));
    return;
  }
  if (command === "supersede") {
    await runSupersede(args.slice(1));
    return;
  }
  if (command === "transition") {
    await runTransition(args.slice(1));
    return;
  }
  if (command === "assets") {
    const result = await runAssetsSubcommand(process.cwd(), "memory", args.slice(1));
    for (const line of result.lines) {
      console.log(line);
    }
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
    return;
  }
  if (command === "ingest") {
    await runIngest(args.slice(1));
    return;
  }
  if (command === "check") {
    await runCheck();
    return;
  }
  if (command === "reflect") {
    await runReflect(args.slice(1));
    return;
  }

  console.error(`Unknown memory command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runNew(args: string[]): Promise<void> {
  const type = args[0];
  if (!type) {
    console.error('Usage: keryx memory new <type> [slug] --title "<title>" [--force]');
    process.exitCode = 1;
    return;
  }
  const slug = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const result = await getService().create({
    cwd: process.cwd(),
    type,
    slug,
    title: optionValue(args, "--title"),
    force: args.includes("--force"),
  });

  console.log(`Created ${result.type} entry: ${result.path}`);
  if (result.duplicates.length > 0) {
    console.log("");
    console.log("Possible duplicates:");
    for (const dupe of result.duplicates.slice(0, 5)) {
      console.log(`- ${dupe.path} (title ${dupe.titleSimilarity}, summary ${dupe.summaryJaccard})`);
    }
  }
  if (result.securitySkipped) {
    console.log(`Creation blocked by security gate: ${result.securitySkipped}`);
    process.exitCode = 1;
  }
}

async function runIndex(args: string[]): Promise<void> {
  const embeddings = args.includes("--embeddings");
  const result = await getService().index({ cwd: process.cwd(), embeddings });
  console.log(`Generated optional memory catalog for ${result.entryCount} entries -> ${result.path}`);
  console.log("Search scans canonical Markdown directly and does not depend on this catalog.");
  const { recordProvenance } = await import("../sync/provenance");
  await recordProvenance(process.cwd(), "memory", new Date().toISOString());
  if (result.embeddings) {
    if (result.embeddings.built) {
      console.log(
        `Embedding index: ${result.embeddings.vectorCount ?? 0} vector(s) (${result.embeddings.model ?? "?"}) -> ${result.embeddings.path ?? ""}`,
      );
    } else {
      console.log("Embedding index: capability unavailable; lexical index only.");
    }
  }
}

/**
 * Flow 242 (forgetting) lane C / AC3: `getService().search()` walks the
 * memory store the same way the old `wiki/collect.ts` used to walk the wiki
 * store — a `readdir` that cannot list a type-folder is treated identically
 * to a folder that simply does not exist yet, so an EACCES store answers
 * `{ results: [] }` at exit 0. Measured on this repo: `chmod 000
 * .metaproject/memory` then `keryx memory search <query> --json` prints
 * `{"query":"...","results":[]}` and exits 0 — a hard read failure reported
 * as a clean, empty, successful search. `memory/store.ts` is not this lane's
 * file to change, so this checks the SAME folders it walks, independently,
 * before trusting an empty result from it.
 */
async function detectMemoryStoreUnreadable(cwd: string): Promise<string | null> {
  const root = memoryRoot(cwd);
  for (const { folder } of MEMORY_TYPES) {
    const dir = join(root, folder);
    try {
      await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return (
        `the memory store could not be read (${message}). This is not the same as "no memory": ` +
        `${dir} may hold entries that could not be listed.`
      );
    }
  }
  return null;
}

async function runSearch(args: string[]): Promise<void> {
  const query = positionalArgs(args)[0] ?? "";
  if (!query) {
    console.error('Usage: keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>]');
    process.exitCode = 1;
    return;
  }

  // Checked BEFORE calling the service: the service itself never throws for
  // this case (see the note on `detectMemoryStoreUnreadable` above), so there
  // would be nothing for a try/catch below to catch. `store-unreadable` mirrors
  // `keryx wiki sections resolve`'s exit-code convention (2, not the CLI
  // default of 1) — reserved for "cannot tell", distinct from both a
  // completed search and a validation error.
  const storeError = await detectMemoryStoreUnreadable(process.cwd());
  if (storeError !== null) {
    if (args.includes("--json")) {
      console.log(JSON.stringify({ query, outcome: "store-unreadable", error: storeError }, null, 2));
    } else {
      console.error(`store-unreadable: ${storeError}`);
    }
    process.exitCode = 2;
    return;
  }

  const limitArg = optionValue(args, "--limit");
  const classArg = optionValue(args, "--class");
  if (classArg && !MEMORY_CLASS_VALUES.includes(classArg as MemoryClass)) {
    console.error(`Invalid --class: ${classArg}. Use one of: ${MEMORY_CLASS_VALUES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const parsedLimit = limitArg === undefined ? undefined : Number(limitArg);
  if (limitArg !== undefined && (parsedLimit === undefined || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)) {
    printMemoryValidationError(new MemoryValidationError("limit", "must be an integer from 1 to 100", "Choose a value in that range."), args.includes("--json"));
    process.exitCode = 1;
    return;
  }
  const filters: SearchFilters = {
    module: optionValue(args, "--module"),
    entity: optionValue(args, "--entity"),
    status: optionValue(args, "--status") as MemoryStatus | undefined,
    limit: parsedLimit,
    asOf: optionValue(args, "--as-of"),
    class: classArg as MemoryClass | undefined,
    semantic: args.includes("--semantic") ? true : undefined,
  };

  let result;
  try {
    result = await getService().search({ cwd: process.cwd(), query, filters });
  } catch (error) {
    if (error instanceof MemoryValidationError || error instanceof Error && error.name === "TemporalValidationError") {
      printMemoryValidationError(error, args.includes("--json"));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const report = args.includes("--save-report")
    ? await getService().writeReport({ cwd: process.cwd(), search: result, filters })
    : undefined;

  // Flow 242 T9/F3: a zero-result search said one thing for an entry that was
  // deleted and for a phrase that never named anything — measured on this repo,
  // `memory search "charge once"` after deleting the entry and
  // `memory search "quantum flux capacitor"` printed the identical
  // `_No matching memory entries._`. The deletion trail is consulted here, and
  // ONLY on an empty result: a search that found something has already answered
  // the caller's question, and appending removal history to a hit list would be
  // noise rather than the distinction this closes.
  //
  // A memory query is a phrase, not an identity, so this is `searchRemovals`
  // (phrase mode) rather than `lookupRemoval` — and every hit it renders carries
  // its own layer, so a wiki identity surfaced by a memory query reads as a wiki
  // identity. Where the trail has no record, "never existed" is NOT claimed:
  // `no-removal-recorded` and its coverage say exactly how little that silence
  // proves.
  const removalTrail: RemovalLookup | null =
    result.results.length === 0 ? searchRemovals(await loadDeletionTrail(process.cwd()), query) : null;

  // AFC-06 (flow 234) T22, AC1 second half: `--as-of` is memory's existing
  // explicit historical mode (`SearchFilters.asOf`, `../memory/types.ts` --
  // "overrides the default `current` exclusion"). It already prints each
  // result's raw `status`, but that alone does not carry the classifier's
  // full verdict -- an `accepted`-status entry returned only because its
  // validity window matches the requested date (future/expired relative to
  // TODAY) reads as ordinary "accepted" with no hint it isn't current. Label
  // it with the SAME `state`/`reasons` `computeLifecycle` already produces
  // (`../memory/lifecycle.ts`) -- computed here, not inside `search.ts`/
  // `renderSearchMarkdown`, which this task does not own -- so a non-current
  // result is unmistakable in both JSON and the text a model actually reads.
  const asOfMode = Boolean(filters.asOf);
  const now = new Date();
  const historicalByPath = new Map<string, LifecycleResult>();
  if (asOfMode) {
    for (const item of result.results) {
      const lifecycle = lifecycleOf(item, now);
      if (lifecycle.historical) {
        historicalByPath.set(item.entry.relativePath, lifecycle);
      }
    }
  }

  if (args.includes("--json")) {
    // T24 (flow 234) F-005 (MAJOR): this used to hand-roll five fields
    // (score/title/type/status/path), silently dropping every AC6 provenance
    // carrier (version, provenance.source/link, author, confirmedBy, caveat,
    // scope) the human `renderSearchMarkdown` form of this SAME command
    // already carries -- and because the keys were simply absent rather than
    // an explicit sentinel, a consumer of the JSON form could not tell "this
    // entry has no source" apart from "this surface doesn't report sources".
    // Built from the report formatter's own per-result projection
    // (`renderMemorySearchReport`, `../memory/report.ts`) -- the identical
    // bounded, "unknown"-sentineled shape AFC-25/AC6 already specify and
    // `--save-report` already persists -- so the JSON form carries the same
    // provenance the text form does, instead of a strictly weaker subset.
    // Pure/no disk I/O: computing the projection here does not persist a
    // report; only `--save-report` (above) does that, unchanged.
    const projection = renderMemorySearchReport({
      runId: randomUUID(),
      generatedAt: new Date(),
      search: result,
      filters,
    });
    console.log(
      JSON.stringify(
        {
          query,
          results: projection.results.map((item) => {
            const lifecycle = historicalByPath.get(item.path);
            return {
              ...item,
              ...(lifecycle
                ? { historical: true, lifecycleState: lifecycle.state, lifecycleReasons: lifecycle.reasons }
                : {}),
            };
          }),
          ...(removalTrail ? { removalTrail } : {}),
          ...(report ? { report } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  // T20 finding 3 (flow 234 review, MAJOR): this used to build its own
  // one-line-per-result markdown here, inline, carrying no provenance at
  // all -- while `renderSearchMarkdown` (memory/search.ts), which DOES carry
  // full AFC-25/AC6 provenance (version, scope, source/link, author,
  // confirmedBy, caveat), had no production caller anywhere in the tree.
  // Routed through the shared renderer so the real user-facing search
  // surface actually shows what AC6 requires.
  console.log(renderSearchMarkdown(query, result.results).trimEnd());
  if (removalTrail) {
    console.log("");
    console.log("## Removal trail");
    for (const line of describeRemovalLookup(removalTrail)) {
      console.log(line);
    }
  }
  if (historicalByPath.size > 0) {
    console.log("");
    console.log("## Historical (--as-of; not current guidance)");
    for (const item of result.results) {
      const lifecycle = historicalByPath.get(item.entry.relativePath);
      if (!lifecycle) continue;
      console.log(
        `- ${item.entry.title} (\`${item.entry.relativePath}\`): state=${lifecycle.state}; reason=${lifecycle.reasons.join(", ")}`,
      );
    }
  }
  if (report) {
    console.log("");
    console.log(`report: ${report.markdownPath}`);
    console.log(`json: ${report.jsonPath}`);
  }
}

function lifecycleOf(item: ScoredEntry, observedAt: Date): LifecycleResult {
  return computeLifecycle(
    {
      status: item.entry.status,
      validFrom: item.entry.validFrom ?? null,
      validTo: item.entry.validTo ?? null,
      supersededBy: item.entry.supersededBy ?? null,
    },
    observedAt,
  );
}

async function runSupersede(args: string[]): Promise<void> {
  const oldPath = args.find((arg) => !arg.startsWith("--"));
  const newPath = optionValue(args, "--by");
  if (!oldPath || !newPath) {
    console.error(
      'Usage: keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]',
    );
    process.exitCode = 1;
    return;
  }
  const date = optionValue(args, "--date");
  const result = await getService().supersede({
    cwd: process.cwd(),
    oldPath,
    newPath,
    ...(date ? { date } : {}),
  });

  if (result.securitySkipped) {
    console.log(`Supersede blocked by security gate: ${result.securitySkipped} (no files changed).`);
    process.exitCode = 1;
    return;
  }
  if (!result.changed) {
    console.log(`Already superseded: ${result.superseded} -> ${result.supersededBy} (no change).`);
    return;
  }
  console.log(`Superseded ${result.superseded} -> ${result.supersededBy}.`);
  console.log("Both entries remain on disk (non-destructive, git-diffable).");
}

async function runTransition(args: string[]): Promise<void> {
  const entryPath = args.find((arg) => !arg.startsWith("--"));
  const to = optionValue(args, "--to") as Exclude<MemoryStatus, "superseded"> | undefined;
  if (!entryPath || !to || !["draft", "accepted", "conflict", "deprecated"].includes(to)) {
    console.error("Usage: keryx memory transition <path> --to <draft|accepted|conflict|deprecated> [--reason <text>]");
    process.exitCode = 1;
    return;
  }
  const result = await getService().transition({ cwd: process.cwd(), path: entryPath, to, reason: optionValue(args, "--reason") });
  if (result.error || result.securitySkipped) {
    console.error(result.error?.message ?? `Transition blocked by security gate: ${result.securitySkipped}`);
    process.exitCode = 1;
    return;
  }
  console.log(result.changed ? `Transitioned ${result.path}: ${result.from} -> ${result.to}.` : `Already ${result.to}: ${result.path} (no change).`);
}

async function runIngest(args: string[]): Promise<void> {
  const flag = Object.keys(INGEST_FLAGS).find((f) => args.includes(f));
  if (!flag) {
    console.error("Usage: keryx memory ingest --from-<review|health|job|skill-verifier> <path>");
    process.exitCode = 1;
    return;
  }
  const source = INGEST_FLAGS[flag] ?? "job";
  const path = optionValue(args, flag);
  if (!path) {
    console.error(`Usage: keryx memory ingest ${flag} <path>`);
    process.exitCode = 1;
    return;
  }

  const result = await getService().ingest({ cwd: process.cwd(), source, path });
  console.log(
    `Ingested ${result.created.length} draft(s) from ${source}; reconciled ${result.reconciled.length}; skipped ${result.skippedDuplicates} duplicate(s).`,
  );
  for (const created of result.created) {
    console.log(`- created: ${created}`);
  }
  for (const updated of result.reconciled) {
    console.log(`- reconciled: ${updated}`);
  }
  if (result.conflicts.length > 0) {
    console.log("");
    console.log("Conflicts to review:");
    for (const conflict of result.conflicts) {
      console.log(`- ${conflict.path}: ${conflict.reason}`);
    }
  }
  if (result.securityWarnings && result.securityWarnings.length > 0) {
    console.log("");
    console.log("Security warnings:");
    for (const warning of result.securityWarnings) {
      console.log(`- ${warning}`);
    }
  }
  if (result.securitySkipped && result.securitySkipped.length > 0) {
    console.log("");
    console.log("Security-blocked entries (not written):");
    for (const skipped of result.securitySkipped) {
      console.log(`- ${skipped.title}: ${skipped.reason}`);
    }
  }
}

async function runCheck(): Promise<void> {
  const result = await getService().check({ cwd: process.cwd() });
  console.log("# memory check");
  console.log("");
  if (result.ok) {
    console.log("All checks passed.");
    return;
  }
  console.log(`issues: ${result.issues.length}`);
  console.log("");
  for (const issue of result.issues) {
    console.log(`- [${issue.kind}] ${issue.path}: ${issue.message}`);
  }
  process.exitCode = 1;
}

async function runReflect(args: string[] = []): Promise<void> {
  const config = await loadMemoryConfig(process.cwd());
  const result = await reflectMemory(process.cwd(), config, new Date());
  console.log("# memory reflect");
  console.log("");
  console.log(`clusters (>= ${config.reflect.minClusterSize}): ${result.clusters.length}`);
  console.log(`created pattern drafts: ${result.created.length} (skipped ${result.skippedExisting} existing)`);
  console.log("");
  for (const cluster of result.clusters) {
    console.log(`- ${cluster.tag}: ${cluster.members.length} entries`);
  }
  for (const created of result.created) {
    console.log(`  -> ${created}`);
  }

  if (args.includes("--narrate")) {
    const { narrate } = await import("../lib/narrate");
    console.log("");
    console.log("## Narration");
    await narrate({
      args,
      requestId: "memory-reflect",
      maxOutputTokens: 800,
      system:
        "You are a knowledge curator. Given clusters of related project memory entries, " +
        "summarize the recurring themes and propose which durable lessons/patterns are worth " +
        "consolidating. Be concise; do not invent entries beyond those listed.",
      user: `Reflection clusters:\n\`\`\`json\n${JSON.stringify(
        result.clusters.map((c) => ({ tag: c.tag, members: c.members.length })),
        null,
        2,
      )}\n\`\`\``,
    });
  }
}

function printHelp(): void {
  console.log(`keryx memory

Usage:
  keryx memory new <type> [slug] --title "<title>" [--force]
  keryx memory index [--embeddings]
  keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <semantic|episodic|procedural>] [--semantic] [--save-report]
                         # --as-of admits non-current entries too; each is
                         # marked HISTORICAL with its lifecycle state/reason
  keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]
  keryx memory transition <path> --to <draft|accepted|conflict|deprecated> [--reason <text>]
  keryx memory assets <list|verify|pull> [<id>]
  keryx memory ingest --from-<review|health|job|skill-verifier> <path>
  keryx memory check
  keryx memory reflect [--narrate] [--provider <p>]

Types:
  lesson, decision, constraint, known-mistake, historical-context, pattern,
  task-note, review-note, incident, migration-note, integration-note
`);
}

function positionalArgs(args: string[]): string[] {
  const valueOptions = new Set(["--module", "--entity", "--status", "--limit", "--as-of", "--class", "--provider"]);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value || value.startsWith("--")) {
      if (valueOptions.has(value ?? "")) index += 1;
      continue;
    }
    if (index > 0 && valueOptions.has(args[index - 1] ?? "")) continue;
    values.push(value);
  }
  return values;
}

function printMemoryValidationError(error: Error & { code?: string; field?: string; action?: string }, json: boolean): void {
  const payload = { code: error.code ?? "invalid-memory-input", field: error.field ?? "input", message: error.message, action: error.action ?? "Correct the value and try again." };
  if (json) {
    console.log(JSON.stringify({ error: payload }, null, 2));
  } else {
    console.error(`[${payload.code}] ${payload.field}: ${payload.message} Action: ${payload.action}`);
  }
}
