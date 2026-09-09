// AFC-W01 / AFC-07 (flow 235, phase 3) — the wiki's retrieval unit and its
// address.
//
// Before this module the indexed unit was `title + the first paragraph of
// "## Summary"` (`wikiCandidates`, `./ask.ts`, over `extractSummary`,
// `./collect.ts`). That is the measured cause of AC1 failing as written: on
// this repository's own corpus `keryx wiki ask "spawnSync"` returned zero
// citations while the term sits in the Details section of
// `.metaproject/wiki/architecture/os-sandbox.md`, and `"bubblewrap"` only hit
// that page because the word happens to appear in its Summary.
//
// `wiki-specification.md` §2: "Индекс включает основной текст (Details, Main
// flows, Constraints и произвольные содержательные секции), page/section title,
// точные identifiers, logical paths и explicit aliases." This module is that
// index — "производная проекция существующей wiki, не второй источник знаний":
// it is built in memory from the pages `collectPages` already returns and it
// writes nothing (see `./section-tombstone.ts` for the one file that is
// written, and only by an explicit command).
//
// Identity comes from `./section-marker.ts` when a page has been migrated, and
// otherwise from the provisional `pageVersion + heading occurrence + range`
// locator the spec allows for legacy pages, carried with
// `stability: "version-bound"` so nothing downstream can mistake it for a
// promise.

import { createHash } from "node:crypto";
import type { WikiPage } from "./types";
import { isMarkerLine, parseMarkers, type MarkerIssue, type SectionMarker } from "./section-marker";

/** Bump when the section splitter changes: it keys index reuse (spec §2). */
export const SECTION_PARSER_VERSION = 1;
/** Bump when scoring changes: a cached score from another profile is not comparable. */
export const RANKING_PROFILE_VERSION = 1;

export type SectionStability = "stable" | "version-bound";
export type SectionContentClass = "substantive" | "scaffold" | "reference";
export type SectionLanguage = "en" | "ru" | "mixed";

export type PageIdentity = {
  pageId: string;
  stability: SectionStability;
  /** The authored marker id, or null on a legacy page. */
  markerId: string | null;
};

export type WikiSectionRecord = {
  /** Stable when the page carries a `keryx:page` marker; else path-derived. */
  pageId: string;
  pageStability: SectionStability;
  pageRelativePath: string;
  pageTitle: string;
  pageVersion: string | null;
  /** The wiki's own domain partition — what makes duplicate headings distinguishable. */
  domain: string;
  sectionId: string;
  sectionRef: string;
  stability: SectionStability;
  /** The heading text as it currently reads. Renaming it does not change the id. */
  title: string;
  /** Ancestor headings, outermost first, for a human-readable address. */
  headingPath: string[];
  /** 1-based position of this heading among the page's indexed headings. */
  headingOccurrence: number;
  /** 1-based inclusive line range of the section's own body. */
  bodyRange: { startLine: number; endLine: number };
  digest: string;
  language: SectionLanguage;
  contentClass: SectionContentClass;
  /** The section body as indexed (markers stripped). */
  body: string;
  /** Everything the section is matched on: page title, heading path, body. */
  indexedText: string;
};

export type SectionIndexIssueKind = MarkerIssue["kind"] | "duplicate-section-id";

export type SectionIndexIssue = {
  kind: SectionIndexIssueKind;
  page: string;
  line: number;
  message: string;
};

export type IndexedPage = {
  relativePath: string;
  contentDigest: string;
  pageVersion: string | null;
  identity: PageIdentity;
  sections: WikiSectionRecord[];
};

export type SectionIndex = {
  parserVersion: number;
  rankingProfileVersion: number;
  /** Keyed by wiki-relative path. */
  pages: Map<string, IndexedPage>;
  pageIdentities: Map<string, PageIdentity>;
  /** Flattened, sorted by `sectionRef` — deterministic iteration order. */
  sections: WikiSectionRecord[];
  issues: SectionIndexIssue[];
};

export type SectionSourcePage = { page: WikiPage; content: string };

// --- identity ----------------------------------------------------------------

/**
 * A page's identity, and how far it can be trusted.
 *
 * A `keryx:page` marker gives an identity that survives a file rename. Without
 * one the identity is still the relative path, and is labelled `version-bound`
 * — which is the honest label, because a rename produces a different id and a
 * different page moving into the vacated path inherits the old one. Both were
 * measured on a real page from this repository before this module existed.
 */
