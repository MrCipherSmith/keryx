// review-jev-docs — flow 333, AC1/AC2 of the frozen acceptance criteria
// (`.metaproject/flows/333-*/acceptance-criteria.md`).
//
// An ADDITIONAL, CLI-driven orchestrator reviewer that finds documentation
// sections that went STALE because of a diff. keryx computes every fact
// (which section mentions which code, which files the diff touched, which
// CLI flags disappeared) and Jev is asked exactly one narrow question per
// linked section — "given this code change, is this section now
// inaccurate?" — as a `noul` probability. keryx composes every word of the
// finding; Jev never writes prose that reaches a finding verbatim.
//
// CORE ZONE (`src/lib/import-zones.ts`): this module never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`) — the same
// discipline `src/review/ci-triage.ts` and `src/review/jev-rules.ts` already
// established (see either file's own header). The question/answer shapes
// below are chosen to satisfy `JevQuestion`/`JevAnswer` structurally with no
// import needed; `src/commands/review-jev-docs.ts` (the ADAPTER) is where
// the two actually meet.
//
// Through the security facade, not `security/redact` directly — the
// import-policy ratchet (`src/lib/import-policy.live.test.ts`) is at its cap,
// and every caller outside `src/security/` reaches redaction through
// `src/security/service.ts`.
//
// # Linking scope — the decision this flow had to make
//
// AC1 asks for a doc section to be linked to code "deterministically
// (explicit paths/symbols/CLI verbs/flags they mention, gdwiki/gdgraph
// links)". A live gdgraph/gdwiki query is not something a hermetic, no-I/O
// core module can depend on (the graph answers from the last `gdgraph
// build`, not from arbitrary fixture state a unit test controls) — so this
// module covers the four EXPLICIT, textual link kinds deterministically:
//
//   - a repo-relative path the section quotes (`src/review/jev-docs.ts`,
//     with or without backticks);
//   - a `--flag` token;
//   - a `keryx <verb...>` CLI invocation, matched against
//     `src/commands/<verb>.ts` by the adapter's own file-existence check;
//   - a backtick-quoted symbol name that appears verbatim inside one of the
//     diff's own hunks (the adapter supplies the hunk text this checks
//     against).
//
// A gdgraph-informed fifth kind (symbol -> declaring file, without needing
// the symbol name to appear in the hunk text itself) is a natural follow-up
// for the ADAPTER, which may call the live graph — this module stays pure
// and gdgraph-free so it is testable with nothing but strings.

import { redactSensitiveText } from "../security/service";
import { estimateTokens } from "./cost";
import type { ScopedRegion } from "./scope";

// ---------------------------------------------------------------------------
// AC1: deterministic markdown section extraction — no model call anywhere.
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** One markdown section: a heading and everything under it, up to (not including) the next heading at the same or a shallower level. */
export interface DocSection {
  readonly file: string;
  /** `""` for the (headingless) preamble before the first heading — never linked, since it has no heading to name in a finding. */
  readonly heading: string;
  readonly headingPath: readonly string[];
  /** 1-based line of the heading itself (or of the first line, for the headingless preamble). */
  readonly line: number;
  readonly text: string;
}

/**
 * Split `content` into sections by heading, deterministically. A section's
 * `text` is its OWN immediate content only — the heading line up to (not
 * including) the very next heading, of ANY level. A `##` section does NOT
 * absorb a nested `###` section beneath it: each heading, at every level, is
 * its own independent section with its own `headingPath` for context.
 *
 * This is deliberately flat rather than nesting (an earlier version nested
 * child content into the parent's `text`): AC1 links a SECTION to code by
 * what it explicitly mentions, and a parent section that mentions nothing
 * itself but merely CONTAINS a child that does would otherwise be reported
 * "linked" too — doubling every finding at every enclosing heading level for
 * no reason a reader could act on differently.
 */
