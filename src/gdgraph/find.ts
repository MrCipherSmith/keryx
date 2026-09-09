import type { GraphData } from "./types";
import {
  MAX_NEXT_ACTIONS,
  RETRIEVAL_NEXT_ACTIONS,
  type RetrievalCode,
} from "../lib/retrieval-codes";

// Seed-file search over the file-level graph — the "find files about X" primitive
// keryx lacked (agents kept mis-reaching for `gdgraph query "<nl>"`, which only
// does cycles/orphans). Deterministic and offline: rank file nodes by how much
// each matched query term actually NARROWS this corpus, with a basename boost,
// tie-broken by fan-in (dependents). The result is a short seed list to feed
// into `gdgraph affected <file>`.
//
// WHY TERM WEIGHTING, AND WHAT IT REPLACED (AC6 / AFC-M04, flow 235)
//
// The first version scored `matched.length * 10 + baseHits * 5`: every matched
// term was worth the same. Measured against the live index on 2026-09-08,
// `keryx gdgraph find "wiki search ranking by section"` returned sixteen files
// tied at score 15, led by `src/memory/search.ts` (dependents 12) — while
// `src/wiki/ask.ts`, the one file the question was about, scored 10 and fell
// off the end of the 20-item list.
//
// The cause was not that fan-in is consulted. It was that a hit on `search` —
// a term in nearly every path in this repository, and therefore carrying no
// information — counted exactly as much as a hit on `wiki`, which carries a
// lot. Once the scores mass-tied, global popularity chose the answer. That is
// "важный связанный код уступает нерелевантной глобальной популярности"
// verbatim.
//
// So a term is now weighted by its inverse document frequency OVER THIS GRAPH:
// how few file paths contain it. A term present in every path scores zero and
// contributes nothing ("Zero-score не добавляет ballast", specification.md §5)
// — and a file whose only hits are such terms is skipped with a `continue`, not
// a `break`, so dropping ballast never truncates the scan.
//
// Fan-in stays exactly where it belongs: a TIE-BREAK between two files the
// query cannot otherwise separate. It is never added into the score, because a
// file's global importance is not evidence that it answers this question.
//
// No new search engine is introduced (AFC-M04 is explicit about that): this is
// the same path-and-symbol lexical match it always was, with the term weights
// it should have had.

/**
 * A term present in more than this fraction of the corpus is "ubiquitous": it
 * cannot discriminate, so a candidate matching only such terms is
 * `insufficient-evidence` rather than a real hit.
 *
 * 0.5 is not chosen freshly here — it is `UBIQUITY_FRACTION` from
 * `src/wiki/section-index.ts`, kept identical on purpose so the two retrieval
 * surfaces call the same query "too weak to be evidence" at the same threshold.
 */
export const UBIQUITY_FRACTION = 0.5;

/**
 * Below this many documents, document frequency is not evidence of anything.
 *
 * In a four-file corpus "this term is in three of them" says nothing about the
 * term — and in a one-file corpus every term is trivially "in 100% of the
 * corpus", which would weight the only real answer to zero and report
 * `no-match` for a graph that plainly contains the file. So a corpus smaller
 * than this keeps the original flat scoring (`matched × 10 + basename × 5`)
 * byte for byte, and declares no term ubiquitous.
 */
export const MIN_WEIGHTED_CORPUS = 12;

export interface FindResult {
  path: string;
  /** A ranking score. Not a probability, not a percentage (specification.md §3). */
  score: number;
  matched: string[];
  /**
   * The subset of `matched` that actually narrows this corpus. This is the
   * evidence: a candidate whose `discriminating` is empty matched only on
   * noise.
   */
  discriminating: string[];
  dependents: number;
  /** Why this candidate is here, in one line — computed once, not re-derived by each renderer. */
  reason: string;
}

export interface SymbolFindResult {
  id: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  score: number;
  matched: string[];
  discriminating: string[];
  reason: string;
}

const STOP = new Set([
  "and", "the", "of", "to", "a", "an", "in", "for", "or", "with", "on", "is", "at", "by",
]);

// Split a free-text query into distinct, meaningful search terms.
export function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOP.has(t)),
    ),
  ];
}

/**
 * How much a term narrows a corpus of `total` documents, `df` of which contain
 * it. Zero when the term is in every document — it distinguishes nothing there,
 * so it must contribute nothing.
 */
