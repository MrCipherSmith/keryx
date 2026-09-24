import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "../lib/fs";
import { userStorePaths } from "../lib/keryx-home";
import { splitLogicalLines } from "../lib/text-lines";
import { isMemoryHarnessId, parseHarnessList } from "./harness-identity";
import { MEMORY_CLASS_VALUES, MEMORY_TYPES, classForType } from "./types";
import type { Confidence, MemoryClass, MemoryEntry, MemoryStatus } from "./types";

const MEMORY_TYPE_FOLDERS: ReadonlySet<string> = new Set(MEMORY_TYPES.map((entry) => entry.folder));

// Flow 313 (W4) review R3-F3: `keryx init`'s memory scaffold writes these
// files/directories directly under the memory root — never inside a
// `MEMORY_TYPES` folder, so `collectEntriesStrict`'s "unexpected top-level
// content" walk (below) would otherwise report every initialized project's
// OWN scaffold as `unexpected-entry` forever, making `memory handoff`
// permanently `incomplete` (AC7 unreachable, including in this repo).
// `index.md` is `renderMemoryIndexScaffold()`, `templates/entry.md` is
// `renderMemoryEntryTemplate()` (both `./templates.ts`, written by
// `src/commands/init.ts`); `README.md` is reserved for a future scaffold
// file at the same root. These are KERYX-WRITTEN, recognised by exact
// relative path/prefix — never a wildcard — so arbitrary user content still
// gets reported exactly as before.
const MEMORY_SCAFFOLD_TOP_LEVEL_FILES: ReadonlySet<string> = new Set(["index.md", "README.md"]);

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
    // Flow 313 (W4) review R3-F10: `lstat`, never `pathExists`/`stat` (which
    // follow a symlink) — a memory-type folder that is ITSELF a symlink
    // (`decisions -> /outside`) must never be traversed, exactly like
    // `collectEntriesStrict`'s own type-folder check a few lines above in
    // this file. Pre-fix, this lenient path (which feeds `memory.search`,
    // `wiki.ask` and the MCP resources list) followed such a link and served
    // outside `*.md` content through every one of those callers even though
    // the strict scan already refused it — the two paths must agree.
    let dirStats;
    try {
      dirStats = await lstat(dir);
    } catch {
      continue; // Absent is fine — this scan's own pre-existing convention.
    }
    if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
      continue;
    }
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const abs = path.join(dir, name);
      // Flow 313 (W4) review R3-F9/R3-F10: this lenient path feeds
      // `memory.search`, `wiki.ask` and the MCP resources list — every one of
      // them a caller that must never hang or throw an unhandled EISDIR
      // because one memory-type folder holds a FIFO, a directory, a socket,
      // or a symlink named `*.md`. `readFile` on a FIFO blocks forever; a
      // symlink can serve content from OUTSIDE the memory root (the same
      // "restricted-to-one-harness" content could otherwise leak). `lstat`
      // (never `stat`, which follows the link) then a strict "regular file
      // only" check gives this lenient scan the SAME refusal
      // `collectEntriesStrict` already applies — an odd entry is skipped,
      // never opened, and never breaks the rest of the listing.
      let stats;
      try {
        stats = await lstat(abs);
      } catch {
        continue; // Vanished between readdir and lstat: nothing to serve.
      }
      if (!stats.isFile()) {
        continue;
      }
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
  | "misplaced-harness-header"
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
      // Flow 313 (W4) review R2-F5/R3-F7/R3-F8, choke point d: the SAME
      // `splitLogicalLines` `parseEntry` uses below, on the SAME raw
      // `content` — not a locally re-normalised copy — so this scan's own
      // `missing-title`/header checks can never disagree with what
      // `parseEntry` actually parsed from the same bytes.
      const lines = splitLogicalLines(content);
      let harnessInvalid = false;
      if (!lines.some((line) => line.startsWith("# "))) {
        problems.push({ path: relativePath, reason: "missing-title" });
      }
      // R2-F14: a Source-/Target-Harnesses line found OUTSIDE the header
      // block (below the first `## ` heading) is not "absent" — it is a
      // misplaced, invalid header, and the entry must be hidden from every
      // harness rather than left unrestricted for all of them.
      const sourceInfo = locateHeaderField(lines, "Source-Harness");
      if (sourceInfo.misplaced) {
        problems.push({ path: relativePath, reason: "misplaced-harness-header" });
        harnessInvalid = true;
      } else if (sourceInfo.nearInvalid) {
        // R3-F7: a near-miss key (case variant, missing hyphen, extra
        // whitespace, embedded zero-width character, fullwidth colon, or
        // the singular/plural slip) is present but unparsable — reported
        // the same way an actually-malformed value is, never silently
        // dropped as absent.
        problems.push({ path: relativePath, reason: "invalid-source-harness" });
        harnessInvalid = true;
      } else if (sourceInfo.matches.length > 1) {
        problems.push({ path: relativePath, reason: "duplicate-harness-header" });
        harnessInvalid = true;
      } else if (sourceInfo.matches.length === 1 && !entry.sourceHarness) {
        problems.push({ path: relativePath, reason: "invalid-source-harness" });
        harnessInvalid = true;
      }
      const targetInfo = locateHeaderField(lines, "Target-Harnesses");
      if (targetInfo.misplaced) {
        problems.push({ path: relativePath, reason: "misplaced-harness-header" });
        harnessInvalid = true;
      } else if (targetInfo.nearInvalid) {
        problems.push({ path: relativePath, reason: "invalid-target-harnesses" });
        harnessInvalid = true;
      } else if (targetInfo.matches.length > 1) {
        problems.push({ path: relativePath, reason: "duplicate-harness-header" });
        harnessInvalid = true;
      } else if (targetInfo.matches.length === 1 && entry.targetHarnesses === null) {
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
  } catch (error) {
    // R1-F5 remainder: the earlier root check only `lstat`s `root` (which
    // needs search/execute permission on `root`'s PARENT, not read
    // permission on `root` itself) — a root at mode 0300 (traversable,
    // unreadable) passes that check, so this `readdir` failure is the FIRST
    // and only place that permission gap is observed. Pre-fix this was
    // silently swallowed on the theory it was "already reported above",
    // which was false for exactly this mode; a root that vanished between
    // the earlier `lstat` and here (ENOENT) is a genuine race and stays
    // silent, but any other error (EACCES, EPERM, ...) is a named problem
    // that must never let `status` read as `"complete"`.
    if (!isNotFound(error)) {
      problems.push({ path: ".", reason: "unreadable-folder" });
    }
    return;
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
    // R3-F3: `keryx init`'s own memory scaffold (`index.md`, `README.md`,
    // `templates/`), only when it is the plain regular file/directory init
    // actually writes — never a same-named symlink or a directory standing
    // in for `index.md`, which fall through to the ordinary checks below and
    // are still reported exactly as before.
    if (stats.isDirectory()) {
      if (name === "templates") {
        continue;
      }
      await collectUnexpectedMarkdown(abs, name, problems);
    } else if (stats.isFile()) {
      if (MEMORY_SCAFFOLD_TOP_LEVEL_FILES.has(name)) {
        continue;
      }
      if (name.toLowerCase().endsWith(".md")) {
        problems.push({ path: name, reason: "unexpected-entry" });
      }
    }
  }
}