export function extractDocSections(file: string, content: string): DocSection[] {
  const lines = content.split("\n");
  const sections: DocSection[] = [];
  const headingStack: string[] = [];
  let current: { heading: string; headingPath: string[]; startLine: number; bodyLines: string[] } | undefined;
  const preamble: string[] = [];
  let sawHeading = false;

  const flush = (): void => {
    if (current === undefined) return;
    sections.push({ file, heading: current.heading, headingPath: current.headingPath, line: current.startLine, text: current.bodyLines.join("\n").trim() });
    current = undefined;
  };

  lines.forEach((line, index) => {
    const match = HEADING_RE.exec(line);
    if (match === null) {
      if (current === undefined) {
        preamble.push(line);
      } else {
        current.bodyLines.push(line);
      }
      return;
    }
    sawHeading = true;
    flush();
    const level = match[1]!.length;
    const heading = match[2]!;
    // Truncate to the enclosing levels only — never extend with an empty
    // slot for a SKIPPED level (e.g. `#` straight to `###`): the nearer
    // known ancestor is kept rather than inserting `undefined`.
    if (level - 1 < headingStack.length) {
      headingStack.length = level - 1;
    }
    headingStack.push(heading);
    current = { heading, headingPath: [...headingStack], startLine: index + 1, bodyLines: [line] };
  });
  flush();

  if (sawHeading || preamble.some((line) => line.trim().length > 0)) {
    if (preamble.some((line) => line.trim().length > 0)) {
      sections.unshift({ file, heading: "", headingPath: [], line: 1, text: preamble.join("\n").trim() });
    }
  } else if (content.trim().length > 0) {
    // No heading anywhere in the file — the whole file is one headingless section.
    sections.push({ file, heading: "", headingPath: [], line: 1, text: content.trim() });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// AC1: explicit link extraction.
// ---------------------------------------------------------------------------

export type DocLinkKind = "path" | "flag" | "verb" | "symbol";

export interface DocLink {
  readonly kind: DocLinkKind;
  /** The path, `--flag`, `keryx verb...`, or symbol name, exactly as matched. */
  readonly value: string;
}

const PATH_RE = /`?((?:src|docs|\.metaproject|rules)\/[\w./-]*[\w])`?/g;
const FLAG_RE = /--[a-z][a-z0-9-]*/g;
const VERB_RE = /\bkeryx(?:\s+[a-z][a-z0-9-]*){1,3}\b/g;
const SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]{2,})\(?`/g;

/** Every explicit path/flag/verb/symbol token a section's text names — AC1's deterministic link surface. Deduped, insertion order. */
export function extractDocLinks(sectionText: string): DocLink[] {
  const seen = new Set<string>();
  const links: DocLink[] = [];
  const push = (kind: DocLinkKind, value: string): void => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ kind, value });
  };
  for (const match of sectionText.matchAll(PATH_RE)) push("path", match[1]!);
  for (const match of sectionText.matchAll(FLAG_RE)) push("flag", match[0]);
  for (const match of sectionText.matchAll(VERB_RE)) push("verb", match[0].replace(/\s+/g, " ").trim());
  for (const match of sectionText.matchAll(SYMBOL_RE)) push("symbol", match[1]!);
  return links;
}

/** True when any of `links` names a path the diff itself changed. */
export function linksToChangedPath(links: readonly DocLink[], changedFiles: ReadonlySet<string>): string | undefined {
  const hit = links.find((link) => link.kind === "path" && changedFiles.has(link.value));
  return hit?.value;
}

/** True when any of `links` names a symbol that appears verbatim inside one of `regions`' own hunk text — the diff touches the very identifier this section quotes. */
export function linksToChangedSymbol(links: readonly DocLink[], regions: readonly ScopedRegion[]): { readonly symbol: string; readonly region: ScopedRegion } | undefined {
  for (const link of links) {
    if (link.kind !== "symbol") continue;
    for (const region of regions) {
      if (region.text.includes(link.value)) return { symbol: link.value, region };
    }
  }
  return undefined;
}

/** True when any of `links` names a `keryx <verb>` invocation whose first verb word matches one of `changedCommandNames` (the adapter's own `src/commands/<name>.ts` existence check, changed by the diff). */
export function linksToChangedVerb(links: readonly DocLink[], changedCommandNames: ReadonlySet<string>): string | undefined {
  for (const link of links) {
    if (link.kind !== "verb") continue;
    const words = link.value.split(/\s+/);
    const verb = words[1]; // words[0] === "keryx"
    if (verb !== undefined && changedCommandNames.has(verb)) return link.value;
  }
  return undefined;
}

/** One doc section, linked to specific code the diff changed, by one of the deterministic link kinds. */
export interface LinkedSection {
  readonly section: DocSection;
  readonly linkKind: DocLinkKind;
  readonly linkedTo: string;
  readonly relevantRegions: readonly ScopedRegion[];
}

/**
 * AC1: which of `sections` are linked to code the diff changes. `regions`
 * are the diff's own retained hunks (`hunkRegionsFromDiff`); `changedFiles`
 * is their path set; `changedCommandNames` is the adapter's file-existence
 * check for `keryx <verb>` mentions. A section can match more than one link
 * kind — the first match wins, deterministically, in the order path > symbol
 * > verb (the strongest, least ambiguous evidence first).
 */
export function linkSectionsToDiff(
  sections: readonly DocSection[],
  regions: readonly ScopedRegion[],
  changedCommandNames: ReadonlySet<string> = new Set(),
): LinkedSection[] {
  const changedFiles = new Set(regions.map((r) => r.path));
  const regionsByPath = new Map<string, ScopedRegion[]>();
  for (const region of regions) {
    const list = regionsByPath.get(region.path) ?? [];
    list.push(region);
    regionsByPath.set(region.path, list);
  }
  const linked: LinkedSection[] = [];
  for (const section of sections) {
    if (section.heading === "") continue; // nothing to name in a finding
    const links = extractDocLinks(section.text);
    const path = linksToChangedPath(links, changedFiles);
    if (path !== undefined) {
      linked.push({ section, linkKind: "path", linkedTo: path, relevantRegions: regionsByPath.get(path) ?? [] });
      continue;
    }
    const symbolHit = linksToChangedSymbol(links, regions);
    if (symbolHit !== undefined) {
      linked.push({ section, linkKind: "symbol", linkedTo: symbolHit.symbol, relevantRegions: [symbolHit.region] });
      continue;
    }
    const verb = linksToChangedVerb(links, changedCommandNames);
    if (verb !== undefined) {
      const verbFile = `src/commands/${verb.split(/\s+/)[1]}.ts`;
      linked.push({ section, linkKind: "verb", linkedTo: verb, relevantRegions: regionsByPath.get(verbFile) ?? [] });
    }
  }
  return linked;
}

// ---------------------------------------------------------------------------
// AC1: bounding by --max-calls, with truncation reported.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_JEV_DOCS_CALLS = 30;

export interface JevDocsSelection {
  readonly selected: readonly LinkedSection[];
  readonly dropped: readonly LinkedSection[];
  readonly maxCalls: number;
}

/** A prefix of `linked` (stable, file/heading order), first-N kept, the rest reported dropped — never a silent truncation. */
export function boundLinkedSections(linked: readonly LinkedSection[], maxCalls: number = DEFAULT_MAX_JEV_DOCS_CALLS): JevDocsSelection {
  const sorted = [...linked].sort((a, b) => a.section.file.localeCompare(b.section.file) || a.section.line - b.section.line);
  return { selected: sorted.slice(0, maxCalls), dropped: sorted.slice(maxCalls), maxCalls };
}

// ---------------------------------------------------------------------------
// AC1: one Jev `noul` question per linked section.
// ---------------------------------------------------------------------------

/** A structural stand-in for `JevQuestion` (`type: "noul"`) — see the file header. */
export interface DocsNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

export const JEV_DOCS_TOKEN_BUDGET = 64_000;
const QUESTIONS_BUDGET_FRACTION = 0.5;
/** Per-hunk chars kept in the question's own state — a section can link to a large hunk; only the changed lines matter to the judgement. */
const HUNK_TEXT_CHARS = 2_000;
/**
 * Per-section chars kept in the question's own state. `extractDocSections`
 * is flat (a section runs to the NEXT heading of any level, see its own
 * header), but a heading-sparse file (a long narrative with few
 * sub-headings) can still produce one very large section — a live run
 * against this repository's own `docs/docs/cli-reference.md` hit the
 * vendor's real token ceiling on an unbounded section despite passing this
 * module's own 64k `estimateTokens` preflight, because the chars/4 estimate
 * undercounts a section this dense. Bounding here, the same way
 * `HUNK_TEXT_CHARS` already bounds a hunk, is cheap insurance against a
 * batch that estimates fine and still gets rejected.
 */
const SECTION_TEXT_CHARS = 4_000;

function docsQuestionKey(linked: LinkedSection): string {
  return `${linked.section.file}::${linked.section.line}`;
}

function questionFor(linked: LinkedSection): DocsNoulQuestion {
  return {
    type: "noul",
    instructions:
      `The section below (from a documentation file) is linked to code this diff changes (${linked.linkKind}: "${linked.linkedTo}"). ` +
      "Given the section's own text and the diff's relevant hunk(s), how likely is it that this section is now INACCURATE — " +
      "describing behaviour, a flag, a path, or a symbol that this diff changed in a way the section does not reflect?",
  };
}

function renderSectionFacts(linked: LinkedSection): string {
  const heading = linked.section.headingPath.join(" > ") || linked.section.heading;
  const sectionText = redactSensitiveText(linked.section.text);
  const boundedSectionText =
    sectionText.length > SECTION_TEXT_CHARS ? `${sectionText.slice(0, SECTION_TEXT_CHARS)}\n… (truncated)` : sectionText;
  return [
    `### ${linked.section.file}:${linked.section.line} (${heading})`,
    `linked via ${linked.linkKind}: ${linked.linkedTo}`,
    "section text (redacted):",
    boundedSectionText,
    "",
    "relevant hunk(s) (redacted):",
    ...linked.relevantRegions.map((region) => {
      const text = redactSensitiveText(region.text);
      const bounded = text.length > HUNK_TEXT_CHARS ? `${text.slice(0, HUNK_TEXT_CHARS)}\n… (truncated)` : text;
      return `${region.path}:${region.startLine}-${region.endLine}\n${bounded}`;
    }),
  ].join("\n");
}