function termWeight(df: number, total: number): number {
  if (total === 0 || df <= 0) {
    return 0;
  }
  if (total < MIN_WEIGHTED_CORPUS) {
    return 1;
  }
  return Math.log((total + 1) / (df + 1));
}

/**
 * Where a new word starts inside an identifier: index 0, after any separator,
 * at a camelCase hump, at the tail of an acronym (`XMLHttp` → `Http`), and at a
 * letter→digit transition.
 *
 * WHY THIS EXISTS (AC6, flow 235)
 *
 * `findSymbols` matched a query term against the whole lowercased name with
 * `includes`, which lets a term hide in the middle of an unrelated identifier.
 * Measured at the real command line on 2026-09-08:
 * `keryx gdgraph find "kubernetes helm chart"` — a query about nothing in this
 * repository — returned `DispatchArtifactRef`, because "chart" sits inside
 * "dispat-CHART-ifact". That is a nonsense query rendered as a successful
 * search, which is precisely the failure AC5 forbids and AC6's "explainable
 * candidates" rules out: no reader of that name would say it contains the word.
 */
function wordStarts(name: string): number[] {
  const isUpper = (c: string): boolean => c >= "A" && c <= "Z";
  const isLower = (c: string): boolean => c >= "a" && c <= "z";
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  const isSeparator = (c: string): boolean => !isUpper(c) && !isLower(c) && !isDigit(c);

  const starts = [0];
  for (let i = 1; i < name.length; i += 1) {
    const previous = name[i - 1] ?? "";
    const current = name[i] ?? "";
    const next = name[i + 1] ?? "";
    if (
      isSeparator(previous) ||
      (isUpper(current) && !isUpper(previous)) ||
      (isUpper(current) && isUpper(previous) && isLower(next)) ||
      (isDigit(current) && !isDigit(previous))
    ) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * Does `term` (already lowercased) occur in `name` at a word boundary?
 *
 * A prefix of the whole name still counts, so `find "clonePipeline"` keeps
 * returning `clonePipelineDeep`.
 */
function matchesAtWordBoundary(name: string, term: string): boolean {
  const lower = name.toLowerCase();
  if (lower.length !== name.length) {
    // A locale-folding name (non-ASCII) shifts the indices; fall back rather
    // than reporting a boundary that may not be one.
    return lower.includes(term);
  }
  for (const start of wordStarts(name)) {
    if (lower.startsWith(term, start)) {
      return true;
    }
  }
  return false;
}

function documentFrequencies(
  terms: string[],
  documents: string[],
  matches: (document: string, term: string) => boolean = (document, term) =>
    document.includes(term),
): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const document of documents) {
      if (matches(document, term)) {
        count += 1;
      }
    }
    frequencies.set(term, count);
  }
  return frequencies;
}

function ubiquitousOf(
  terms: string[],
  frequencies: Map<string, number>,
  total: number,
): string[] {
  if (total < MIN_WEIGHTED_CORPUS) {
    return [];
  }
  return terms.filter((term) => (frequencies.get(term) ?? 0) / total > UBIQUITY_FRACTION);
}

function reasonFor(
  matched: string[],
  discriminating: string[],
  boost: string | undefined,
  dependents: number | undefined,
): string {
  const parts = [`matched ${matched.join(", ")}`];
  parts.push(
    discriminating.length > 0
      ? `narrowing on ${discriminating.join(", ")}`
      : "no narrowing term — every hit is corpus-wide",
  );
  if (boost) {
    parts.push(boost);
  }
  if (dependents !== undefined) {
    // Named as a tie-break in the reason itself, because "this file has a lot
    // of dependents" is exactly the wrong thing for a reader to mistake for
    // evidence that it answers the question.
    parts.push(`fan-in ${dependents} (tie-break only)`);
  }
  return parts.join("; ");
}

