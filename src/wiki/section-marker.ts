// AFC-W01 (flow 235, phase 3) — the Markdown marker that carries a wiki
// section's stable identity.
//
// `wiki-specification.md` §2 is explicit that the identity is authored into the
// Markdown and is NOT derived from the heading: "ID не выводится только из
// heading: одинаковые заголовки разных страниц/доменов не должны сталкиваться;
// rename heading сохраняет ID." A path- or heading-derived id cannot satisfy
// that, which is the measured defect this module exists to remove — before it,
// `wikiPageId` (`../gdgraph/wiki-layer.ts`) returned `wiki:${relativePath}`
// and was commented "Stable id for a page node", while a file rename silently
// produced a different id and a *different* page moving into the vacated path
// silently inherited the old one.
//
// The syntax deliberately mirrors `managed-block.ts`'s
// `<!-- keryx:reference:begin v=1 hash=… -->`, which is the marker idiom this
// repository already has: an HTML comment, an explicit version, and a
// *refusal* (never a guess) when the version is one this build cannot read.
//
// Two marker kinds:
//
//   <!-- keryx:page id="os-sandbox" v=1 -->        (whole-page identity)
//   <!-- keryx:section id="rule-retry" v=1 -->     (one section's identity)
//   ## Повтор после конфликта
//   …
//   <!-- /keryx:section -->
//
// The closing form is the spec's own `<!-- /keryx:section -->`.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../lib/fs";
import { collectPages } from "./collect";

export const SECTION_MARKER_VERSION = 1;
export const PAGE_MARKER_VERSION = 1;

/** An id is an authored, URL-safe slug. Deliberately narrow: it goes into refs. */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const PAGE_MARKER_RE =
  /^<!--\s*keryx:page\s+id="([^"]*)"(?:\s+v=(\d+))?(?:\s+domain="([^"]*)")?\s*-->$/;
const SECTION_OPEN_RE =
  /^<!--\s*keryx:section\s+id="([^"]*)"(?:\s+v=(\d+))?(?:\s+domain="([^"]*)")?(?:\s+lang="([^"]*)")?\s*-->$/;
const SECTION_CLOSE_RE = /^<!--\s*\/keryx:section\s*-->$/;

export const SECTION_CLOSE_MARKER = "<!-- /keryx:section -->";

export type MarkerIssueKind =
  | "unknown-marker-version"
  | "invalid-id"
  | "unclosed-section"
  | "stray-close"
  | "nested-section"
  | "duplicate-page-marker";

export type MarkerIssue = {
  kind: MarkerIssueKind;
  /** 1-based line the problem was found on. */
  line: number;
  message: string;
};

export type PageMarker = {
  id: string;
  markerVersion: number;
  domain: string | null;
  /** 1-based. */
  line: number;
};

export type SectionMarker = {
  id: string;
  markerVersion: number;
  domain: string | null;
  language: string | null;
  /** 1-based line of the opening marker. */
  openLine: number;
  /** 1-based line of the closing marker. */
  closeLine: number;
};

export type ParsedMarkers = {
  page: PageMarker | null;
  sections: SectionMarker[];
  issues: MarkerIssue[];
};

/**
 * Parse every keryx identity marker on a page.
 *
 * Damage is reported, never thrown — the same posture `findManagedBlock`
 * takes and for the same reason: a page is data written by people and by older
 * builds, and one damaged page must not take the whole corpus down with it.
 * A page that reports issues still yields whatever markers parsed cleanly, so
 * retrieval degrades to the provisional locator for the damaged part only.
 */
