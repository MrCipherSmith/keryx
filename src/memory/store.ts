import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, pathExists } from "../lib/fs";
import { userStorePaths } from "../lib/keryx-home";
import { isMemoryHarnessId, parseHarnessList } from "./harness-identity";
import { MEMORY_CLASS_VALUES, MEMORY_TYPES, classForType } from "./types";
import type { Confidence, MemoryClass, MemoryEntry, MemoryStatus } from "./types";

const MEMORY_TYPE_FOLDERS: ReadonlySet<string> = new Set(MEMORY_TYPES.map((entry) => entry.folder));

// Flow 313 (W4) review R1-F5/F27: a strict-mode UTF-8 decoder. `readFile(...,
// "utf8")` silently replaces invalid byte sequences (U+FFFD) rather than
// reporting them — an entry with truncated/corrupt bytes would read as
// "complete" with mangled content instead of a named `unreadable-file`
// problem. `fatal: true` throws instead, which the strict scan below turns
// into that problem.
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeStrictUtf8(bytes: Buffer): string {
  return STRICT_UTF8_DECODER.decode(bytes);
}

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
  | "duplicate-harness-header"
  | "not-a-regular-file"
  | "unexpected-entry";

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

  // R1-F5: `lstat` the root itself, never `pathExists`/`stat` (which follow
  // symlinks and, for `pathExists`, swallow EACCES as "absent" — the exact
  // "unreadable root reports complete" bug). Only ENOENT means "there is
  // nothing to scan yet"; anything else is a named, incomplete refusal.
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if (isNotFound(error)) {
      return { status: "complete", entries: [], problems: [] };
    }
    return { status: "incomplete", entries: [], problems: [{ path: ".", reason: "unreadable-folder" }] };
  }
  if (rootStats.isSymbolicLink()) {
    return { status: "incomplete", entries: [], problems: [{ path: ".", reason: "not-a-regular-file" }] };
  }
  if (!rootStats.isDirectory()) {
    return { status: "incomplete", entries: [], problems: [{ path: ".", reason: "not-a-regular-file" }] };
  }

  for (const { type, folder } of MEMORY_TYPES) {
    const dir = path.join(root, folder);
    let dirStats;
    try {
      dirStats = await lstat(dir);
    } catch (error) {
      if (isNotFound(error)) {
        continue; // Absent is fine — collectEntries's own tolerant convention.
      }
      problems.push({ path: `${folder}/`, reason: "unreadable-folder" });
      continue;
    }
    if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
      // A symlinked type folder (live or dangling) is never traversed: this
      // is exactly the "dangling symlink for a type folder is silently
      // skipped" gap (R1-F5) and the "symlinked folder pointing outside the
      // root is scanned" gap (R1-F27) closed the same way — refuse before
      // ever resolving the link's target.
      problems.push({ path: `${folder}/`, reason: "not-a-regular-file" });
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
      const relativePath = `${folder}/${name}`;
      const abs = path.join(dir, name);
      let entryStats;
      try {
        entryStats = await lstat(abs);
      } catch {
        problems.push({ path: relativePath, reason: "unreadable-file" });
        continue;
      }
      if (entryStats.isSymbolicLink()) {
        // Never followed, live or dangling target: R1-F27 (symlinked memory
        // file reading content from outside the root).
        problems.push({ path: relativePath, reason: "not-a-regular-file" });
        continue;
      }
      if (entryStats.isDirectory()) {
        // A nested directory inside a type folder (`lessons/sub/`) is not a
        // memory entry; report anything `.md` under it rather than silently
        // ignoring the subtree (R1-F27 "nested folders").
        await collectUnexpectedMarkdown(abs, relativePath, problems);
        continue;
      }
      if (!entryStats.isFile()) {
        problems.push({ path: relativePath, reason: "not-a-regular-file" });
        continue;
      }
      if (!name.endsWith(".md")) {
        if (name.toLowerCase().endsWith(".md")) {
          // A case variant of the canonical extension (`.MD`) is never
          // silently accepted or silently ignored — flagged and excluded,
          // mirroring this codebase's other case-insensitive-refusal
          // conventions (R1-F27).
          problems.push({ path: relativePath, reason: "unexpected-entry" });
        }
        continue;
      }
      let raw: Buffer;
      try {
        raw = await readFile(abs);
      } catch {
        problems.push({ path: relativePath, reason: "unreadable-file" });
        continue;
      }
      let content: string;
      try {
        content = decodeStrictUtf8(raw);
      } catch {
        problems.push({ path: relativePath, reason: "unreadable-file" });
        continue;
      }
      const entry = parseEntry(abs, relativePath, type, content);
      const lines = content.split("\n");
      let harnessInvalid = false;
      if (!lines.some((line) => line.startsWith("# "))) {
        problems.push({ path: relativePath, reason: "missing-title" });
      }
      const sourceMatches = headerBlockMatches(lines, "Source-Harness");
      if (sourceMatches.length > 1) {
        problems.push({ path: relativePath, reason: "duplicate-harness-header" });
        harnessInvalid = true;
      } else if (sourceMatches.length === 1 && !entry.sourceHarness) {
        problems.push({ path: relativePath, reason: "invalid-source-harness" });
        harnessInvalid = true;
      }
      const targetMatches = headerBlockMatches(lines, "Target-Harnesses");
      if (targetMatches.length > 1) {
        problems.push({ path: relativePath, reason: "duplicate-harness-header" });
        harnessInvalid = true;
      } else if (targetMatches.length === 1 && entry.targetHarnesses === null) {
        problems.push({ path: relativePath, reason: "invalid-target-harnesses" });
        harnessInvalid = true;
      }
      // R1-F14: a present-but-invalid Source-Harness/Target-Harnesses must
      // not read as "absent" (which would be visible/handoff-eligible to
      // everyone). Excluded from `entries` here — still named in `problems`
      // — rather than silently included with a misleading null.
      if (!harnessInvalid) {
        entries.push(entry);
      }
    }
  }

  // R1-F27: a `.md` file sitting in a folder that is not one of the known
  // memory types (e.g. `misc/`) is never silently invisible — walked and
  // reported the same way a nested subfolder is, above.
  await collectUnexpectedTopLevel(root, problems);

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { status: problems.length === 0 ? "complete" : "incomplete", entries, problems };
}