/**
 * What is on the PAGE, when that differs from what the scan found.
 *
 * THE THIRD AND FOURTH INSTANCES (flow 235, T15)
 *
 * Separating matching from ranking (see the note below) stopped a display
 * decision from choosing a `code`. It did not stop one from writing the PROSE.
 * Reproduced on a 100-file corpus with 40 genuine matches:
 *
 *   code: ok
 *   reason: "20 files and 0 symbols matched."      // 40 did
 *
 * and, through the MCP boundary, `fileLimit: 0` produced `"0 files and 0
 * symbols matched."` — a page size rendered as a fact about the corpus, at
 * `code: ok`. The same shape sat in `insufficient-evidence`, whose tail chose
 * between "the ranking below is not evidence" and "Every match scored zero" by
 * asking how long the PAGE was: at `fileLimit: 0` it asserted every match
 * scored zero while sixty matches scored ~5.
 *
 * The rule that closes both: a reason may state what MATCHED only from the
 * scan, and what is SHOWN only as a separate, explicitly-labelled clause. A
 * reader must always be able to tell "40 matched, showing 20" from "20
 * matched"; the two can never be collapsed into one number again.
 */
function displayNote(
  matchedFiles: number,
  matchedSymbols: number,
  shownFiles: number,
  shownSymbols: number,
): string {
  const cut: string[] = [];
  if (shownFiles !== matchedFiles) {
    cut.push(`${shownFiles} of ${matchedFiles} files`);
  }
  if (shownSymbols !== matchedSymbols) {
    cut.push(`${shownSymbols} of ${matchedSymbols} symbols`);
  }
  if (cut.length === 0) {
    return "";
  }
  return (
    ` Showing ${cut.join(" and ")} — the rest are below the display limit or scored zero.` +
    " That is a ranking decision about this page, not a claim about the corpus."
  );
}

// MATCHING vs RANKING — WHY THESE ARE TWO STEPS (flow 235, T14)
//
// They used to be one loop, and that produced a false statement about the
// world. Reproduced at the real command line on 2026-09-08, in a temp project
// of 14 files ALL under `alpha/`, after a real `keryx gdgraph build`:
//
//   $ keryx gdgraph find "alpha" --json
//   { "code": "no-match",
//     "reason": "the search completed over 14 indexed files; no path or symbol
//                contains any of: alpha.",
//     "ubiquitousTerms": ["alpha"], "files": [] }          exit=0
//
// Every one of the fourteen paths contains `alpha`. The payload even said so —
// `ubiquitousTerms: ["alpha"]` sat in the same object as a reason denying it.
//
// The mechanism: `alpha` is in ALL 14 documents, so `termWeight` returns
// `log(15/15) = 0`, every file scored 0, and the ballast filter dropped every
// one of them. `findCandidates` then read the empty list as "nothing matched"
// and made a claim about the corpus that the corpus contradicts — at exit 0,
// sending the caller off to a text search they did not need.
//
// Dropping zero-weight ballast is a RANKING decision: it says "this file is not
// worth showing you", never "this file does not exist". So the scan below
// collects every file that matched, score included and nothing filtered, and
// ranking is a separate step applied only to what gets DISPLAYED. The
// classifier reads the scan, never the ranked page — which is also why slicing
// to `limit` can no longer decide a code either.

interface FileScan {
  /** Every file whose path contains ≥1 query term. Unfiltered, unsorted, unsliced. */
  readonly matches: FindResult[];
  readonly ubiquitous: string[];
  readonly corpusSize: number;
}

function scanFiles(graph: GraphData, query: string): FileScan {
  const terms = tokenize(query);
  const files = graph.nodes.filter((node) => node.kind === "file");
  const paths = files.map((node) => node.path.toLowerCase());
  const frequencies = documentFrequencies(terms, paths);
  const ubiquitous = ubiquitousOf(terms, frequencies, paths.length);
  const ubiquitousSet = new Set(ubiquitous);
  const scan = { ubiquitous, corpusSize: files.length };

  if (terms.length === 0) {
    return { matches: [], ...scan };
  }

  // fan-in (dependents) per node id: how many edges point at it.
  const fanIn = new Map<string, number>();
  for (const edge of graph.edges) {
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }

  const matches: FindResult[] = [];
  for (const node of files) {
    const lowerPath = node.path.toLowerCase();
    const base = lowerPath.split("/").pop() ?? lowerPath;
    const matched = terms.filter((t) => lowerPath.includes(t));
    if (matched.length === 0) {
      continue;
    }
    const basenameHits = matched.filter((t) => base.includes(t));
    let score = 0;
    for (const term of matched) {
      const weight = termWeight(frequencies.get(term) ?? 0, paths.length);
      // The basename boost is weighted too: a filename hit on a term that
      // narrows nothing is still worth nothing.
      score += weight * 10 + (basenameHits.includes(term) ? weight * 5 : 0);
    }
    const dependents = fanIn.get(node.id) ?? 0;
    const discriminating = matched.filter((term) => !ubiquitousSet.has(term));
    matches.push({
      path: node.path,
      score,
      matched,
      discriminating,
      dependents,
      reason: reasonFor(
        matched,
        discriminating,
        basenameHits.length > 0 ? `in the filename (${basenameHits.join(", ")})` : undefined,
        dependents,
      ),
    });
  }
  return { matches, ...scan };
}

