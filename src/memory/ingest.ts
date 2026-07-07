import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { MEMORY_TYPES } from "./types";
import { collectEntries, memoryRoot } from "./store";
import { findConflicts, findDuplicates, type Candidate } from "./dedup";
import type {
  Confidence,
  MemoryConfig,
  MemoryIngestResult,
} from "./types";

const SOURCE_TYPE: Record<string, string> = {
  health: "known-mistake",
  review: "lesson",
  job: "lesson",
  "skill-verifier": "lesson",
};

const SOURCE_CONFIDENCE: Record<string, Confidence> = {
  health: "medium",
  review: "medium",
  job: "low",
  "skill-verifier": "medium",
};

export async function ingestMemory(
  cwd: string,
  source: string,
  filePath: string,
  config: MemoryConfig,
  now: Date,
): Promise<MemoryIngestResult> {
  const absolute = path.resolve(cwd, filePath);
  if (!(await pathExists(absolute))) {
    throw new Error(`Ingest source not found: ${filePath}`);
  }

  const content = await readFile(absolute, "utf8");
  const candidates = extractCandidates(content);
  const type = SOURCE_TYPE[source] ?? "lesson";
  const confidence = SOURCE_CONFIDENCE[source] ?? "low";
  const folder = MEMORY_TYPES.find((t) => t.type === type)?.folder ?? "lessons";

  const existing = await collectEntries(cwd);
  const created: string[] = [];
  const reconciled: string[] = [];
  const conflicts: MemoryIngestResult["conflicts"] = [];
  const createdTitles = new Set<string>();
  let skippedDuplicates = 0;

  const dir = path.join(memoryRoot(cwd), folder);
  const link = path.relative(cwd, absolute);
  const date = dateString(now);

  for (const text of candidates) {
    const title = toTitle(text);
    const candidate: Candidate = {
      title,
      summary: text,
      type,
      tags: [source],
      scopes: { module: null, entity: null, files: [] },
    };

    // Same title already created in this run -> skip (avoid twin drafts).
    if (createdTitles.has(title.toLowerCase())) {
      skippedDuplicates += 1;
      continue;
    }

    // Near-duplicate of an existing entry -> reconcile (Mem0-style UPDATE).
    const dupes = findDuplicates(candidate, existing, config);
    if (dupes.length > 0) {
      const match = existing.find((e) => e.relativePath === dupes[0]?.path);
      if (match) {
        const changed = await reconcileEntry(match.absolutePath, source, link, date);
        if (changed) {
          reconciled.push(match.relativePath);
        } else {
          skippedDuplicates += 1;
        }
      } else {
        skippedDuplicates += 1;
      }
      continue;
    }

    conflicts.push(...findConflicts(candidate, existing));

    const slug = uniqueSlug(dir, title);
    const filename = `${slug}.md`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, filename),
      buildEntryMarkdown({
        title,
        type,
        status: config.ingest.defaultStatus,
        confidence,
        summary: text,
        source,
        link,
        date,
      }),
      "utf8",
    );
    created.push(`${folder}/${filename}`);
    createdTitles.add(title.toLowerCase());
  }

  return { created, reconciled, skippedDuplicates, conflicts };
}

// Mem0-style UPDATE: append a provenance reconciliation note to an existing
// entry and bump its Updated date. Idempotent per (source, link, date).
async function reconcileEntry(
  absolutePath: string,
  source: string,
  link: string,
  date: string,
): Promise<boolean> {
  const content = await readFile(absolutePath, "utf8");
  const note = `- Reconciled: ${source} ${date}${link ? ` (${link})` : ""}`;
  if (content.includes(note)) {
    return false;
  }

  let next = content.replace(/^[-*]\s*Updated:.*$/m, `- Updated: ${date}\n${note}`);
  if (next === content) {
    next = content.replace(/(##\s+Provenance\s*\n)/, `$1\n${note}\n`);
  }
  if (next === content) {
    next = `${content.trimEnd()}\n\n## Provenance\n\n${note}\n`;
  }
  await writeFile(absolutePath, next, "utf8");
  return true;
}

function extractCandidates(content: string): string[] {
  const fromJson = extractJson(content);
  const pool = fromJson.length > 0 ? fromJson : extractMarkdown(content);
  return dedupeStrings(pool)
    .filter((text) => text.length >= 12 && text.length <= 260)
    .slice(0, 20);
}

function extractJson(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    return collectStrings(parsed);
  } catch {
    return [];
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = [
      record.message,
      record.summary,
      record.suggestedAction,
      record.recommendation,
      record.lesson,
      record.title,
    ].flatMap(collectStrings);
    const nested = Object.entries(record)
      .filter(
        ([key]) =>
          !["message", "summary", "suggestedAction", "recommendation", "lesson", "title"].includes(
            key,
          ),
      )
      .flatMap(([, nestedValue]) => collectStrings(nestedValue));
    return [...preferred, ...nested];
  }
  return [];
}

function extractMarkdown(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"));
}

function buildEntryMarkdown(input: {
  title: string;
  type: string;
  status: string;
  confidence: string;
  summary: string;
  source: string;
  link: string;
  date: string;
}): string {
  return `# ${input.title}

Version: 0.1.0
Type: ${input.type}
Status: ${input.status}
Confidence: ${input.confidence}

## Summary

${input.summary}

## Details

Ingested from ${input.source}. Review and expand.

## Provenance

- Source: ${input.source}
- Link: ${input.link}
- Created: ${input.date}
- Updated: ${input.date}

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- ${input.source}

## Changelog

- 0.1.0 - Ingested draft.
`;
}

function toTitle(text: string): string {
  const words = text.split(/\s+/).slice(0, 9).join(" ");
  return words.length > 0 ? words.replace(/[.:;,]+$/, "") : "Untitled";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function uniqueSlug(dir: string, title: string): string {
  const base = slugify(title) || "entry";
  let slug = base;
  let counter = 2;
  while (existsSync(path.join(dir, `${slug}.md`))) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()))].filter(Boolean);
}

function dateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}