// Walks a directory that is NOT a recognized memory-type folder (a nested
// subdirectory inside one, or an unrelated top-level folder) and reports
// every `.md`/`.MD` file found under it as `unexpected-entry`, without ever
// following a symlink.
async function collectUnexpectedMarkdown(
  dir: string,
  relativeDir: string,
  problems: MemoryScanProblem[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    problems.push({ path: `${relativeDir}/`, reason: "unreadable-folder" });
    return;
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    const relativePath = `${relativeDir}/${name}`;
    let stats;
    try {
      stats = await lstat(abs);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      continue; // Never followed; not reachable as memory content either way.
    }
    if (stats.isDirectory()) {
      await collectUnexpectedMarkdown(abs, relativePath, problems);
      continue;
    }
    if (stats.isFile() && name.toLowerCase().endsWith(".md")) {
      problems.push({ path: relativePath, reason: "unexpected-entry" });
    }
  }
}

// Top-level entries of `root` that are not one of `MEMORY_TYPES`'s folders.
async function collectUnexpectedTopLevel(root: string, problems: MemoryScanProblem[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return; // Already reported (or root is unreadable, reported above).
  }
  for (const name of names) {
    if (MEMORY_TYPE_FOLDERS.has(name)) {
      continue;
    }
    const abs = path.join(root, name);
    let stats;
    try {
      stats = await lstat(abs);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      await collectUnexpectedMarkdown(abs, name, problems);
    } else if (stats.isFile() && name.toLowerCase().endsWith(".md")) {
      problems.push({ path: name, reason: "unexpected-entry" });
    }
  }
}

// Header-block-scoped scan: lines strictly before the first `## ` section
// heading (Flow 313 (W4) review R1-F3). Returns every RAW match for
// `<name>:` found in that block, trimmed — never scanning `## Summary`/
// `## Details`/etc. content, so a `Source-Harness:`/`Target-Harnesses:` line
// smuggled into free text (a proposal's `summary`/`details`, or a `title`
// rendered as the first line) is never read as the entry's real header.
// More than one match in the block means the header is present but
// AMBIGUOUS (a smuggled duplicate racing the stamped one) — callers treat
// that exactly like an unparsable value, never "first match wins".
function headerBlockMatches(lines: string[], name: string): string[] {
  const block = headerBlockLines(lines);
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "i");
  const matches: string[] = [];
  for (const line of block) {
    const match = line.match(pattern);
    if (match) {
      matches.push((match[1] ?? "").trim());
    }
  }
  return matches;
}

function headerBlockLines(lines: string[]): string[] {
  const sectionIndex = lines.findIndex((line) => /^##\s+/.test(line));
  return sectionIndex === -1 ? lines : lines.slice(0, sectionIndex);
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
  // Flow 313 (W4) / R1-F3: tolerant, matching this file's existing
  // convention — absent or unparseable -> null, never thrown. Restricted to
  // the HEADER BLOCK (before the first `## ` section) via
  // `headerBlockMatches`, never the generic all-lines `field()` — a
  // `Source-Harness:`/`Target-Harnesses:` line smuggled into `## Summary`/
  // `## Details` (or into a `title` whose injected line ends up above the
  // first section) is invisible to this parse, not merely "first match
  // wins" over the real one.
  const sourceHarnessMatches = headerBlockMatches(lines, "Source-Harness");
  const rawSourceHarness = sourceHarnessMatches.length === 1 ? sourceHarnessMatches[0] : null;
  const sourceHarness = rawSourceHarness && isMemoryHarnessId(rawSourceHarness) ? rawSourceHarness : null;
  // R1-F14: "present but invalid" (including "present more than once", i.e.
  // ambiguous) is a DIFFERENT state from "absent" — `sourceHarnessInvalid`
  // keeps that distinction visible to callers instead of collapsing both to
  // the same `null`.
  const sourceHarnessInvalid = sourceHarnessMatches.length > 0 && !sourceHarness;

  const targetHarnessesMatches = headerBlockMatches(lines, "Target-Harnesses");
  const rawTargetHarnesses = targetHarnessesMatches.length === 1 ? targetHarnessesMatches[0] : null;
  const targetHarnesses = rawTargetHarnesses !== null ? parseHarnessList(rawTargetHarnesses) : null;
  // Same "present but invalid != absent" distinction as sourceHarnessInvalid
  // above — this is the flag `filterEntriesForHarness` (`./service.ts`) reads
  // to hide a malformed-restriction entry from EVERY harness (fail closed)
  // instead of the pre-fix behaviour of treating it as "unrestricted".
  const targetHarnessesInvalid = targetHarnessesMatches.length > 0 && targetHarnesses === null;

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
    sourceHarnessInvalid,
    targetHarnessesInvalid,
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