/**
 * The ranking half: drop zero-score ballast, order, and cut to `limit`.
 *
 * Every decision here is about what is worth SHOWING. None of it may reach the
 * classifier — see the note above `scanFiles`.
 */
function rankFiles(matches: readonly FindResult[], limit = 20): FindResult[] {
  return matches
    .filter((match) => match.score > 0)
    .sort(
      // Score first, fan-in ONLY as a tie-break: global popularity may separate
      // two files the query cannot, and may never outrank the query itself.
      (a, b) => b.score - a.score || b.dependents - a.dependents || a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}

// Match symbol nodes by name — the precise half of `find` when the symbol layer
// is active. Exact name match is boosted so `find "clonePipeline"` returns the
// definition, not just path hits. Term weighting is computed over symbol NAMES
// (their own corpus), not over paths: a term common among file paths can still
// be a precise symbol name and vice versa.
function scanSymbols(graph: GraphData, query: string): SymbolFindResult[] {
  const terms = tokenize(query);
  const symbols = graph.symbols ?? [];
  if (terms.length === 0 || symbols.length === 0) {
    return [];
  }

  // Frequencies are counted with the SAME predicate the match uses, so a term
  // cannot be rare by one rule and common by another.
  const names = symbols.map((symbol) => symbol.name);
  const frequencies = documentFrequencies(terms, names, matchesAtWordBoundary);
  const ubiquitous = new Set(ubiquitousOf(terms, frequencies, names.length));

  const matches: SymbolFindResult[] = [];
  for (const symbol of symbols) {
    const nameLower = symbol.name.toLowerCase();
    const matched = terms.filter((t) => matchesAtWordBoundary(symbol.name, t));
    if (matched.length === 0) {
      continue;
    }
    const exactBonus = terms.some((t) => nameLower === t) ? 20 : 0;
    let score = exactBonus;
    for (const term of matched) {
      score += termWeight(frequencies.get(term) ?? 0, names.length) * 10;
    }
    const discriminating = matched.filter((term) => !ubiquitous.has(term));
    matches.push({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      path: symbol.path,
      startLine: symbol.startLine,
      score,
      matched,
      discriminating,
      reason: reasonFor(
        matched,
        discriminating,
        exactBonus > 0 ? "exact symbol name" : undefined,
        undefined,
      ),
    });
  }
  return matches;
}

/** Ranking only — a name whose hits are all corpus-wide, with no exact match, is not worth showing. */
function rankSymbols(matches: readonly SymbolFindResult[], limit = 15): SymbolFindResult[] {
  return matches
    .filter((match) => match.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine,
    )
    .slice(0, limit);
}

export function findSymbols(graph: GraphData, query: string, limit = 15): SymbolFindResult[] {
  return rankSymbols(scanSymbols(graph, query), limit);
}

export function findNodes(graph: GraphData, query: string, limit = 20): FindResult[] {
  return rankFiles(scanFiles(graph, query).matches, limit);
}

/**
 * `find` with an AC5 outcome code attached (AFC-M03).
 *
 * The measured defect: `keryx gdgraph find` printed "No files or symbols
 * matched" for a genuine no-match AND for a directory with no graph at all,
 * and printed a confident ranked list for a query whose only matching term was
 * in most of the corpus. Four different situations, one indistinguishable
 * answer, all at exit 0.
 *
 * The classification order matters and is not arbitrary: an index that cannot
 * answer must be reported before "nothing matched", because "nothing matched"
 * is a claim about the corpus and an empty index has no standing to make it.
 *
 * For the same reason (T14) every test below reads the SCAN — the full set of
 * files and symbols that matched — and never `foundFiles`/`foundSymbols`, which
 * are the ranked, ballast-free, `limit`-sliced page meant for a reader. A
 * display decision must never be able to turn a corpus that contains your terms
 * into a `no-match` that says it does not.
 *
 * T15 extends that from the conditions to the REASONS. `foundFiles`/
 * `foundSymbols` may appear in a reason only through `displayNote`, which
 * labels the number as a page size; every count a reason states as a fact about
 * the corpus comes from the scan. `find-display-truth.test.ts` pins this.
 */
export interface FindOutcome {
  readonly code: RetrievalCode;
  readonly reason: string;
  readonly nextActions: readonly string[];
  readonly files: FindResult[];
  readonly symbols: SymbolFindResult[];
  readonly queryTerms: string[];
  readonly ubiquitousTerms: string[];
}

export interface FindOptions {
  readonly fileLimit?: number;
  readonly symbolLimit?: number;
}

export function findCandidates(
  graph: GraphData,
  query: string,
  options: FindOptions = {},
): FindOutcome {
  const queryTerms = tokenize(query);
  const scan = scanFiles(graph, query);
  const symbolMatches = scanSymbols(graph, query);
  const ubiquitousTerms = scan.ubiquitous;

  const empty = { files: [], symbols: [], queryTerms, ubiquitousTerms };

  if (query.trim().length === 0) {
    return outcome("invalid-input", "no query was given — `find` needs at least one term.", empty);
  }
  if (scan.corpusSize === 0) {
    return outcome(
      "index-incomplete",
      "the graph index holds no file nodes — it was never built here, or its storage is unreadable. " +
        "This is not a statement about whether the code exists.",
      empty,
    );
  }
  if (queryTerms.length === 0) {
    // Aligned word-for-word with the wiki lane's classifier
    // (`src/wiki/ask.ts`) so the same situation gets the same code and the
    // same explanation on both retrieval surfaces.
    return outcome(
      "no-match",
      "the query carries no content terms — every token is a stop word or shorter than two characters.",
      empty,
    );
  }

  const foundFiles = rankFiles(scan.matches, options.fileLimit);
  const foundSymbols = rankSymbols(symbolMatches, options.symbolLimit);
  const found = { files: foundFiles, symbols: foundSymbols, queryTerms, ubiquitousTerms };

  const matchCount = scan.matches.length + symbolMatches.length;
  if (matchCount === 0) {
    return outcome(
      "no-match",
      `the search completed over ${scan.corpusSize} indexed files; no path or symbol contains any of: ${queryTerms.join(", ")}.`,
      found,
    );
  }

  const note = displayNote(
    scan.matches.length,
    symbolMatches.length,
    foundFiles.length,
    foundSymbols.length,
  );

  const anyDiscriminating =
    scan.matches.some((file) => file.discriminating.length > 0) ||
    symbolMatches.some((symbol) => symbol.discriminating.length > 0);
  if (!anyDiscriminating) {
    const noise = ubiquitousTerms.join(", ") || queryTerms.join(", ");
    // "Did anything score?" is a question about the SCAN. Asking the page
    // instead (`foundFiles.length + foundSymbols.length > 0`) let `fileLimit: 0`
    // turn sixty scoring matches into "Every match scored zero" — see
    // `displayNote`.
    const anyScored =
      scan.matches.some((file) => file.score > 0) ||
      symbolMatches.some((symbol) => symbol.score > 0);
    return outcome(
      "insufficient-evidence",
      `${matchCount} candidates matched, every one of them only on ${noise} — ` +
        "a term that appears across this corpus and so narrows nothing" +
        (anyScored
          ? ", which is why the ranking below is not evidence for this question."
          : ". Every match scored zero, so no ranking is shown; this is not a claim " +
            "that the corpus lacks your terms — it is that they cannot separate anything in it.") +
        note,
      found,
    );
  }

  return outcome(
    "ok",
    `${scan.matches.length} files and ${symbolMatches.length} symbols matched.` + note,
    found,
  );
}

function outcome(
  code: RetrievalCode,
  reason: string,
  rest: {
    files: FindResult[];
    symbols: SymbolFindResult[];
    queryTerms: string[];
    ubiquitousTerms: string[];
  },
): FindOutcome {
  const nextActions = RETRIEVAL_NEXT_ACTIONS[code].slice(0, MAX_NEXT_ACTIONS);
  return { code, reason, nextActions, ...rest };
}
