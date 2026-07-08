import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { MEMORY_CLASS_VALUES, MEMORY_TYPES, classForType } from "./types";
import type { Confidence, MemoryClass, MemoryEntry, MemoryStatus } from "./types";

const STATUSES = new Set<MemoryStatus>([
  "draft",
  "accepted",
  "deprecated",
  "conflict",
  "superseded",
]);
const CONFIDENCES = new Set<Confidence>(["low", "medium", "high"]);

export function memoryRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "memory");
}

export async function collectEntries(cwd: string): Promise<MemoryEntry[]> {
  const root = memoryRoot(cwd);
  const entries: MemoryEntry[] = [];

  for (const { type, folder } of MEMORY_TYPES) {
    const dir = path.join(root, folder);
    if (!(await pathExists(dir))) {
      continue;
    }
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const abs = path.join(dir, name);
      const content = await readFile(abs, "utf8");
      entries.push(parseEntry(abs, `${folder}/${name}`, type, content));
    }
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function parseEntry(
  absolutePath: string,
  relativePath: string,
  folderType: string,
  content: string,
): MemoryEntry {
  const lines = content.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  const sections = splitSections(lines);

  const status = normalizeStatus(field(lines, "Status"));
  const confidence = normalizeConfidence(field(lines, "Confidence"));
  const provenance = sections["Provenance"] ?? [];

  const type = field(lines, "Type") ?? folderType;
  const created = bulletField(provenance, "Created");
  // C2/C3 header fields (all optional; absence ⇒ null / class-by-type).
  const entryClass = normalizeClass(field(lines, "Class")) ?? classForType(type);
  const validFrom = field(lines, "Valid-From");
  const validTo = field(lines, "Valid-To");
  const recordedAt = field(lines, "Recorded-At") ?? created;
  const supersedes = field(lines, "Supersedes");
  const supersededBy = field(lines, "Superseded-By");

  return {
    absolutePath,
    relativePath,
    type,
    title: titleLine ? titleLine.slice(2).trim() : relativePath,
    version: field(lines, "Version"),
    status,
    confidence,
    summary: joinParagraph(sections["Summary"] ?? []),
    details: (sections["Details"] ?? []).join("\n").trim(),
    tags: bulletValues(sections["Tags"] ?? []),
    scopes: parseScopes(sections["Related Scopes"] ?? []),
    created,
    updated: bulletField(provenance, "Updated") ?? created,
    provenance: {
      source: bulletField(provenance, "Source"),
      link: bulletField(provenance, "Link"),
    },
    class: entryClass,
    validFrom,
    validTo,
    recordedAt,
    supersedes,
    supersededBy,
  };
}

function normalizeClass(value: string | null): MemoryClass | null {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  return MEMORY_CLASS_VALUES.includes(lower as MemoryClass)
    ? (lower as MemoryClass)
    : null;
}

function splitSections(lines: string[]): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1] ?? null;
      if (current) {
        sections[current] = [];
      }
      continue;
    }
    if (current) {
      sections[current]?.push(line);
    }
  }
  return sections;
}

function field(lines: string[], name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function bulletField(lines: string[], name: string): string | null {
  const pattern = new RegExp(`^[-*]\\s*${name}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function bulletValues(lines: string[]): string[] {
  return lines
    .map((line) => line.match(/^[-*]\s*(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function joinParagraph(lines: string[]): string {
  const collected: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    collected.push(line.trim());
  }
  const text = collected.join(" ").trim();
  return text === "Short summary." ? "" : text;
}

function parseScopes(lines: string[]): MemoryEntry["scopes"] {
  const module = bulletField(lines, "Module");
  const entity = bulletField(lines, "Entity");
  const files: string[] = [];
  const skills: string[] = [];
  let bucket: "files" | "skills" | null = null;

  for (const line of lines) {
    if (/^[-*]\s*Files:/i.test(line)) {
      bucket = "files";
      continue;
    }
    if (/^[-*]\s*Skills:/i.test(line)) {
      bucket = "skills";
      continue;
    }
    if (/^[-*]\s*(Module|Entity):/i.test(line)) {
      bucket = null;
      continue;
    }
    const nested = line.match(/^\s+[-*]\s*`?([^`]+)`?\s*$/);
    if (nested?.[1] && bucket) {
      (bucket === "files" ? files : skills).push(nested[1].trim());
    }
  }

  return { module, entity, files, skills };
}

function normalizeStatus(value: string | null): MemoryStatus {
  const lower = (value ?? "draft").toLowerCase();
  return STATUSES.has(lower as MemoryStatus) ? (lower as MemoryStatus) : "draft";
}

function normalizeConfidence(value: string | null): Confidence {
  const lower = (value ?? "medium").toLowerCase();
  return CONFIDENCES.has(lower as Confidence) ? (lower as Confidence) : "medium";
}
