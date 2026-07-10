import { createMemoryService } from "../memory/service";
import { loadMemoryConfig } from "../memory/config";
import { reflectMemory } from "../memory/reflect";
import { optionValue } from "../lib/args";
import { runAssetsSubcommand } from "../assets/command";
import { MEMORY_CLASS_VALUES } from "../memory/types";
import type { MemoryClass, MemoryStatus, SearchFilters } from "../memory/types";

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
    await runReflect();
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
}

async function runIndex(args: string[]): Promise<void> {
  const embeddings = args.includes("--embeddings");
  const result = await getService().index({ cwd: process.cwd(), embeddings });
  console.log(`Indexed ${result.entryCount} entries -> ${result.path}`);
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

async function runSearch(args: string[]): Promise<void> {
  const query = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!query) {
    console.error('Usage: keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>]');
    process.exitCode = 1;
    return;
  }

  const limitArg = optionValue(args, "--limit");
  const classArg = optionValue(args, "--class");
  if (classArg && !MEMORY_CLASS_VALUES.includes(classArg as MemoryClass)) {
    console.error(`Invalid --class: ${classArg}. Use one of: ${MEMORY_CLASS_VALUES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const filters: SearchFilters = {
    module: optionValue(args, "--module"),
    entity: optionValue(args, "--entity"),
    status: optionValue(args, "--status") as MemoryStatus | undefined,
    limit: limitArg ? Number(limitArg) : undefined,
    asOf: optionValue(args, "--as-of"),
    class: classArg as MemoryClass | undefined,
    semantic: args.includes("--semantic") ? true : undefined,
  };

  const result = await getService().search({ cwd: process.cwd(), query, filters });
  console.log(`# memory search: ${query}`);
  console.log("");
  console.log(`results: ${result.results.length}`);
  console.log("");
  for (const [i, item] of result.results.entries()) {
    console.log(
      `${i + 1}. [${item.score}] ${item.entry.title} (${item.entry.type}/${item.entry.status}) - ${item.entry.relativePath}`,
    );
  }
  console.log("");
  console.log(`report: ${result.markdownPath}`);
  console.log(`json: ${result.jsonPath}`);
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

async function runReflect(): Promise<void> {
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
}

function printHelp(): void {
  console.log(`keryx memory

Usage:
  keryx memory new <type> [slug] --title "<title>" [--force]
  keryx memory index [--embeddings]
  keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <semantic|episodic|procedural>] [--semantic]
  keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]
  keryx memory assets <list|verify|pull> [<id>]
  keryx memory ingest --from-<review|health|job|skill-verifier> <path>
  keryx memory check
  keryx memory reflect

Types:
  lesson, decision, constraint, known-mistake, historical-context, pattern,
  task-note, review-note, incident, migration-note, integration-note
`);
}