export interface DocsBatch {
  readonly items: readonly LinkedSection[];
  readonly state: string;
  readonly questions: Readonly<Record<string, DocsNoulQuestion>>;
}

/** AC1: batch linked sections into as few `/systemone` requests as fit the 64k budget — mirrors `src/review/conform-jev.ts`'s `batchConformItems` shape. */
export function batchDocsSections(items: readonly LinkedSection[]): DocsBatch[] {
  const batches: DocsBatch[] = [];
  let current: LinkedSection[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      items: current,
      state: current.map(renderSectionFacts).join("\n\n"),
      questions: Object.fromEntries(current.map((item) => [docsQuestionKey(item), questionFor(item)])),
    });
    current = [];
  };

  for (const item of items) {
    const attempt = [...current, item];
    const stateTokens = estimateTokens(attempt.map(renderSectionFacts).join("\n\n"));
    const questionsTokens = estimateTokens(
      attempt.map((linked) => `${docsQuestionKey(linked)}:noul:${questionFor(linked).instructions}`).join("\n"),
    );
    const withinQuestionsShare = questionsTokens <= JEV_DOCS_TOKEN_BUDGET * QUESTIONS_BUDGET_FRACTION;
    if (current.length > 0 && (stateTokens + questionsTokens > JEV_DOCS_TOKEN_BUDGET || !withinQuestionsShare)) {
      flush();
      current = [item];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

// ---------------------------------------------------------------------------
// AC2: findings — Jev-scored, and the deterministic flag check.
// ---------------------------------------------------------------------------

export const DEFAULT_JEV_DOCS_THRESHOLD = 0.5;

export type DocsFindingSeverity = "minor";
export type DocsFindingConfidence = "high" | "medium" | "low";

export interface DocsFinding {
  readonly id: string;
  readonly severity: DocsFindingSeverity;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
  readonly problem: string;
  readonly impact: string;
  readonly suggested_fix: string;
  readonly evidence: string;
  readonly confidence: DocsFindingConfidence;
  readonly reviewer: "review-jev-docs";
  readonly dedupe_key: string;
}

function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function confidenceFor(probability: number): DocsFindingConfidence {
  if (probability >= 0.85 || probability <= 0.15) return "high";
  if (probability >= 0.65 || probability <= 0.35) return "medium";
  return "low";
}

function firstLine(text: string, max = 200): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return line.trim().slice(0, max);
}

/** AC2: one finding per linked section whose Jev `noul` probability is at/above `threshold` — Jev supplies only a number; every word below is keryx's own. */
export function synthesizeDocsFinding(linked: LinkedSection, probability: number, threshold: number = DEFAULT_JEV_DOCS_THRESHOLD): DocsFinding | undefined {
  if (probability < threshold) return undefined;
  const heading = linked.section.headingPath.join(" > ") || "(no heading)";
  const key = docsQuestionKey(linked);
  const codeChange = linked.relevantRegions
    .map((region) => `${region.path}:${region.startLine}-${region.endLine}`)
    .join(", ") || linked.linkedTo;
  return {
    id: `jev-docs-${shortHash(key)}`,
    severity: "minor",
    file: linked.section.file,
    line: linked.section.line,
    quote: firstLine(linked.section.text),
    problem: `Section "${heading}" in ${linked.section.file} is linked (${linked.linkKind}: "${linked.linkedTo}") to code this diff changed at ${codeChange}, and Jev scored it ${probability.toFixed(2)} likely stale (threshold ${threshold}).`,
    impact: "A reader following this section would be told something the code no longer does, which is worse than no documentation at all.",
    suggested_fix: `Re-read "${heading}" in ${linked.section.file} against ${codeChange} and update it to match the current behaviour.`,
    evidence: `Jev noul probability: ${probability.toFixed(2)} (threshold ${threshold}); linked via ${linked.linkKind} "${linked.linkedTo}"; hunk(s): ${codeChange}.`,
    confidence: confidenceFor(probability),
    reviewer: "review-jev-docs",
    dedupe_key: key,
  };
}

/**
 * AC2's second half: "a CLI flag renamed/removed in the diff but still
 * mentioned in docs is flagged deterministically without Jev." A flag is
 * treated as removed from `path` when it appears on a removed (`-`) line of
 * that file's hunks and never appears on any added (`+`) line of the SAME
 * file's hunks — an approximation of rename/removal that costs nothing to
 * compute and never calls Jev.
 */
export function detectRemovedFlags(regions: readonly ScopedRegion[]): Map<string, Set<string>> {
  const removedByFile = new Map<string, Set<string>>();
  const addedByFile = new Map<string, Set<string>>();
  for (const region of regions) {
    const removed = removedByFile.get(region.path) ?? new Set<string>();
    const added = addedByFile.get(region.path) ?? new Set<string>();
    for (const line of region.text.split("\n")) {
      if (line.startsWith("-") && !line.startsWith("---")) {
        for (const match of line.matchAll(FLAG_RE)) removed.add(match[0]);
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        for (const match of line.matchAll(FLAG_RE)) added.add(match[0]);
      }
    }
    removedByFile.set(region.path, removed);
    addedByFile.set(region.path, added);
  }
  const result = new Map<string, Set<string>>();
  for (const [file, removed] of removedByFile) {
    const added = addedByFile.get(file) ?? new Set<string>();
    const stillGone = new Set([...removed].filter((flag) => !added.has(flag)));
    if (stillGone.size > 0) result.set(file, stillGone);
  }
  return result;
}

/** AC2: for every doc section (not itself touched by the diff) that still mentions a flag `detectRemovedFlags` found gone, one deterministic finding — no Jev call. */
export function findDeterministicFlagFindings(
  sections: readonly DocSection[],
  removedFlagsByFile: ReadonlyMap<string, ReadonlySet<string>>,
  docFilesChangedByDiff: ReadonlySet<string>,
): DocsFinding[] {
  const findings: DocsFinding[] = [];
  for (const section of sections) {
    if (section.heading === "" || docFilesChangedByDiff.has(section.file)) continue;
    const links = extractDocLinks(section.text);
    for (const link of links) {
      if (link.kind !== "flag") continue;
      for (const [codeFile, flags] of removedFlagsByFile) {
        if (!flags.has(link.value)) continue;
        const heading = section.headingPath.join(" > ") || "(no heading)";
        const key = `${section.file}::${section.line}::${link.value}`;
        findings.push({
          id: `jev-docs-flag-${shortHash(key)}`,
          severity: "minor",
          file: section.file,
          line: section.line,
          quote: firstLine(section.text),
          problem: `Section "${heading}" in ${section.file} still mentions ${link.value}, which this diff removed (or renamed away) from ${codeFile}.`,
          impact: "A reader would try a flag that no longer exists.",
          suggested_fix: `Update "${heading}" in ${section.file}: ${link.value} no longer applies in ${codeFile} — remove or replace the mention.`,
          evidence: `Deterministic: ${link.value} appears on a removed diff line of ${codeFile} and on no added line of the same file — computed without a Jev call.`,
          confidence: "high",
          reviewer: "review-jev-docs",
          dedupe_key: key,
        });
      }
    }
  }
  return findings;
}

export function docsFindingStats(findings: readonly DocsFinding[]): Readonly<{ blocker: number; major: number; minor: number; info: number }> {
  return { blocker: 0, major: 0, minor: findings.length, info: 0 };
}

export interface JevDocsRunResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-docs";
  readonly summary: string;
  readonly findings: readonly DocsFinding[];
  readonly stats: ReturnType<typeof docsFindingStats>;
}

export function renderJevDocsMarkdown(result: JevDocsRunResult): string {
  const lines: string[] = [
    "# review-jev-docs",
    "",
    `status: ${result.status}`,
    result.summary,
    "",
    `stats: blocker=${result.stats.blocker}, major=${result.stats.major}, minor=${result.stats.minor}, info=${result.stats.info}`,
    "",
  ];
  if (result.findings.length === 0) {
    lines.push("_no stale-doc findings at or above threshold_");
    return `${lines.join("\n")}\n`;
  }
  for (const finding of result.findings) {
    lines.push(`## [${finding.id}] ${finding.severity} — ${finding.file}:${finding.line}`);
    lines.push("");
    lines.push(`- **Problem**: ${finding.problem}`);
    lines.push(`- **Impact**: ${finding.impact}`);
    lines.push(`- **Suggested fix**: ${finding.suggested_fix}`);
    lines.push(`- **Evidence**: ${finding.evidence}`);
    lines.push(`- **Confidence**: ${finding.confidence}`);
    lines.push(`- **Quote**: \`${finding.quote}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
