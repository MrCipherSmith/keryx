import { createMemoryService } from "../memory/service";
import { loadMemoryConfig } from "../memory/config";
import { reflectMemory } from "../memory/reflect";
import type { MemoryStatus, SearchFilters } from "../memory/types";

const service = createMemoryService();

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
    await runIndex();
    return;
  }
  if (command === "search") {
    await runSearch(args.slice(1));
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
    console.error('Usage: gd-metapro memory new <type> [slug] --title "<title>" [--force]');
    process.exitCode = 1;
    return;
  }
  const slug = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const result = await service.create({
    cwd: process.cwd(),
    type,
    slug,
    title: valueAfter(args, "--title"),
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

async function runIndex(): Promise<void> {
  const result = await service.index({ cwd: process.cwd() });
  console.log(`Indexed ${result.entryCount} entries -> ${result.path}`);
}

async function runSearch(args: string[]): Promise<void> {
  const query = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!query) {
    console.error('Usage: gd-metapro memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>]');
    process.exitCode = 1;
    return;
  }

  const limitArg = valueAfter(args, "--limit");
  const filters: SearchFilters = {
    module: valueAfter(args, "--module"),
    entity: valueAfter(args, "--entity"),
    status: valueAfter(args, "--status") as MemoryStatus | undefined,
    limit: limitArg ? Number(limitArg) : undefined,
  };

  const result = await service.search({ cwd: process.cwd(), query, filters });
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

async function runIngest(args: string[]): Promise<void> {
  const flag = Object.keys(INGEST_FLAGS).find((f) => args.includes(f));
  if (!flag) {
    console.error("Usage: gd-metapro memory ingest --from-<review|health|job|skill-verifier> <path>");
    process.exitCode = 1;
    return;
  }
  const source = INGEST_FLAGS[flag] ?? "job";
  const path = valueAfter(args, flag);
  if (!path) {
    console.error(`Usage: gd-metapro memory ingest ${flag} <path>`);
    process.exitCode = 1;
    return;
  }

  const result = await service.ingest({ cwd: process.cwd(), source, path });
  console.log(`Ingested ${result.created.length} draft(s) from ${source}; skipped ${result.skippedDuplicates} duplicate(s).`);
  for (const created of result.created) {
    console.log(`- ${created}`);
  }
  if (result.conflicts.length > 0) {
    console.log("");
    console.log("Conflicts to review:");
    for (const conflict of result.conflicts) {
      console.log(`- ${conflict.path}: ${conflict.reason}`);
    }
  }
}

async function runCheck(): Promise<void> {
  const result = await service.check({ cwd: process.cwd() });
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

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`gd-metapro memory

Usage:
  gd-metapro memory new <type> [slug] --title "<title>" [--force]
  gd-metapro memory index
  gd-metapro memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>]
  gd-metapro memory ingest --from-<review|health|job|skill-verifier> <path>
  gd-metapro memory check
  gd-metapro memory reflect

Types:
  lesson, decision, constraint, known-mistake, historical-context, pattern,
  task-note, review-note, incident, migration-note, integration-note
`);
}
