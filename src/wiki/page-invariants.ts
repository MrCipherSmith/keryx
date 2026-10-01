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
// - a managed Reference block the page had is never dropped.
//
// Writers keep them by construction (`preserveEnrichInvariants`,
// `mergeGeneratedSections`) and then check: a page that still violates one is
// not written.

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
  /** The `x.y.z` the entry starts with, when it has one. */
  version: string | null;
}

const CHANGELOG_HEADING = /^##\s+Changelog\s*$/i;
const SECTION_HEADING = /^#{1,2}\s/;
const ENTRY_START = /^[-*]\s+/;
const ENTRY_VERSION = /^[-*]\s+v?(\d+\.\d+\.\d+)\b/;
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
// Versions.
// ---------------------------------------------------------------------------

function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Semver-style compare of `x.y.z`; an unparseable version sorts lowest. */
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

function lines(markdown: string): string[] {
  return markdown.replace(/^\uFEFF/, "").split("\n");
}

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
  const firstSection = all.findIndex((line) => /^##\s/.test(line));
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

/** Set `Version`, inside the metadata only. A page without one is left as it is. */
export function setPageVersion(markdown: string, version: string): string {
  const all = markdown.split("\n");
  const range = metadataRange(all);
  if (range === null) return markdown;
  for (let index = range.start; index < range.end; index += 1) {
    if (/^Version:/i.test(all[index]!)) {
      all[index] = `Version: ${version}`;
      return all.join("\n");
    }
  }
  return markdown;
}

// ---------------------------------------------------------------------------
// Changelog.
// ---------------------------------------------------------------------------

/** Line range [heading, end) of the `## Changelog` section, or null. */
function changelogRange(all: string[]): { heading: number; end: number } | null {
  const heading = all.findIndex((line) => CHANGELOG_HEADING.test(line.trim()));
  if (heading < 0) return null;
  let end = all.length;
  for (let index = heading + 1; index < all.length; index += 1) {
    if (SECTION_HEADING.test(all[index]!)) {
      end = index;
      break;
    }
  }
  return { heading, end };
}

/** The page's changelog entries in page order, or null when it has no section. */
export function parseChangelog(markdown: string): ChangelogEntry[] | null {
  const all = lines(markdown);
  const range = changelogRange(all);
  if (range === null) return null;
  const entries: ChangelogEntry[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (current === null) return;
    const text = current.join("\n").trim();
    entries.push({ text, version: ENTRY_VERSION.exec(text)?.[1] ?? null });
    current = null;
  };
  for (const line of all.slice(range.heading + 1, range.end)) {
    if (ENTRY_START.test(line)) {
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

/** Insert `entry` as the newest changelog line, creating the section when missing. */
export function prependChangelogEntry(markdown: string, entry: string): string {
  const all = markdown.split("\n");
  const range = changelogRange(all);
  if (range === null) return `${markdown.replace(/\s+$/, "")}\n\n## Changelog\n\n${entry}\n`;
  let insert = range.heading + 1;
  while (insert < all.length && all[insert]!.trim() === "") insert += 1;
  const nextIsEntry = insert < range.end && ENTRY_START.test(all[insert]!);
  // Keep the page's own spacing: a blank line between entries when it uses one.
  const spaced = nextIsEntry && insert + 1 < all.length && all[insert + 1]!.trim() === "";
  all.splice(insert, 0, ...(spaced ? [entry, ""] : [entry]));
  return all.join("\n");
}

/**
 * Replace `target`'s changelog with `source`'s, byte for byte: whatever the
 * target says in its own changelog (a model's rewrite, nothing at all) is
 * discarded. When `source` has none, the target's is removed too.
 */
export function restoreChangelog(target: string, source: string): string {
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

  if (findManagedBlock(before).kind === "present" && findManagedBlock(after).kind !== "present") {
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

/** `##` headings by count; every Reference variant counts as one heading. */
function sectionCounts(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of markdown.matchAll(/^##\s+(.+?)\s*$/gm)) {
    const heading = /^reference\b/i.test(match[1]!) ? "Reference" : match[1]!;
    counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }
  return counts;
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
  const trimmed = reply.trim();
  const open = /^```(?:markdown|md)?[ \t]*\n/i.exec(trimmed);
  if (!open || !/\n```[ \t]*$/.test(trimmed)) return reply;
  const inner = trimmed.slice(open[0].length, trimmed.lastIndexOf("\n```"));
  // Only a wrapper: the inner text must not close the same fence earlier.
  const unbalanced = inner.split("\n").filter((line) => /^```/.test(line.trim())).length % 2 !== 0;
  return unbalanced ? reply : `${inner}\n`;
}

function leadingYamlBlock(markdown: string): string | null {
  const text = markdown.replace(/^\uFEFF/, "");
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---", 3);
  if (close < 0) return null;
  const lineEnd = text.indexOf("\n", close + 4);
  return text.slice(0, lineEnd < 0 ? text.length : lineEnd + 1);
}

/**
 * Make an enriched page keep everything that is not prose, from `original`:
 * its front matter (Status included), its managed Reference block, and its
 * changelog byte for byte, plus one new entry for this write and the Version
 * that entry names. The model only ever changes prose.
 */
export function preserveEnrichInvariants(original: string, enriched: string, entryNote: string): string {
  let next = enriched;
  const originalMeta = leadingYamlBlock(original);
  const enrichedMeta = leadingYamlBlock(next);
  if (originalMeta !== null && enrichedMeta !== null) {
    next = `${originalMeta}${next.replace(/^\uFEFF/, "").slice(enrichedMeta.length)}`;
  }

  const block = findManagedBlock(original);
  if (block.kind === "present" && findManagedBlock(next).kind === "present") {
    next = replaceManagedBlock(next, block.block.content) ?? next;
  }

  next = restoreChangelog(next, original);
  const version = nextPageVersion(original);
  next = setPageVersion(next, version);
  return prependChangelogEntry(next, `- ${version} - ${entryNote}`);
}

interface Section {
  heading: string;
  /** Lines from the heading to the line before the next `##` heading, trailing blanks dropped. */
  lines: string[];
}

function sectionsOf(markdown: string): Section[] {
  const all = markdown.split("\n");
  const sections: Section[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(all[index]!);
    if (!match) continue;
    let end = index + 1;
    while (end < all.length && !SECTION_HEADING.test(all[end]!)) end += 1;
    const body = all.slice(index, end);
    while (body.length > 1 && body[body.length - 1]!.trim() === "") body.pop();
    sections.push({ heading: match[1]!, lines: body });
  }
  return sections;
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
  return /^reference\b/i.test(heading) || /^related wiki$/i.test(heading);
}

/**
 * Regenerate the generator-owned sections of an existing page from `generated`,
 * keeping every other byte of `existing`: front matter, prose sections, the
 * changelog. A managed Reference block is replaced inside its markers. Returns
 * `existing` unchanged when no generated section differs; otherwise the result
 * carries one new changelog entry and the Version it names.
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
  const generatedSections = sectionsOf(generated);
  const fresh = new Map(generatedSections.map((section) => [section.heading.toLowerCase(), section]));
  const enriched = sectionsOf(existing).some(
    (section) => !fresh.has(section.heading.toLowerCase()) && !/^changelog$/i.test(section.heading),
  );
  let next = existing;
  for (const heading of generatedSectionHeadings(generated)) {
    const replacement = fresh.get(heading.toLowerCase())!;
    if (!isDeclaredGenerated(heading)) {
      if (enriched) continue;
      const current = sectionsOf(next).find((section) => section.heading.toLowerCase() === heading.toLowerCase());
      if (current?.lines.some((line) => /^###\s/.test(line))) continue;
    }
    const block = findManagedBlock(next);
    if (/^reference\b/i.test(heading) && block.kind === "present") {
      // A block edited by hand is left alone, as `wiki refresh` does without --force.
      if (!block.block.handEdited && block.block.content.trim() !== replacement.lines.join("\n").trim()) {
        next = replaceManagedBlock(next, replacement.lines.join("\n")) ?? next;
      }
      continue;
    }
    const all = next.split("\n");
    // Reference is matched loosely, as `managed-block.ts` does: an enricher
    // shortens "Reference (from code graph)" to "Reference" (six pages of one
    // real wiki), and an exact match then appended a second Reference section.
    const sameHeading = /^reference\b/i.test(heading)
      ? (text: string): boolean => /^reference\b/i.test(text)
      : (text: string): boolean => text.toLowerCase() === heading.toLowerCase();
    const start = all.findIndex((line) => {
      const match = /^##\s+(.+?)\s*$/.exec(line);
      return match !== null && sameHeading(match[1]!);
    });
    if (start >= 0) {
      let end = start + 1;
      while (end < all.length && !SECTION_HEADING.test(all[end]!)) end += 1;
      let contentEnd = end;
      while (contentEnd > start + 1 && all[contentEnd - 1]!.trim() === "") contentEnd -= 1;
      const regenerated = /^related wiki$/i.test(heading)
        ? withAddedLines(replacement.lines, all.slice(start + 1, contentEnd))
        : replacement.lines;
      if (all.slice(start, contentEnd).join("\n") === regenerated.join("\n")) continue;
      all.splice(start, contentEnd - start, ...regenerated);
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
  if (next === existing) return existing;
  const version = nextPageVersion(existing);
  return prependChangelogEntry(setPageVersion(next, version), `- ${version} - ${entryNote}`);
}