export function parseMarkers(content: string): ParsedMarkers {
  const lines = content.split("\n");
  const issues: MarkerIssue[] = [];
  const sections: SectionMarker[] = [];
  let page: PageMarker | null = null;
  let open: { id: string; version: number; domain: string | null; language: string | null; line: number } | null =
    null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = (lines[index] ?? "").trim();
    const lineNumber = index + 1;

    const pageMatch = raw.match(PAGE_MARKER_RE);
    if (pageMatch) {
      const id = pageMatch[1] ?? "";
      const version = pageMatch[2] === undefined ? PAGE_MARKER_VERSION : Number(pageMatch[2]);
      if (page !== null) {
        issues.push({
          kind: "duplicate-page-marker",
          line: lineNumber,
          message: "a page declares more than one keryx:page marker",
        });
        continue;
      }
      if (!ID_RE.test(id)) {
        issues.push({ kind: "invalid-id", line: lineNumber, message: `invalid page id "${id}"` });
        continue;
      }
      if (version !== PAGE_MARKER_VERSION) {
        // Refused, not guessed at — a format this build cannot read must not be
        // reinterpreted by it (`managed-block.ts`'s own rule).
        issues.push({
          kind: "unknown-marker-version",
          line: lineNumber,
          message: `unknown keryx:page marker version ${version}`,
        });
        continue;
      }
      page = { id, markerVersion: version, domain: pageMatch[3] ?? null, line: lineNumber };
      continue;
    }

    const openMatch = raw.match(SECTION_OPEN_RE);
    if (openMatch) {
      if (open !== null) {
        issues.push({
          kind: "nested-section",
          line: lineNumber,
          message: `section "${open.id}" was never closed before a new section marker opened`,
        });
        open = null;
        continue;
      }
      const id = openMatch[1] ?? "";
      const version = openMatch[2] === undefined ? SECTION_MARKER_VERSION : Number(openMatch[2]);
      if (!ID_RE.test(id)) {
        issues.push({ kind: "invalid-id", line: lineNumber, message: `invalid section id "${id}"` });
        continue;
      }
      if (version !== SECTION_MARKER_VERSION) {
        issues.push({
          kind: "unknown-marker-version",
          line: lineNumber,
          message: `unknown keryx:section marker version ${version}`,
        });
        continue;
      }
      open = {
        id,
        version,
        domain: openMatch[3] ?? null,
        language: openMatch[4] ?? null,
        line: lineNumber,
      };
      continue;
    }

    if (SECTION_CLOSE_RE.test(raw)) {
      if (open === null) {
        issues.push({
          kind: "stray-close",
          line: lineNumber,
          message: "closing section marker with no opening marker",
        });
        continue;
      }
      sections.push({
        id: open.id,
        markerVersion: open.version,
        domain: open.domain,
        language: open.language,
        openLine: open.line,
        closeLine: lineNumber,
      });
      open = null;
    }
  }

  if (open !== null) {
    issues.push({
      kind: "unclosed-section",
      line: open.line,
      message: `section "${open.id}" is never closed`,
    });
  }

  return { page, sections, issues };
}

/** True for any line that is a keryx identity marker (either kind, either end). */
export function isMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    PAGE_MARKER_RE.test(trimmed) || SECTION_OPEN_RE.test(trimmed) || SECTION_CLOSE_RE.test(trimmed)
  );
}

/**
 * Remove every identity marker line, leaving all other bytes untouched.
 *
 * This is the migration's own proof obligation made executable: a migration
 * inserts whole marker LINES and reflows nothing, so
 * `stripSectionMarkers(migrate(x)) === x` must hold byte for byte. The tests
 * assert exactly that on real pages from this repository's wiki.
 */
export function stripSectionMarkers(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isMarkerLine(line)) {
      kept.push(line);
      continue;
    }
    // A marker line inserted on its own line took a newline with it. Dropping
    // the line alone restores the original array exactly, because insertion
    // added one array element and removal takes one away.
  }
  return kept.join("\n");
}

export function emitPageMarker(id: string): string {
  return `<!-- keryx:page id="${id}" v=${PAGE_MARKER_VERSION} -->`;
}

export function emitSectionOpen(id: string): string {
  return `<!-- keryx:section id="${id}" v=${SECTION_MARKER_VERSION} -->`;
}

/**
 * A deterministic id proposal for a heading, used only by the migration when it
 * authors a marker for a previously unmarked section.
 *
 * This is NOT identity derivation: once written the marker is the identity and
 * the heading may change freely. It is a starting slug, chosen so a migrated
 * page reads sensibly, and de-duplicated by the caller within its owner page.
 */
export function proposeSectionId(headingText: string, fallbackOrdinal: number): string {
  const slug = headingText
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 && ID_RE.test(slug) ? slug : `section-${fallbackOrdinal}`;
}

// --- migration ----------------------------------------------------------------
//
// `wiki-specification.md` §2: "Явная миграция вставляет markers по preview и
// CAS, обычный search Markdown не изменяет." Both halves are load-bearing here:
// the migration is the ONLY thing in this lane that rewrites a page, and it is
// explicit, previewable and compare-and-swap guarded.
//
// The correctness property is byte-for-byte content preservation. It is
// achieved structurally rather than by inspection: the writer only ever INSERTS
// whole marker lines into the line array and never reflows, joins, trims or
// re-renders anything, so `stripSectionMarkers(migrated) === original` holds
// exactly. That identity is asserted on real pages from this repository's own
// wiki, not only on fixtures.

export type SectionMigrateAction = "migrated" | "already" | "conflict" | "nothing-to-mark";

export type SectionMigratePage = {
  page: string;
  action: SectionMigrateAction;
  /** sha256 of the page's bytes the plan was computed against (the CAS token). */
  baseDigest: string;
  /** The migrated bytes. Present for `migrated`, including in a dry run. */
  content?: string;
  /** Ids the migration authored, in document order. */
  authoredIds?: string[];
  reason?: string;
};

export type SectionMigrateResult = {
  dryRun: boolean;
  pages: SectionMigratePage[];
  migrated: number;
  already: number;
  conflicts: number;
};

export type SectionMigrateOptions = {
  dryRun?: boolean;
  /** Restrict to one wiki-relative page path. */
  page?: string;
  /**
   * CAS: wiki-relative path → the sha256 a preview was taken against. A page
   * whose bytes no longer match is reported as `conflict` and left alone.
   */
  expect?: ReadonlyMap<string, string>;
};

