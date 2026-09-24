import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { userStorePaths } from "../lib/keryx-home";
import { isMemoryHarnessId, parseHarnessList } from "./harness-identity";
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

/**
 * Flow 313 (W4): resolves the memory root for a given scope. `"project"` is
 * the existing `memoryRoot(cwd)`; `"user"` is `~/.keryx/memory` via the
 * shared `userStorePaths` resolver (same env/homeDir override semantics as
 * every other user-store path).
 */
export function memoryRootFor(
  scope: "project" | "user",
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return scope === "user" ? userStorePaths(env, homeDir).memory : memoryRoot(cwd);
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

export type MemoryScanProblemReason =
  | "unreadable-folder"
  | "unreadable-file"
  | "missing-title"
  | "invalid-source-harness"
  | "invalid-target-harnesses"
  | "not-a-regular-file";

export type MemoryScanProblem = { path: string; reason: MemoryScanProblemReason };

export type MemoryStrictScanResult = {
  status: "complete" | "incomplete";
  entries: MemoryEntry[];
  problems: MemoryScanProblem[];
};

/**
 * Flow 313 (W4) / W4-portability.md fail-closed rule 1: walks the same
 * `MEMORY_TYPES` folders as `collectEntries`, but under an arbitrary memory
 * `root` (project or user scope), and never silently drops a problem into a
 * shorter-but-clean-looking result. Any folder it cannot list, any file it
 * cannot read, any entry missing its title, or any entry whose
 * `Source-Harness`/`Target-Harnesses` header does not parse is recorded as a
 * named problem AND makes the overall `status` `"incomplete"` — the caller
 * must not treat `entries` as a complete set when `status` is `"incomplete"`.
 * `collectEntries`'s tolerant (folder-missing-is-fine, malformed-field-is-
 * null) behaviour for the ordinary CLI/search path is unchanged; this is a
 * separate, stricter function for the cross-harness handoff read path only.
 */
export async function collectEntriesStrict(root: string): Promise<MemoryStrictScanResult> {
  const entries: MemoryEntry[] = [];
  const problems: MemoryScanProblem[] = [];

  for (const { type, folder } of MEMORY_TYPES) {
    const dir = path.join(root, folder);
    if (!(await pathExists(dir))) {
      continue;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      problems.push({ path: `${folder}/`, reason: "unreadable-folder" });
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const relativePath = `${folder}/${name}`;
      const abs = path.join(dir, name);
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        problems.push({ path: relativePath, reason: "unreadable-file" });
        continue;
      }
      const entry = parseEntry(abs, relativePath, type, content);
      if (!content.split("\n").some((line) => line.startsWith("# "))) {
        problems.push({ path: relativePath, reason: "missing-title" });
      }
      if (headerPresentButInvalid(content, "Source-Harness", entry.sourceHarness ?? null)) {
        problems.push({ path: relativePath, reason: "invalid-source-harness" });
      }
      if (headerPresentButInvalid(content, "Target-Harnesses", entry.targetHarnesses ? "present" : null)) {
        problems.push({ path: relativePath, reason: "invalid-target-harnesses" });
      }
      entries.push(entry);
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { status: problems.length === 0 ? "complete" : "incomplete", entries, problems };
}

// True when the raw header line is present in `content` but the parsed value
// came back null/falsy — i.e. the field exists but failed to parse, distinct
// from the field simply being absent.
function headerPresentButInvalid(content: string, name: string, parsed: string | null): boolean {
  const raw = field(content.split("\n"), name);
  return raw !== null && !parsed;
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
  // AFC-25 / AC6 (flow 234): who wrote/proposed the claim, the confirming
  // participant / acceptance basis, and a deferral or qualification caveat
  // attached to the claim. Follows the file's existing conventions: Author
  // and Confirmed-By are provenance bullets alongside Source/Link, Caveat is
  // a top-level "Name: value" header field like Version/Status. Absent ⇒
  // null, resolved to the explicit "unknown" sentinel downstream (report.ts),
  // never silently dropped.
  const author = bulletField(provenance, "Author");
  const confirmedBy = bulletField(provenance, "Confirmed-By");
  const caveat = field(lines, "Caveat");
  // C2/C3 header fields (all optional; absence ⇒ null / class-by-type).
  const entryClass = normalizeClass(field(lines, "Class")) ?? classForType(type);
  const validFrom = field(lines, "Valid-From");
  const validTo = field(lines, "Valid-To");
  const recordedAt = field(lines, "Recorded-At") ?? created;
  const supersedes = field(lines, "Supersedes");
  const supersededBy = field(lines, "Superseded-By");
  // Flow 313 (W4): tolerant, matching this file's existing convention —
  // absent or unparseable -> null, never thrown.
  const rawSourceHarness = field(lines, "Source-Harness");
  const sourceHarness = rawSourceHarness && isMemoryHarnessId(rawSourceHarness) ? rawSourceHarness : null;
  const targetHarnesses = parseHarnessList(field(lines, "Target-Harnesses"));

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
    author,
    confirmedBy,
    caveat,
    class: entryClass,
    validFrom,
    validTo,
    recordedAt,
    supersedes,
    supersededBy,
    sourceHarness,
    targetHarnesses,
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
