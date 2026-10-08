// Page invariants every wiki writer must keep (flow 367, AC5-AC9).
//
// A real enrich run on a 504-page wiki dropped `## Changelog` from 6 pages,
// reworded machine-written attestation entries on 5 and left `Version` behind
// the changelog on 2, and `wiki collect --force` replaced enriched pages with
// the generated stub. Each of these was invisible to `wiki validate`. The
// rules, in one place so the writers and `validate` agree:
//
// - an existing `## Changelog` section is never removed;
// - an existing changelog entry is never removed or reworded (it is history,
//   and some entries are attestations written by tools);
// - `Version` is never lower than the newest changelog entry's version;
// - a front-matter key the page had is never dropped;
// - a managed Reference block the page had is never dropped;
// - no section is duplicated by a write.
//
// Writers keep them by construction (`preserveEnrichInvariants`,
// `mergeGeneratedSections`) and then check: a page that still violates one is
// not written.
//
// Every reader here works on LF text and skips fenced code blocks, so a CRLF
// page or a `## Changelog` shown inside a fence is read for what it is; the
// writers hand the result back in the page's own line endings (review r1
// L-004, L-005, T-003).

import { findManagedBlock, replaceManagedBlock } from "./managed-block";

export type InvariantKind =
  | "changelog-dropped"
  | "changelog-entry-altered"
  | "version-behind-changelog"
  | "frontmatter-key-dropped"
  | "managed-block-dropped"
  | "section-duplicated";

export interface InvariantViolation {
  kind: InvariantKind;
  detail: string;
}

export interface ChangelogEntry {
  /** The entry as written, trimmed: its bullet line plus continuation lines. */
  text: string;
  /** The version the entry starts with, when it has one. */
  version: string | null;
}

const CHANGELOG_HEADING = /^##\s+Changelog\s*$/i;
const SECTION_HEADING = /^#{1,2}\s/;
const H2 = /^##\s+(.+?)\s*$/;
const ENTRY_START = /^[-*]\s+/;
const ENTRY_VERSION = /^[-*]\s+v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/;
/** Legacy pages carry metadata as plain `Key: value` lines under the H1. */
const LEGACY_META_KEYS = new Set([
  "title",
  "version",
  "type",
  "status",
  "summary",
  "verifiedat",
  "verifiedscope",
  "validfrom",
  "validto",
  "supersededby",
]);

// ---------------------------------------------------------------------------
// Text: LF lines, and which of them sit inside a fenced code block.
// ---------------------------------------------------------------------------

function toLf(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/** `lfText` in the line endings `like` uses. */
function inEolOf(like: string, lfText: string): string {
  return like.includes("\r\n") ? lfText.replace(/\n/g, "\r\n") : lfText;
}

function lines(markdown: string): string[] {
  return toLf(markdown).split("\n");
}

/** True for every line inside a ``` / ~~~ fence, the fence lines included. */
function fencedLines(all: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let open: { char: string; length: number } | null = null;
  for (const line of all) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (fence) open = { char: fence[1]![0]!, length: fence[1]!.length };
      mask.push(fence !== null);
      continue;
    }
    mask.push(true);
    if (fence && fence[1]![0] === open.char && fence[1]!.length >= open.length && fence[2]!.trim() === "") {
      open = null;
    }
  }
  return mask;
}