export function resolveWikiPageIdentity(relativePath: string, content: string): PageIdentity {
  const markers = parseMarkers(content);
  if (markers.page) {
    return { pageId: `keryx:page/${markers.page.id}`, stability: "stable", markerId: markers.page.id };
  }
  return { pageId: `wiki:${relativePath}`, stability: "version-bound", markerId: null };
}

// --- section splitting -------------------------------------------------------

const FENCE_RE = /^(?:```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const PLACEHOLDERS = new Set([
  "one paragraph summary.",
  "main content.",
  "tbd",
  "todo",
  "_none_",
  "- none",
]);

type RawSection = {
  level: number;
  title: string;
  headingLine: number;
  headingPath: string[];
  bodyStart: number;
  bodyEnd: number;
};

function splitSections(lines: string[]): { pageTitle: string | null; sections: RawSection[] } {
  const headings: Array<{ level: number; title: string; line: number }> = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = line.match(HEADING_RE);
    if (match) {
      headings.push({ level: (match[1] ?? "").length, title: match[2] ?? "", line: index + 1 });
    }
  }

  const pageTitle = headings.find((h) => h.level === 1)?.title ?? null;
  // Only headings at level >= 2 are sections; the level-1 heading is the page.
  const indexable = headings.filter((h) => h.level >= 2);

  if (indexable.length === 0) {
    // A page whose body sits directly under its title has no section heading to
    // split on, and dropping it would remove it from retrieval entirely — a
    // regression the old `title + ## Summary` corpus did not have. Its whole
    // body is one implicit section. Real pages in this repository's own wiki
    // are written this way.
    const titleLine = headings.find((h) => h.level === 1)?.line ?? 0;
    const bodyStart = titleLine + 1;
    if (bodyStart > lines.length) {
      return { pageTitle, sections: [] };
    }
    return {
      pageTitle,
      sections: [
        {
          level: 1,
          title: pageTitle ?? "",
          headingLine: titleLine,
          headingPath: [],
          bodyStart,
          bodyEnd: lines.length,
        },
      ],
    };
  }

  const sections: RawSection[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  for (let i = 0; i < indexable.length; i += 1) {
    const heading = indexable[i];
    if (!heading) {
      continue;
    }
    // A section's own body ends at the NEXT heading of any indexable level, so
    // `## Details` followed by `### Restricted network` keeps only its own
    // preamble and the subsection is a unit in its own right. That leaf
    // granularity is what makes a term inside one subsection findable with an
    // excerpt that actually contains it.
    const next = indexable[i + 1];
    const bodyStart = heading.line + 1;
    const bodyEnd = next ? next.line - 1 : lines.length;

    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) {
      stack.pop();
    }
    const headingPath = [...stack.map((entry) => entry.title), heading.title];
    stack.push({ level: heading.level, title: heading.title });

    sections.push({
      level: heading.level,
      title: heading.title,
      headingLine: heading.line,
      headingPath,
      bodyStart,
      bodyEnd: Math.max(bodyStart - 1, bodyEnd),
    });
  }
  return { pageTitle, sections };
}