const FENCE = /^(?:```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Plan one page's migration.
 *
 * Returns `null` when the page needs no change: every indexable heading is
 * already inside a marker, or there is nothing to mark at all. Deciding that
 * here (rather than writing an identical file) is what makes the command
 * idempotent.
 */
export function planPageMigration(
  relativePath: string,
  content: string,
): { content: string; authoredIds: string[] } | null {
  const lines = content.split("\n");
  const markers = parseMarkers(content);
  const covered = (line: number): boolean =>
    markers.sections.some((marker) => line > marker.openLine && line < marker.closeLine);

  const headings: Array<{ line: number; level: number; title: string }> = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = line.match(HEADING);
    if (match && (match[1] ?? "").length >= 2) {
      headings.push({ line: index + 1, level: (match[1] ?? "").length, title: match[2] ?? "" });
    }
  }

  const pending = headings.filter((heading) => !covered(heading.line));
  const needsPageMarker = markers.page === null;
  if (pending.length === 0 && !needsPageMarker) {
    return null;
  }

  const used = new Set(markers.sections.map((marker) => marker.id));
  const authoredIds: string[] = [];
  // Insertions keyed by the 1-based line they go BEFORE / AFTER, applied in one
  // pass so no index arithmetic accumulates.
  const openBefore = new Map<number, string>();
  const closeAfter = new Map<number, string>();

  for (let i = 0; i < pending.length; i += 1) {
    const heading = pending[i];
    if (!heading) {
      continue;
    }
    let id = proposeSectionId(heading.title, heading.line);
    if (used.has(id)) {
      let suffix = 2;
      while (used.has(`${id}-${suffix}`)) {
        suffix += 1;
      }
      id = `${id}-${suffix}`;
    }
    used.add(id);
    authoredIds.push(id);

    const next = headings.find((candidate) => candidate.line > heading.line);
    let end = next ? next.line - 1 : lines.length;
    // Trailing blank lines belong to the page's spacing, not to the section —
    // the same boundary `wrapReferenceSection` draws.
    while (end > heading.line && (lines[end - 1] ?? "").trim().length === 0) {
      end -= 1;
    }
    openBefore.set(heading.line, emitSectionOpen(id));
    closeAfter.set(end, SECTION_CLOSE_MARKER);
  }

  const out: string[] = [];
  if (needsPageMarker) {
    out.push(emitPageMarker(proposeSectionId(relativePath.replace(/\.md$/, ""), 1)));
  }
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const open = openBefore.get(lineNumber);
    if (open !== undefined) {
      out.push(open);
    }
    out.push(lines[index] ?? "");
    const close = closeAfter.get(lineNumber);
    if (close !== undefined) {
      out.push(close);
    }
  }
  return { content: out.join("\n"), authoredIds };
}

/**
 * `keryx wiki sections migrate` — insert identity markers into wiki pages.
 *
 * Never authors content: it wraps what is already written. A dry run computes
 * the same bytes it would write and writes nothing, so the preview a reviewer
 * approves is the artefact that lands.
 */
export async function migrateSectionMarkers(
  cwd: string,
  options: SectionMigrateOptions = {},
): Promise<SectionMigrateResult> {
  const pages = await collectPages(cwd);
  const results: SectionMigratePage[] = [];

  for (const page of pages) {
    if (options.page && page.relativePath !== options.page) {
      continue;
    }
    const content = await readFile(page.absolutePath, "utf8");
    const baseDigest = digest(content);

    const expected = options.expect?.get(page.relativePath);
    if (expected !== undefined && expected !== baseDigest) {
      results.push({
        page: page.relativePath,
        action: "conflict",
        baseDigest,
        reason:
          "the page changed since the preview was taken; nothing was written. Re-run the preview and review it again.",
      });
      continue;
    }

    const planned = planPageMigration(page.relativePath, content);
    if (planned === null) {
      results.push({ page: page.relativePath, action: "already", baseDigest });
      continue;
    }

    // The correctness property, checked before the bytes land rather than only
    // in a test: stripping the markers back out must reproduce the input
    // exactly. If it does not, the migration reflowed something it had no
    // business touching and the page is left alone.
    if (stripSectionMarkers(planned.content) !== content) {
      results.push({
        page: page.relativePath,
        action: "conflict",
        baseDigest,
        reason:
          "the planned migration would not round-trip: stripping its markers does not reproduce the page " +
          "byte for byte. Nothing was written. This is a bug in the migration, not in the page.",
      });
      continue;
    }

    if (!options.dryRun) {
      await writeFileAtomic(page.absolutePath, planned.content);
    }
    results.push({
      page: page.relativePath,
      action: "migrated",
      baseDigest,
      content: planned.content,
      authoredIds: planned.authoredIds,
    });
  }

  results.sort((a, b) => a.page.localeCompare(b.page));
  return {
    dryRun: Boolean(options.dryRun),
    pages: results,
    migrated: results.filter((entry) => entry.action === "migrated").length,
    already: results.filter((entry) => entry.action === "already").length,
    conflicts: results.filter((entry) => entry.action === "conflict").length,
  };
}
