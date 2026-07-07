import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectEntries, memoryRoot } from "./store";
import type { MemoryConfig, MemoryEntry } from "./types";

// Deterministic consolidation: cluster entries by shared tag and, for clusters
// at or above the threshold, propose a `pattern` draft that links the members
// for a human/agent to synthesize into a higher-level lesson. LLM synthesis is
// out of scope; reflect surfaces the clusters worth consolidating.

export type ReflectCluster = { tag: string; members: string[] };
export type MemoryReflectResult = {
  clusters: ReflectCluster[];
  created: string[];
  skippedExisting: number;
};

export async function reflectMemory(
  cwd: string,
  config: MemoryConfig,
  now: Date,
): Promise<MemoryReflectResult> {
  const entries = await collectEntries(cwd);

  const byTag = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (entry.type === "pattern") {
      continue; // don't consolidate consolidations
    }
    for (const tag of entry.tags) {
      const key = tag.toLowerCase();
      byTag.set(key, [...(byTag.get(key) ?? []), entry]);
    }
  }

  const clusters: ReflectCluster[] = [];
  const created: string[] = [];
  let skippedExisting = 0;
  const dir = path.join(memoryRoot(cwd), "patterns");

  for (const [tag, members] of [...byTag.entries()].sort()) {
    if (members.length < config.reflect.minClusterSize) {
      continue;
    }
    clusters.push({ tag, members: members.map((m) => m.relativePath) });

    const slug = `pattern-${slugify(tag)}`;
    const file = path.join(dir, `${slug}.md`);
    if (existsSync(file)) {
      skippedExisting += 1;
      continue;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(file, buildPattern(tag, members, dateString(now)), "utf8");
    created.push(`patterns/${slug}.md`);
  }

  return { clusters, created, skippedExisting };
}

function buildPattern(tag: string, members: MemoryEntry[], date: string): string {
  const list = members.map((m) => `- [${m.title}](../${m.relativePath})`).join("\n");
  return `# Pattern: ${tag}

Version: 0.1.0
Type: pattern
Status: draft
Confidence: low

## Summary

Consolidates ${members.length} memory entries tagged \`${tag}\`. Review and synthesize a reusable pattern.

## Details

Related entries:

${list}

## Provenance

- Source: reflection
- Link:
- Created: ${date}
- Updated: ${date}

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- ${tag}
- reflection

## Changelog

- 0.1.0 - Reflected draft.
`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function dateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}