function classifyContent(title: string, body: string): SectionContentClass {
  if (/^reference\b/i.test(title.trim())) {
    return "reference";
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim().toLowerCase();
  if (normalized.length === 0 || PLACEHOLDERS.has(normalized)) {
    return "scaffold";
  }
  return "substantive";
}

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_RE = /[a-z]/i;

function detectLanguage(text: string): SectionLanguage {
  const ru = CYRILLIC_RE.test(text);
  const en = LATIN_RE.test(text);
  if (ru && en) {
    return "mixed";
  }
  return ru ? "ru" : "en";
}

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Mirrors `collect.ts`'s frontmatter `field()`, applied to the bytes in hand. */
function fieldFromLines(lines: string[], name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * The provisional locator `wiki-specification.md` §2 allows for a legacy page:
 * `pageVersion + heading occurrence + range`, explicitly `version-bound` and
 * explicitly not promised to survive an edit.
 */
function provisionalSectionId(
  pageVersion: string | null,
  occurrence: number,
  range: { startLine: number; endLine: number },
  bodyDigest: string,
): string {
  // The digest is part of the address on purpose. Without it a locator whose
  // page version and line range happened to survive an edit would resolve
  // against a body that no longer says what the caller read — the exact
  // "query не смешивает старые offsets с новым body" failure.
  return `h${occurrence}@${pageVersion ?? "unversioned"}+${range.startLine}-${range.endLine}~${bodyDigest.slice(0, 8)}`;
}

/** Parse a provisional locator back into its parts, or null if it is not one. */
export function parseProvisionalSectionId(sectionId: string): {
  occurrence: number;
  pageVersion: string;
  startLine: number;
  endLine: number;
  bodyDigest: string;
} | null {
  const match = sectionId.match(/^h(\d+)@([^+]+)\+(\d+)-(\d+)~([0-9a-f]{8})$/);
  if (!match) {
    return null;
  }
  return {
    occurrence: Number(match[1]),
    pageVersion: match[2] ?? "",
    startLine: Number(match[3]),
    endLine: Number(match[4]),
    bodyDigest: match[5] ?? "",
  };
}

function markerForHeading(
  markers: SectionMarker[],
  headingLine: number,
  claimed: Set<string>,
): SectionMarker | null {
  for (const marker of markers) {
    if (headingLine > marker.openLine && headingLine < marker.closeLine && !claimed.has(marker.id)) {
      return marker;
    }
  }
  return null;
}

function indexPage(source: SectionSourcePage): { page: IndexedPage; issues: SectionIndexIssue[] } {
  const { page, content } = source;
  const lines = content.split("\n");
  const markers = parseMarkers(content);
  const identity = resolveWikiPageIdentity(page.relativePath, content);
  const issues: SectionIndexIssue[] = markers.issues.map((issue) => ({
    kind: issue.kind,
    page: page.relativePath,
    line: issue.line,
    message: issue.message,
  }));

  // A duplicate id inside one owner page is a validation error (spec §2). Ids
  // repeated across DIFFERENT pages are not: the owner namespace is the page,
  // which is precisely what stops identically titled sections of different
  // domains from colliding.
  const seen = new Map<string, number>();
  for (const marker of markers.sections) {
    const previous = seen.get(marker.id);
    if (previous !== undefined) {
      issues.push({
        kind: "duplicate-section-id",
        page: page.relativePath,
        line: marker.openLine,
        message: `section id "${marker.id}" is declared more than once on this page (first at line ${previous})`,
      });
      continue;
    }
    seen.set(marker.id, marker.openLine);
  }

  const { pageTitle, sections: raw } = splitSections(lines);
  const title = pageTitle ?? page.title;
  // Read from the SAME bytes the sections are split from, not from the
  // `WikiPage` a separate earlier read produced. A provisional locator is
  // `pageVersion + occurrence + range + digest`; taking the version from one
  // read of the file and the offsets from another is the very mixing the
  // criterion forbids, even if the window is small.
  const pageVersion = fieldFromLines(lines, "Version") ?? page.version;
  const claimed = new Set<string>();
  const records: WikiSectionRecord[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const section = raw[i];
    if (!section) {
      continue;
    }
    const bodyLines: string[] = [];
    for (let line = section.bodyStart; line <= section.bodyEnd; line += 1) {
      const text = lines[line - 1];
      if (text === undefined) {
        continue;
      }
      if (isMarkerLine(text)) {
        // A marker line is identity, not content: it must not reach the index,
        // the digest or an excerpt.
        continue;
      }
      bodyLines.push(text);
    }
    const body = bodyLines.join("\n").trim();
    const occurrence = i + 1;
    const bodyRange = { startLine: section.bodyStart, endLine: section.bodyEnd };

    const marker = markerForHeading(markers.sections, section.headingLine, claimed);
    const duplicated =
      marker !== null &&
      issues.some((issue) => issue.kind === "duplicate-section-id" && issue.message.includes(`"${marker.id}"`));
    // A section whose id is contested is indexed under the provisional locator
    // rather than under a contested stable id: two sections must never share
    // one address, and refusing the id is safer than picking a winner.
    const usable = marker !== null && !duplicated ? marker : null;
    if (usable) {
      claimed.add(usable.id);
    }

    const bodyDigest = digestOf(body);
    const sectionId = usable
      ? usable.id
      : provisionalSectionId(pageVersion, occurrence, bodyRange, bodyDigest);
    const indexedText = [title, ...section.headingPath, body].join("\n");

    records.push({
      pageId: identity.pageId,
      pageStability: identity.stability,
      pageRelativePath: page.relativePath,
      pageTitle: title,
      pageVersion,
      domain: page.pageType,
      sectionId,
      sectionRef: `${identity.pageId}#${sectionId}`,
      // A stable section id on a legacy page is still only as stable as the
      // page's own address, so the weaker of the two wins.
      stability: usable && identity.stability === "stable" ? "stable" : "version-bound",
      title: section.title,
      headingPath: section.headingPath,
      headingOccurrence: occurrence,
      bodyRange,
      digest: bodyDigest,
      language: detectLanguage(`${title} ${body}`),
      contentClass: classifyContent(section.title, body),
      body,
      indexedText,
    });
  }

  return {
    page: {
      relativePath: page.relativePath,
      contentDigest: digestOf(content),
      pageVersion,
      identity,
      sections: records,
    },
    issues,
  };
}

const EMPTY_INDEX: SectionIndex = {
  parserVersion: SECTION_PARSER_VERSION,
  rankingProfileVersion: RANKING_PROFILE_VERSION,
  pages: new Map(),
  pageIdentities: new Map(),
  sections: [],
  issues: [],
};

/**
 * Build the index from scratch. Pure: no I/O, no writes.
 *
 * Expressed as an invalidation against an empty index rather than as a second
 * traversal, so the partial-rebuild path is the one every build takes and
 * cannot rot into a branch nobody exercises.
 */
export function buildSectionIndex(sources: ReadonlyArray<SectionSourcePage>): SectionIndex {
  return invalidateSectionIndex(EMPTY_INDEX, sources);
}

/**
 * Rebuild only what changed (spec §2: "Add/edit/delete/rename секции
 * инвалидируют затронутую часть; query не смешивает старые offsets с новым
 * body").
 *
 * A page whose content digest is unchanged keeps its existing records
 * untouched; a changed page is re-split from its current bytes, so its ranges
 * are always the ranges of the body being served. Removed pages drop out.
 */
export function invalidateSectionIndex(
  index: SectionIndex,
  sources: ReadonlyArray<SectionSourcePage>,
): SectionIndex {
  const pages = new Map<string, IndexedPage>();
  const issues: SectionIndexIssue[] = [];
  const present = new Set(sources.map((source) => source.page.relativePath));

  for (const [relativePath, page] of index.pages) {
    if (present.has(relativePath)) {
      pages.set(relativePath, page);
    }
  }

  for (const source of sources) {
    const existing = pages.get(source.page.relativePath);
    if (existing && existing.contentDigest === digestOf(source.content)) {
      // Untouched: keep the records AND their issues as they were.
      issues.push(...index.issues.filter((issue) => issue.page === source.page.relativePath));
      continue;
    }
    const built = indexPage(source);
    pages.set(source.page.relativePath, built.page);
    issues.push(...built.issues);
  }

  return finalize(pages, issues);
}

function finalize(pages: Map<string, IndexedPage>, issues: SectionIndexIssue[]): SectionIndex {
  const sections = [...pages.values()]
    .flatMap((page) => page.sections)
    .sort((a, b) => a.sectionRef.localeCompare(b.sectionRef));
  const pageIdentities = new Map<string, PageIdentity>();
  for (const [relativePath, page] of pages) {
    pageIdentities.set(relativePath, page.identity);
  }
  return {
    parserVersion: SECTION_PARSER_VERSION,
    rankingProfileVersion: RANKING_PROFILE_VERSION,
    pages,
    pageIdentities,
    sections,
    issues: issues.sort((a, b) => a.page.localeCompare(b.page) || a.line - b.line),
  };
}

// --- tokenisation and ranking -------------------------------------------------

// `src/gdgraph/find.ts` has a 14-word English STOP set, but it is module-private
// and that file belongs to a different lane in this phase, so it is not
// imported here. The set below is the same idea, widened to the two languages
// the corpus actually contains (spec §3: "RU/EN проверяются отдельно").
const STOP_WORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "in", "into", "is", "it", "its", "of", "on", "or",
  "so", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "was",
  "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
  // Russian
  "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то", "все", "она", "так",
  "его", "но", "да", "ты", "к", "у", "же", "вы", "за", "бы", "по", "только", "ее", "мне", "было",
  "вот", "от", "меня", "еще", "нет", "о", "из", "ему", "теперь", "когда", "даже", "ну", "вдруг",
  "ли", "если", "уже", "или", "ни", "быть", "был", "него", "до", "вас", "нибудь", "опять", "уж",
  "вам", "ведь", "там", "потом", "себя", "ничего", "ей", "может", "они", "тут", "где", "есть",
  "надо", "ней", "для", "мы", "тебя", "их", "чем", "была", "сам", "чтоб", "без", "будто", "чего",
  "раз", "тоже", "себе", "под", "будет", "ж", "тогда", "кто", "этот", "того", "потому", "этого",
  "какой", "какая", "какие", "совсем", "ним", "здесь", "этом", "один", "почти", "мой", "тем",
  "чтобы", "нее", "были", "куда", "зачем", "всех", "никогда", "можно", "при", "наконец", "два",
  "об", "другой", "хоть", "после", "над", "больше", "тот", "через", "эти", "нас", "про", "всего",
  "них", "какая-то", "много", "разве", "три", "эту", "моя", "впрочем", "хорошо", "свою", "этой",
  "перед", "иногда", "лучше", "чуть", "том", "нельзя", "такой", "им", "более", "всегда",
  "конечно", "всю", "между",
]);

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Tokens for both documents and queries.
 *
 * Exact identifiers are kept whole AND split, so `spawnSync` matches a query
 * for `spawnSync`, for `spawn` and for `sync` — spec §3's "Разделить точные
 * identifiers и обычные слова". Stop words are dropped, which is the direct fix
 * for the measured defect where `"the of and is a"` scored an order of
 * magnitude above every real term on this repository's own corpus.
 */