/** Index of the first line at or after `from` matching `test` outside any fence. */
function findLine(all: readonly string[], mask: readonly boolean[], test: (line: string) => boolean, from = 0): number {
  for (let index = from; index < all.length; index += 1) {
    if (!mask[index] && test(all[index]!)) return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Versions.
// ---------------------------------------------------------------------------

/** `x.y.z`, `x.y` (patch 0) or either with a `-pre`/`+build` suffix (ignored). */
function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** Semver-style compare; an unparseable version sorts lowest. */
export function compareVersions(a: string | null, b: string | null): number {
  const left = a === null ? null : versionParts(a);
  const right = b === null ? null : versionParts(b);
  if (left === null || right === null) return left === null ? (right === null ? 0 : -1) : 1;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

/** Patch-only bump; a mechanical write is never minor or major. */
export function bumpPatch(version: string | null): string {
  const parts = version === null ? null : versionParts(version);
  if (parts === null) return "0.1.1";
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

// ---------------------------------------------------------------------------
// Front matter: a leading `---` YAML block, or legacy `Key: value` lines
// between the H1 and the first `##` heading.
// ---------------------------------------------------------------------------

/** Line range [start, end) holding the page's metadata, or null. */
function metadataRange(all: string[]): { start: number; end: number; yaml: boolean } | null {
  let first = 0;
  while (first < all.length && all[first]!.trim() === "") first += 1;
  if (all[first]?.trim() === "---") {
    for (let index = first + 1; index < all.length; index += 1) {
      if (all[index]!.trim() === "---") return { start: first + 1, end: index, yaml: true };
    }
    return null;
  }
  const firstSection = findLine(all, fencedLines(all), (line) => /^##\s/.test(line));
  return { start: first, end: firstSection < 0 ? all.length : firstSection, yaml: false };
}

/** Lower-cased metadata keys the page declares. */
export function frontmatterKeys(markdown: string): string[] {
  const all = lines(markdown);
  const range = metadataRange(all);
  if (range === null) return [];
  const keys: string[] = [];
  for (const line of all.slice(range.start, range.end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (range.yaml || LEGACY_META_KEYS.has(key)) keys.push(key);
  }
  return keys;
}

export function pageVersion(markdown: string): string | null {
  const all = lines(markdown);
  const range = metadataRange(all);
  if (range === null) return null;
  for (const line of all.slice(range.start, range.end)) {
    const match = /^Version:\s*["']?([^"'\s]+)["']?\s*$/i.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Set the Version value inside the metadata only, keeping the key's own
 * spelling and quoting (`version: "1.0.0"` stays lower-case and quoted). A page
 * without one is left as it is. Expects LF text.
 */
function setPageVersion(markdown: string, version: string): string {
  const all = markdown.split("\n");
  const range = metadataRange(all);
  if (range === null) return markdown;
  for (let index = range.start; index < range.end; index += 1) {
    const match = /^(Version:\s*)(["']?)[^"'\s]*(["']?)(.*)$/i.exec(all[index]!);
    if (match) {
      all[index] = `${match[1]}${match[2]}${version}${match[3]}${match[4]}`;
      return all.join("\n");
    }
  }
  return markdown;
}

// ---------------------------------------------------------------------------
// Changelog.
// ---------------------------------------------------------------------------

/** Line range [heading, end) of the `## Changelog` section outside fences, or null. */
function changelogRange(all: string[]): { heading: number; end: number } | null {
  const mask = fencedLines(all);
  const heading = findLine(all, mask, (line) => CHANGELOG_HEADING.test(line.trim()));
  if (heading < 0) return null;
  const next = findLine(all, mask, (line) => SECTION_HEADING.test(line), heading + 1);
  return { heading, end: next < 0 ? all.length : next };
}

/** The page's changelog entries in page order, or null when it has no section. */
export function parseChangelog(markdown: string): ChangelogEntry[] | null {
  const all = lines(markdown);
  const range = changelogRange(all);
  if (range === null) return null;
  const mask = fencedLines(all);
  const entries: ChangelogEntry[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (current === null) return;
    const text = current.join("\n").trim();
    entries.push({ text, version: ENTRY_VERSION.exec(text)?.[1] ?? null });
    current = null;
  };
  for (let index = range.heading + 1; index < range.end; index += 1) {
    const line = all[index]!;
    if (mask[index]) {
      // A code block inside an entry belongs to it; one between entries is not one.
      if (current !== null) current.push(line);
    } else if (ENTRY_START.test(line)) {
      flush();
      current = [line];
    } else if (line.trim() === "") {
      flush();
    } else if (current !== null) {
      current.push(line);
    }
  }
  flush();
  return entries;
}

export function newestChangelogVersion(entries: readonly ChangelogEntry[] | null): string | null {
  let newest: string | null = null;
  for (const entry of entries ?? []) {
    if (entry.version !== null && compareVersions(entry.version, newest) > 0) newest = entry.version;
  }
  return newest;
}

/** The version the next write should carry: one patch above both Version and the changelog. */
export function nextPageVersion(markdown: string): string {
  const current = pageVersion(markdown);
  const newest = newestChangelogVersion(parseChangelog(markdown));
  return bumpPatch(compareVersions(newest, current) > 0 ? newest : current);
}

/**
 * Insert `entry` as the newest changelog entry, creating the section when
 * missing. It goes directly above the first existing entry — never after an
 * intro sentence or onto the next heading — with a blank line after it only
 * when the page already separates its entries with one (review r1 L-007).
 * Expects LF text.
 */
function prependChangelogEntry(markdown: string, entry: string): string {
  const all = markdown.split("\n");
  const range = changelogRange(all);
  if (range === null) return `${markdown.replace(/\s+$/, "")}\n\n## Changelog\n\n${entry}\n`;
  const mask = fencedLines(all);
  const first = findLine(all, mask, (line) => ENTRY_START.test(line), range.heading + 1);
  if (first >= 0 && first < range.end) {
    let after = first + 1;
    while (after < range.end && all[after]!.trim() !== "" && !ENTRY_START.test(all[after]!)) after += 1;
    let next = after;
    while (next < range.end && all[next]!.trim() === "") next += 1;
    const spaced = after < range.end && all[after]!.trim() === "" && next < range.end && ENTRY_START.test(all[next]!);
    all.splice(first, 0, ...(spaced ? [entry, ""] : [entry]));
    return all.join("\n");
  }
  // No entry yet: after whatever the section says, set off by blank lines.
  let insert = range.end;
  while (insert > range.heading + 1 && all[insert - 1]!.trim() === "") insert -= 1;
  // A blank line after the entry only if one is not there already.
  all.splice(insert, 0, "", entry, ...(insert < all.length && all[insert]!.trim() !== "" ? [""] : []));
  return all.join("\n");
}

/**
 * Put the changelog newest-first and lift Version to the newest entry. Pages
 * written by older keryx releases carry their changelog oldest-first (the
 * generated `0.1.0` on top, enrichment entries below) with `Version: 0.1.0`;
 * inserting one more entry above that leaves the log out of order and Version
 * behind it. Entries are moved whole and never reworded, and a log with an
 * entry that names no version is left in the order the page has. Expects LF.
 */
function repairVersionAndOrder(markdown: string): string {
  let next = markdown;
  const all = next.split("\n");
  const range = changelogRange(all);
  if (range !== null) {
    const mask = fencedLines(all);
    const starts: number[] = [];
    for (let index = range.heading + 1; index < range.end; index += 1) {
      if (!mask[index] && ENTRY_START.test(all[index]!)) starts.push(index);
    }
    const chunks = starts.map((start, position) => {
      const end = position + 1 < starts.length ? starts[position + 1]! : range.end;
      const body = all.slice(start, end);
      while (body.length > 1 && body[body.length - 1]!.trim() === "") body.pop();
      return { body, version: ENTRY_VERSION.exec(body[0]!)?.[1] ?? null };
    });
    const ordered = chunks.every((chunk) => chunk.version !== null)
      ? [...chunks].sort((left, right) => compareVersions(right.version, left.version))
      : chunks;
    if (ordered.some((chunk, index) => chunk !== chunks[index])) {
      const spaced = starts.length > 1 && all[starts[1]! - 1]!.trim() === "";
      const rebuilt: string[] = [];
      ordered.forEach((chunk, index) => {
        if (index > 0 && spaced) rebuilt.push("");
        rebuilt.push(...chunk.body);
      });
      let tail = range.end;
      while (tail > starts[0]! && all[tail - 1]!.trim() === "") tail -= 1;
      all.splice(starts[0]!, tail - starts[0]!, ...rebuilt);
      next = all.join("\n");
    }
  }
  const version = pageVersion(next);
  const newest = newestChangelogVersion(parseChangelog(next));
  if (version !== null && newest !== null && compareVersions(version, newest) < 0) {
    next = setPageVersion(next, newest);
  }
  return next;
}

/**
 * Replace `target`'s changelog with `source`'s, byte for byte: whatever the
 * target says in its own changelog (a model's rewrite, nothing at all) is
 * discarded. When `source` has none, the target's is removed too. Expects LF.
 */
function restoreChangelog(target: string, source: string): string {
  const sourceLines = source.split("\n");
  const sourceRange = changelogRange(sourceLines);
  const section = sourceRange === null ? null : sourceLines.slice(sourceRange.heading, sourceRange.end);
  while (section !== null && section.length > 1 && section[section.length - 1]!.trim() === "") section.pop();

  const all = target.split("\n");
  const range = changelogRange(all);
  if (range !== null) {
    all.splice(range.heading, range.end - range.heading, ...(section ?? []), ...(range.end < all.length ? [""] : []));
    return all.join("\n").replace(/\n{3,}$/, "\n");
  }
  if (section === null) return target;
  return `${target.replace(/\s+$/, "")}\n\n${section.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------

interface Section {
  heading: string;
  /** Line index of the heading in the LF text it was read from. */
  start: number;
  /** Lines from the heading to the line before the next heading, trailing blanks dropped. */
  lines: string[];
}

function sectionsOf(markdown: string): Section[] {
  const all = lines(markdown);
  const mask = fencedLines(all);
  const sections: Section[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const match = mask[index] ? null : H2.exec(all[index]!);
    if (!match) continue;
    let end = findLine(all, mask, (line) => SECTION_HEADING.test(line), index + 1);
    if (end < 0) end = all.length;
    const body = all.slice(index, end);
    while (body.length > 1 && body[body.length - 1]!.trim() === "") body.pop();
    sections.push({ heading: match[1]!, start: index, lines: body });
  }
  return sections;
}

/**
 * The generator's Reference heading, and the shortened `## Reference` an
 * enricher leaves (six pages of one real wiki). Nothing looser: a hand-written
 * `## Reference implementation notes` is prose, not the generated section
 * (review r1 L-006).
 */
function isReferenceHeading(heading: string): boolean {
  return /^reference(\s*\(from code graph\))?$/i.test(heading.trim());
}

/** `##` headings by count; both Reference spellings count as one heading. */
function sectionCounts(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const section of sectionsOf(markdown)) {
    const heading = isReferenceHeading(section.heading) ? "Reference" : section.heading;
    counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

export function checkPageInvariants(before: string, after: string): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const beforeLog = parseChangelog(before);
  const afterLog = parseChangelog(after);

  if (beforeLog !== null && afterLog === null) {
    violations.push({ kind: "changelog-dropped", detail: "the page had a ## Changelog section and the new content has none" });
  } else if (beforeLog !== null && afterLog !== null) {
    const kept = new Set(afterLog.map((entry) => entry.text));
    for (const entry of beforeLog) {
      if (!kept.has(entry.text)) {
        violations.push({
          kind: "changelog-entry-altered",
          detail: `changelog entry removed or reworded: ${entry.text.split("\n")[0]!.slice(0, 120)}`,
        });
      }
    }
  }

  const version = pageVersion(after);
  const newest = newestChangelogVersion(afterLog);
  if (version !== null && newest !== null && compareVersions(version, newest) < 0) {
    violations.push({ kind: "version-behind-changelog", detail: `Version ${version} is lower than the newest changelog entry ${newest}` });
  }

  const afterKeys = new Set(frontmatterKeys(after));
  for (const key of frontmatterKeys(before)) {
    if (!afterKeys.has(key)) {
      violations.push({ kind: "frontmatter-key-dropped", detail: `front-matter key dropped: ${key}` });
    }
  }

  if (findManagedBlock(toLf(before)).kind === "present" && findManagedBlock(toLf(after)).kind !== "present") {
    violations.push({ kind: "managed-block-dropped", detail: "the managed Reference block (keryx:reference markers) was dropped or damaged" });
  }

  const beforeCounts = sectionCounts(before);
  for (const [heading, count] of sectionCounts(after)) {
    if (count > 1 && count > (beforeCounts.get(heading) ?? 0)) {
      violations.push({ kind: "section-duplicated", detail: `section "## ${heading}" now appears ${count} times` });
    }
  }
  return violations;
}

export function describeViolations(violations: readonly InvariantViolation[]): string {
  return violations.map((violation) => `${violation.kind}: ${violation.detail}`).join("; ");
}

// ---------------------------------------------------------------------------
// Writers.
// ---------------------------------------------------------------------------

/**
 * A model shown the page inside a ```markdown fence often answers inside one.
 * Written as-is, the whole page becomes a code block with a second front
 * matter inside — keryx's own `components/src-harness.md` was left that way by
 * an earlier enrich. Strip one fence wrapping the entire reply; a reply that
 * merely contains code blocks is returned unchanged.
 */
export function unwrapFencedReply(reply: string): string {
  const trimmed = toLf(reply).trim();
  const open = /^```(?:markdown|md)?[ \t]*\n/i.exec(trimmed);
  if (!open || !/\n```[ \t]*$/.test(trimmed)) return reply;
  const inner = trimmed.slice(open[0].length, trimmed.lastIndexOf("\n```"));
  // Only a wrapper: the inner text must not close the same fence earlier.
  const unbalanced = inner.split("\n").filter((line) => /^```/.test(line.trim())).length % 2 !== 0;
  return unbalanced ? reply : `${inner}\n`;
}

function leadingYamlBlock(markdown: string): string | null {
  if (!markdown.startsWith("---\n")) return null;
  const close = markdown.indexOf("\n---", 3);
  if (close < 0) return null;
  const lineEnd = markdown.indexOf("\n", close + 4);
  return markdown.slice(0, lineEnd < 0 ? markdown.length : lineEnd + 1);
}

/**
 * Make an enriched page keep everything that is not prose, from `original`:
 * its front matter (Status included), its managed Reference block, and its
 * changelog byte for byte, plus one new entry for this write and the Version
 * that entry names. The model only ever changes prose. The result uses the
 * original's line endings.
 */
export function preserveEnrichInvariants(original: string, enriched: string, entryNote: string): string {
  const source = toLf(original);
  let next = toLf(enriched);
  const originalMeta = leadingYamlBlock(source);
  const enrichedMeta = leadingYamlBlock(next);
  if (originalMeta !== null && enrichedMeta !== null) {
    next = `${originalMeta}${next.slice(enrichedMeta.length)}`;
  }

  const block = findManagedBlock(source);
  if (block.kind === "present" && findManagedBlock(next).kind === "present") {
    next = replaceManagedBlock(next, block.block.content) ?? next;
  }

  next = restoreChangelog(next, source);
  const version = nextPageVersion(source);
  next = setPageVersion(next, version);
  return inEolOf(original, prependChangelogEntry(next, `- ${version} - ${entryNote}`));
}

/**
 * Sections of a freshly generated page that belong to the generator: everything
 * but Summary, Changelog and the `_Draft …_` placeholders prose is written into.
 */
export function generatedSectionHeadings(generated: string): string[] {
  return sectionsOf(generated)
    .filter((section) => !/^(summary|changelog)$/i.test(section.heading))
    .filter((section) => !/^_Draft\b/.test(section.lines.slice(1).find((line) => line.trim() !== "")?.trim() ?? ""))
    .map((section) => section.heading);
}

/**
 * Related Wiki is generated, but the template invites an enricher to add links
 * to pages it verified, and enrichers add a sentence there too (a real enriched
 * testing map did). The regenerated list replaces the generated lines; every
 * other line — prose, a link that is not a module link — is kept after it.
 * Generated lines are recognised by content (a module link, or text the fresh
 * section already says, whatever its line wrapping), so a link to a module
 * that no longer exists still goes away.
 */
function withAddedLines(fresh: readonly string[], existingBody: readonly string[]): string[] {
  const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
  const freshText = collapse(fresh.join("\n"));
  const added = existingBody.filter((line) => {
    const text = collapse(line);
    if (text.length === 0) return false;
    if (/^[-*]\s+\[Module [^\]]+\]\([^)]+\.md\)$/.test(text)) return false;
    // The generator's own "Graph-derived …" note, as an enricher reworded it
    // (seen five ways on one real wiki); keeping it would print it twice.
    if (/^graph-derived\b/i.test(text)) return false;
    return !freshText.includes(text);
  });
  return added.length === 0 ? [...fresh] : [...fresh, "", ...added];
}

/** Sections the page itself declares generator-owned ("regenerated by `--force`"). */
function isDeclaredGenerated(heading: string): boolean {
  return isReferenceHeading(heading) || /^related wiki$/i.test(heading);
}

/**
 * Regenerate the generator-owned sections of an existing page from `generated`,
 * keeping every other byte of `existing`: front matter, prose sections, the
 * changelog. A managed Reference block is replaced inside its markers. Returns
 * `existing` unchanged when no generated section differs; otherwise the result
 * carries one new changelog entry and the Version it names, in the existing
 * page's line endings.
 *
 * Reference and Related Wiki are regenerated on every page: the page text
 * itself declares them generator-owned. The data sections of a map page
 * (project/quality/testing map) carry no such declaration, and an enricher
 * writes prose under the very same headings — measured on a real enriched
 * quality map, where `## Findings by Source` held an `### Interpretation`
 * subsection. So those are regenerated only on a page that was never
 * enriched (it has no heading the generator does not produce), and never
 * when the section holds `###` subsections. A stale map section is the cost;
 * lost prose is not.
 */
export function mergeGeneratedSections(existing: string, generated: string, entryNote: string): string {
  const source = toLf(existing);
  const generatedLf = toLf(generated);
  const fresh = new Map(sectionsOf(generatedLf).map((section) => [section.heading.toLowerCase(), section]));
  const enriched = sectionsOf(source).some(
    (section) => !fresh.has(section.heading.toLowerCase()) && !/^changelog$/i.test(section.heading),
  );
  let next = source;
  for (const heading of generatedSectionHeadings(generatedLf)) {
    const replacement = fresh.get(heading.toLowerCase())!;
    const sameHeading = isReferenceHeading(heading)
      ? (text: string): boolean => isReferenceHeading(text)
      : (text: string): boolean => text.toLowerCase() === heading.toLowerCase();
    const current = sectionsOf(next).find((section) => sameHeading(section.heading));
    if (!isDeclaredGenerated(heading)) {
      if (enriched) continue;
      if (current?.lines.some((line) => /^###\s/.test(line))) continue;
    }
    const block = findManagedBlock(next);
    if (isReferenceHeading(heading) && block.kind === "present") {
      // A block edited by hand is left alone, as `wiki refresh` does without --force.
      if (!block.block.handEdited && block.block.content.trim() !== replacement.lines.join("\n").trim()) {
        next = replaceManagedBlock(next, replacement.lines.join("\n")) ?? next;
      }
      continue;
    }
    const all = next.split("\n");
    if (current) {
      const regenerated = /^related wiki$/i.test(heading)
        ? withAddedLines(replacement.lines, current.lines.slice(1))
        : replacement.lines;
      if (current.lines.join("\n") === regenerated.join("\n")) continue;
      all.splice(current.start, current.lines.length, ...regenerated);
      next = all.join("\n");
      continue;
    }
    // Missing: insert before the changelog, or at the end.
    const log = changelogRange(all);
    if (log === null) {
      next = `${next.replace(/\s+$/, "")}\n\n${replacement.lines.join("\n")}\n`;
    } else {
      all.splice(log.heading, 0, ...replacement.lines, "");
      next = all.join("\n");
    }
  }
  // Repair first, then bump: the new entry lands above a newest-first log, and
  // a page nothing else changed on is still brought back in order (no new entry:
  // nothing was regenerated, only a defect fixed).
  const repaired = repairVersionAndOrder(next);
  if (next === source) return repaired === source ? existing : inEolOf(existing, repaired);
  const version = nextPageVersion(repaired);
  return inEolOf(existing, prependChangelogEntry(setPageVersion(repaired, version), `- ${version} - ${entryNote}`));
}