type HeaderFieldLocation = { matches: string[]; misplaced: boolean; nearInvalid: boolean };

// Flow 313 (W4) review R3-F7/R4 (round 4, generic fold): a header KEY is
// folded to its canonical comparison form by NFKC-normalising, lower-casing,
// then stripping EVERY codepoint that is not a Unicode letter or digit —
// not a hand-maintained list of "known separator" characters. This is
// deliberately broad rather than enumerating word separators (whitespace,
// underscore, the hyphen/dash family) one codepoint at a time: it folds
// those AND every other punctuation/markup wrapper the round-4 review found
// still slipping through (a "." separator, a zero-width joiner/space, a
// minus sign, a Markdown **bold**/backtick/blockquote/heading wrapper, an
// HTML comment) to the same result, because none of those characters is a
// letter or digit either. A true confusable homoglyph (a Cyrillic letter
// that LOOKS like Latin) is not folded by this — NFKC does not merge
// distinct scripts — and stays a known, documented gap (round-4 review
// R3-F7, still open).
function foldHeaderKey(rawKey: string): string {
  return rawKey
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// Flow 313 (W4) review R3-F8 (choke point d): the ONE shared set of folded
// forms that count as a `Source-Harness`/`Target-Harnesses` header key —
// used by BOTH `locateHeaderField` below (the parser) and
// `containsHarnessHeaderLine` (`./templates.ts`'s `memory.propose` guard),
// via the exported `isHarnessHeaderKey` below. Before this fix the guard had
// its own independent regex (`HARNESS_HEADER_LINE_RE` in `templates.ts`)
// that could and did drift from this fold — round 4's `p7b` probe wrote a
// singular `Target-Harness:`, a `Target-Harnesses` with a U+2010 hyphen and
// other near misses THROUGH the guard, which the parser then read as
// present-but-invalid and hid from every harness, wedging `memory handoff`
// incomplete. One canonical key set for both call sites closes that drift.
// Per-header-name folded forms — kept per-name (rather than one flat set)
// because `locateHeaderField` below still needs to know WHICH header a near
// miss belongs to. Each set includes the header's own canonical fold plus
// the one singular/plural slip the review's evidence named explicitly, so a
// well-formed `Source-Harness:`/`Target-Harnesses:` line and a near-miss
// spelling of it are recognised by the exact same comparison.
const HARNESS_HEADER_NAME_FOLDS: Readonly<Record<string, ReadonlySet<string>>> = {
  "Source-Harness": new Set(["sourceharness", "sourceharnesses"]),
  "Target-Harnesses": new Set(["targetharnesses", "targetharness"]),
};

const HARNESS_HEADER_FOLDED_KEYS: ReadonlySet<string> = new Set(
  Object.values(HARNESS_HEADER_NAME_FOLDS).flatMap((set) => Array.from(set)),
);

// Flow 313 (W4) review R3-F8: exported so `./templates.ts`'s
// `containsHarnessHeaderLine` guard folds a candidate header KEY through the
// exact same comparison the parser (`locateHeaderField` below) uses, instead
// of maintaining a second pattern that can silently drift from this one.
export function isHarnessHeaderKey(rawKey: string): boolean {
  return HARNESS_HEADER_FOLDED_KEYS.has(foldHeaderKey(rawKey));
}

// A generic "<key>: <value>" line shape, used only to extract the KEY text
// for near-match folding — matched against the line after NFKC
// normalisation, so a fullwidth colon (U+FF1A) is already an ASCII `:` by
// the time this runs.
const GENERIC_KEY_LINE_RE = /^\s*(.*?)\s*:\s*(.*)$/;

// Flow 313 (W4) review R3-F8: exported alongside `isHarnessHeaderKey` so a
// caller that only has a raw line (not yet split into key/value) — the
// `memory.propose` guard — extracts the same KEY text `locateHeaderField`
// extracts below, rather than re-deriving its own extraction regex.
export function extractHeaderKey(line: string): string | null {
  const generic = line.normalize("NFKC").match(GENERIC_KEY_LINE_RE);
  const key = generic?.[1] ?? "";
  return key.length > 0 ? key : null;
}

// Header-block-scoped scan: lines strictly before the first `## ` section
// heading (Flow 313 (W4) review R1-F3). Returns every RAW match for
// `<name>:` found in that block, trimmed — never reading `## Summary`/
// `## Details`/etc. content as the entry's real header, so a
// `Source-Harness:`/`Target-Harnesses:` line smuggled into free text (a
// proposal's `summary`/`details`, or a `title` rendered as the first line)
// is never read as the entry's real header. More than one match in the
// block means the header is present but AMBIGUOUS (a smuggled duplicate
// racing the stamped one) — callers treat that exactly like an unparsable
// value, never "first match wins".
//
// Flow 313 (W4) review R2-F14: a line matching `<name>:` found AFTER the
// first `## ` heading (i.e. inside a section body, not the header block) is
// reported separately as `misplaced` rather than being invisible to this
// scan the way pre-fix `headerBlockMatches` left it — that "invisible"
// behaviour is exactly the bug: a hand-authored `Target-Harnesses:` line
// placed below `## Summary` was silently read as absent, so the entry
// stayed visible to every harness instead of being treated as an invalid,
// hidden-from-everyone restriction. `misplaced: true` always overrides
// `matches` for callers — a misplaced header is invalid regardless of
// whether a well-formed one also exists in the block.
function locateHeaderField(lines: string[], name: string): HeaderFieldLocation {
  const sectionIndex = lines.findIndex((line) => /^##\s+/.test(line));
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "i");
  const nearFolds = HARNESS_HEADER_NAME_FOLDS[name] ?? new Set<string>();
  const matches: string[] = [];
  let misplaced = false;
  let nearInvalid = false;
  lines.forEach((line, index) => {
    const match = line.match(pattern);
    if (match) {
      if (sectionIndex === -1 || index < sectionIndex) {
        matches.push((match[1] ?? "").trim());
      } else {
        misplaced = true;
      }
      return;
    }
    // Flow 313 (W4) review R3-F7: the exact pattern above did not match —
    // before concluding the header is genuinely absent, check whether the
    // line's KEY nearly matches `name` (case variant, missing/extra hyphen,
    // extra whitespace, an embedded zero-width character, a fullwidth
    // colon, or the named singular/plural slip). A near-miss is NOT
    // "absent": it is present but invalid, and must hide the entry from
    // every harness the same way `misplaced` already does, rather than
    // silently falling through to the unrestricted default. Uses the SAME
    // `extractHeaderKey`/`foldHeaderKey` the `memory.propose` guard uses
    // (R3-F8) — one shared near-miss matcher, not two independently
    // drifting ones.
    const key = extractHeaderKey(line);
    if (!key || !nearFolds.has(foldHeaderKey(key))) {
      return;
    }
    nearInvalid = true;
    if (!(sectionIndex === -1 || index < sectionIndex)) {
      misplaced = true;
    }
  });
  return { matches, misplaced, nearInvalid };
}

export function parseEntry(
  absolutePath: string,
  relativePath: string,
  folderType: string,
  content: string,
): MemoryEntry {
  // Flow 313 (W4) review R2-F5/R3-F7/R3-F8, choke point d: the shared
  // splitter — idempotent when the caller (e.g. `collectEntriesStrict`)
  // already split on the same rule.
  const lines = splitLogicalLines(content);
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
  const sourceInfo = locateHeaderField(lines, "Source-Harness");
  const rawSourceHarness = sourceInfo.matches.length === 1 ? sourceInfo.matches[0] : null;
  const sourceHarness =
    !sourceInfo.misplaced && rawSourceHarness && isMemoryHarnessId(rawSourceHarness) ? rawSourceHarness : null;
  // R1-F14/R2-F14: "present but invalid" (present more than once, i.e.
  // ambiguous, OR present outside the header block, i.e. misplaced) is a
  // DIFFERENT state from "absent" — `sourceHarnessInvalid` keeps that
  // distinction visible to callers instead of collapsing all three to the
  // same `null`.
  const sourceHarnessInvalid =
    sourceInfo.misplaced || sourceInfo.nearInvalid || (sourceInfo.matches.length > 0 && !sourceHarness);

  const targetInfo = locateHeaderField(lines, "Target-Harnesses");
  const rawTargetHarnesses = targetInfo.matches.length === 1 ? targetInfo.matches[0] : null;
  const targetHarnesses =
    !targetInfo.misplaced && rawTargetHarnesses !== null ? parseHarnessList(rawTargetHarnesses) : null;
  // Same "present but invalid != absent" distinction as sourceHarnessInvalid
  // above — this is the flag `filterEntriesForHarness` (`./service.ts`) reads
  // to hide a malformed-restriction entry from EVERY harness (fail closed)
  // instead of the pre-fix behaviour of treating it as "unrestricted". A
  // misplaced Target-Harnesses line (R2-F14) is exactly such a malformed
  // restriction: it forces `targetHarnesses` to `null` above regardless of
  // any well-formed header also present in the block, and is flagged
  // invalid here so it is hidden from every harness rather than treated as
  // the back-compatible "no restriction" default.
  const targetHarnessesInvalid =
    targetInfo.misplaced || targetInfo.nearInvalid || (targetInfo.matches.length > 0 && targetHarnesses === null);

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