export function tokenizeSectionText(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(IDENTIFIER_RE)) {
    const raw = match[0];
    if (!/[A-Z_0-9]/.test(raw.slice(1)) || raw.length < 3) {
      continue;
    }
    const lower = raw.toLowerCase();
    tokens.push(lower);
    for (const part of raw.split(/_+|(?<=[a-z0-9])(?=[A-Z])/)) {
      const piece = part.toLowerCase();
      if (piece.length >= 2 && piece !== lower) {
        tokens.push(piece);
      }
    }
  }
  for (const match of text.matchAll(WORD_RE)) {
    const token = match[0].toLowerCase();
    if (token.length >= 2) {
      tokens.push(token);
    }
  }
  return tokens.filter((token) => !STOP_WORDS.has(token));
}

export type RankedSection = {
  section: WikiSectionRecord;
  score: number;
  /** Which query terms hit — the reason, kept rather than dropped. */
  matched: string[];
};

export type SectionRanking = {
  ranked: RankedSection[];
  /** Query terms left after stop-word removal. Empty ⇒ the query said nothing. */
  queryTerms: string[];
  /** Terms so common in this corpus that a match on them carries no evidence. */
  ubiquitousTerms: string[];
};

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** A term present in more than this fraction of sections discriminates nothing. */
const UBIQUITY_FRACTION = 0.5;

/**
 * Deterministic BM25 over the section corpus (spec §3: "BM25 — предлагаемый
 * baseline"). No probabilities are promised and nothing here is called one: the
 * number is a ranking score, exactly as `WikiAskCitation.score` already was.
 */
export function rankSections(
  sections: ReadonlyArray<WikiSectionRecord>,
  question: string,
): SectionRanking {
  const queryTerms = [...new Set(tokenizeSectionText(question))];
  if (sections.length === 0 || queryTerms.length === 0) {
    return { ranked: [], queryTerms, ubiquitousTerms: [] };
  }

  const docs = sections.map((section) => {
    const counts = new Map<string, number>();
    for (const token of tokenizeSectionText(section.indexedText)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    let length = 0;
    for (const count of counts.values()) {
      length += count;
    }
    return { counts, length };
  });

  const total = docs.length;
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / total || 1;

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let frequency = 0;
    for (const doc of docs) {
      if (doc.counts.has(term)) {
        frequency += 1;
      }
    }
    documentFrequency.set(term, frequency);
  }

  const ubiquitousTerms = queryTerms.filter(
    (term) => (documentFrequency.get(term) ?? 0) / total > UBIQUITY_FRACTION,
  );

  const ranked: RankedSection[] = [];
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const doc = docs[i];
    if (!section || !doc) {
      continue;
    }
    let score = 0;
    const matched: string[] = [];
    for (const term of queryTerms) {
      const frequency = doc.counts.get(term) ?? 0;
      if (frequency === 0) {
        continue;
      }
      matched.push(term);
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const denominator =
        frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / averageLength);
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
    }
    if (score > 0) {
      ranked.push({ section, score: Math.round(score * 1000) / 1000, matched });
    }
  }

  ranked.sort(
    (a, b) => b.score - a.score || a.section.sectionRef.localeCompare(b.section.sectionRef),
  );
  return { ranked, queryTerms, ubiquitousTerms };
}
