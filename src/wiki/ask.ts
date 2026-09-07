// gdwiki Q&A (C4 — spec §7.4, §8.3; AC-C9). DETERMINISTIC lexical retrieval over
// the project's own collected wiki pages + current memory entries → top-k
// citations → an assembled Markdown answer. Scope is strictly the metaproject's
// wiki/memory, never an arbitrary corpus (C-8, NG-C4). An OPTIONAL C1 embedding
// rerank reorders the citation set when the memory.embedding capability
// resolves; it never changes the candidate set's provenance. No network.

import { readFile } from "node:fs/promises";
import { resolveCapability } from "../capability/seam";
import { loadMemoryConfig } from "../memory/config";
import { memoryEmbeddingSpec, type Embedder } from "../memory/embedding/adapter";
import { cosine } from "../memory/embedding/index";
import { computeLifecycle, type LifecycleState } from "../memory/lifecycle";
import { collectEntries } from "../memory/store";
import { isValidAt, validateAsOf } from "../memory/temporal";
import { collectPages } from "./collect";
import {
  buildSectionIndex,
  rankSections,
  type SectionContentClass,
  type SectionStability,
  type WikiSectionRecord,
} from "./section-index";
import type {
  WikiAskCitation,
  WikiAskInput,
  WikiAskResult,
  WikiAskStatus,
  WikiPage,
} from "./types";

const DEFAULT_K = 8;
const EXCERPT_MAX = 240;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

const RUSSIAN_TO_ENGLISH: Record<string, string> = {
  "как": "how",
  "как-то": "how",
  "какой": "which",
  "какая": "which",
  "какие": "which",
  "что": "what",
  "это": "it",
  "работает": "works",
  "работать": "work",
  "работают": "work",
  "почему": "why",
  "когда": "when",
  "где": "where",
  "есть": "is",
  "происходит": "happens",
  "шлюз": "gate",
  "gate": "gate",
  "модель": "model",
  "команда": "command",
  "команды": "commands",
  "команду": "command",
  "ошибка": "error",
  "ошибки": "errors",
  "безопасность": "security",
  "политика": "policy",
  "политики": "policy",
  "ограничение": "limit",
  "ограничения": "limits",
  "доступ": "access",
  "доступа": "access",
  "данные": "data",
  "данных": "data",
  "память": "memory",
  "памяти": "memory",
};

type Candidate = {
  path: string;
  title: string;
  text: string;
  excerpt: string;
  source: "wiki" | "memory";
  // AFC-W01 (flow 235) T5: set for a wiki candidate, which is now a SECTION
  // rather than a page's `## Summary`. Carried onto `WikiAskCitation` so the
  // section's identity, its stability and the domain that distinguishes it
  // from an identically titled section elsewhere reach every surface.
  section?: WikiSectionRecord;
  // AFC-06 (flow 234) T22: set only in historical mode (`asOf` below), and
  // only for a candidate `computeLifecycle` classified as non-current. Carried
  // straight onto `WikiAskCitation` in the map at the bottom of this function.
  historical?: boolean;
  lifecycleState?: LifecycleState;
  lifecycleReasons?: string[];
};

type Scored = { candidate: Candidate; score: number; matched: string[] };

export async function wikiAsk(input: WikiAskInput): Promise<WikiAskResult> {
  const k = input.k && input.k > 0 ? input.k : DEFAULT_K;

  // AFC-06 (flow 234) T22: same validator memory's `--as-of` already uses
  // (`validateAsOf`, `../memory/temporal.ts`) -- a malformed date is rejected
  // up front with the identical error shape, rather than silently degrading
  // every candidate to `invalid` via `computeLifecycle`'s own malformed-date
  // branch.
  const asOf = input.asOf ? validateAsOf(input.asOf, new Date()) : undefined;
  const historicalMode = Boolean(asOf);
  const observedAt = asOf ? new Date(`${asOf}T00:00:00.000Z`) : todayObservedAt();

  const candidates = [
    ...(await wikiCandidates(input.cwd, observedAt, historicalMode, asOf)),
    ...(await memoryCandidates(input.cwd, observedAt, historicalMode, asOf)),
  ];

  // AFC-07 (flow 235) T5. The old scorer was raw Jaccard over unfiltered token
  // sets, with no stop-word list and no IDF, which is why a query made only of
  // function words scored an order of magnitude ABOVE any real term on this
  // repository's own corpus and was rendered as ordinary confident prose.
  // Scoring now goes through the shared BM25 in `./section-index.ts`, which
  // drops stop words and weights by inverse document frequency, so a query that
  // says nothing produces no query terms at all.
  let outcome = scoreQuestion(input.question, candidates);

  // RU→EN fallback, unchanged in behaviour except that it no longer PERSISTS
  // anything. `upsertDynamicTranslation` used to write the user's own query
  // text into `.metaproject/runtime/wiki-ask/translations.json` from a command
  // declared non-mutating (MCP `wiki.ask` `mutating: false`, agent `wiki_ask`
  // `risk: "read"`) — a contract violation at the tool boundary and AC-30's
  // "pure search не пишет history" clause failing. The dictionary it grew was
  // also derived from this same heuristic's own output, which `wiki-
  // specification.md` §3 rules out for aliases: they must be "явные versioned
  // данные ... не скрытая LLM-генерация". Removed rather than reworked.
  if (outcome.ranked.length === 0 && CYRILLIC_RE.test(input.question)) {
    const translated = translateRussianQuestion(input.question);
    if (translated !== input.question) {
      const retry = scoreQuestion(translated, candidates);
      if (retry.ranked.length > 0) {
        outcome = { ...retry, queryTerms: [...outcome.queryTerms, ...retry.queryTerms] };
      }
    }
  }

  // One citation per owner page: its best-scoring section. Sections are the
  // retrieval unit and the address, but the CITATION LIST is a list of sources,
  // and returning the same page three times because three of its sections
  // matched both crowds out other pages and silently changes the meaning of a
  // ranked list that page-level consumers already key on — including the gdwiki
  // benchmark's page-level gold (`fixtures/benchmark/keryx/wiki-gold.json`).
  // Which section won is not lost: it is the excerpt, the title and the ref.
  const bestPerPage: Scored[] = [];
  const seenPages = new Set<string>();
  for (const item of outcome.ranked) {
    if (seenPages.has(item.candidate.path)) {
      continue;
    }
    seenPages.add(item.candidate.path);
    bestPerPage.push(item);
  }

  let top = bestPerPage.slice(0, k);

  // Optional C1 rerank of the citation set (never changes provenance/set).
  if (input.rerank) {
    top = await rerankCitations(input.cwd, input.question, top);
  }

  const citations: WikiAskCitation[] = top.map((item) => ({
    path: item.candidate.path,
    title: item.candidate.title,
    excerpt: item.candidate.section
      ? excerptAround(item.candidate.section.body || item.candidate.section.title, item.matched)
      : item.candidate.excerpt,
    score: item.score,
    source: item.candidate.source,
    matched: item.matched,
    ...(item.candidate.section
      ? {
          sectionId: item.candidate.section.sectionId,
          sectionRef: item.candidate.section.sectionRef,
          sectionTitle: item.candidate.section.title,
          sectionStability: item.candidate.section.stability satisfies SectionStability,
          contentClass: item.candidate.section.contentClass satisfies SectionContentClass,
          domain: item.candidate.section.domain,
          startLine: item.candidate.section.bodyRange.startLine,
          endLine: item.candidate.section.bodyRange.endLine,
        }
      : {}),
    ...(item.candidate.historical
      ? {
          historical: true as const,
          lifecycleState: item.candidate.lifecycleState,
          lifecycleReasons: item.candidate.lifecycleReasons,
        }
      : {}),
  }));

  const { status, reason } = classifyOutcome(outcome, citations);

  return {
    question: input.question,
    status,
    ...(reason ? { reason } : {}),
    citations,
    answerMarkdown: assembleAnswer(input.question, citations, historicalMode, status, reason),
  };
}

type Outcome = { ranked: Scored[]; queryTerms: string[]; ubiquitousTerms: string[] };

function scoreQuestion(question: string, candidates: Candidate[]): Outcome {
  // One corpus, one scorer: wiki sections and memory entries are ranked in the
  // same BM25 pass so a section never wins or loses on a different scale.
  const asSections: WikiSectionRecord[] = candidates.map((candidate, index) =>
    candidate.section
      ? candidate.section
      : ({
          // A memory entry is not a wiki section, but ranking only reads
          // `indexedText` and `sectionRef`; a synthetic record keeps both
          // sources on one comparable scale without inventing a second scorer.
          sectionRef: `memory:${index}:${candidate.path}`,
          indexedText: candidate.text,
        } as WikiSectionRecord),
  );
  const byRef = new Map<string, Candidate>();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const record = asSections[i];
    if (candidate && record) {
      byRef.set(record.sectionRef, candidate);
    }
  }

  const ranking = rankSections(asSections, question);
  const ranked: Scored[] = [];
  for (const entry of ranking.ranked) {
    const candidate = byRef.get(entry.section.sectionRef);
    if (candidate) {
      ranked.push({ candidate, score: entry.score, matched: entry.matched });
    }
  }
  return { ranked, queryTerms: ranking.queryTerms, ubiquitousTerms: ranking.ubiquitousTerms };
}

/**
 * AFC-07's second clause and AFC-M03's vocabulary, applied at the one place
 * that can tell the difference.
 *
 * The measured defect was that a zero-information query, an unbuilt index, an
 * unsupported query and a genuine no-match all produced the same cheerful
 * "no matching pages" line — or worse, for the stop-word case, a ranked list.
 */
function classifyOutcome(
  outcome: Outcome,
  citations: WikiAskCitation[],
): { status: WikiAskStatus; reason?: string } {
  if (outcome.queryTerms.length === 0) {
    return {
      status: "no-match",
      reason:
        "the question carries no content terms — every token is a stop word or shorter than two characters. " +
        "Ask with a term, an identifier or a page/section title.",
    };
  }
  if (citations.length === 0) {
    return {
      status: "no-match",
      reason: `no wiki section or memory entry contains any of: ${outcome.queryTerms.join(", ")}.`,
    };
  }
  const discriminating = outcome.queryTerms.filter(
    (term) => !outcome.ubiquitousTerms.includes(term),
  );
  const matchedDiscriminating = citations.some((citation) =>
    (citation.matched ?? []).some((term) => discriminating.includes(term)),
  );
  if (!matchedDiscriminating) {
    return {
      status: "insufficient-evidence",
      reason:
        `every match is on a term that appears throughout the corpus (${outcome.ubiquitousTerms.join(", ")}), ` +
        "so the citations below are not evidence for this question. Narrow it to a specific term, domain or page.",
    };
  }
  if (citations.every((citation) => citation.contentClass && citation.contentClass !== "substantive")) {
    return {
      status: "insufficient-evidence",
      reason:
        "the only matching sections are scaffold or generated Reference content, which does not answer a " +
        "'why' or 'which rule' question on a title match alone.",
    };
  }
  return { status: "ok" };
}

function translateRussianQuestion(question: string): string {
  const tokens = question.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (tokens.length === 0) {
    return question;
  }
  const translated = tokens.map((token) => {
    const direct = RUSSIAN_TO_ENGLISH[token];
    if (direct) {
      return direct;
    }
    const stemmed = token
      .replace(/(?:[аеёиоуыэюя]м|[ауя]ми|[ауомие]м|[а-я]+ние)$/u, "")
      .replace(/(?:ов|ы|а|я|и|е|ю|ь)$/u, "");
    return RUSSIAN_TO_ENGLISH[stemmed] ?? token;
  });
  const joined = translated.join(" ");
  return joined === question.toLowerCase() ? question : joined;
}

function todayObservedAt(): Date {
  const today = new Date().toISOString().slice(0, 10);
  return new Date(`${today}T00:00:00.000Z`);
}

// T24 (flow 234) F-004 (MAJOR): the historical-mode admission test, kept
// IDENTICAL to `searchEntries`'s own `asOf` branch (`temporalMatch`, `../
// memory/search.ts`) -- an `accepted`-status item still carrying a live
// `supersededBy` pointer is rejected unconditionally, matching that
// function's own comment: `supersedeEntry` (`../memory/supersede.ts`) always
// flips `Status` to `"superseded"` in the same write that sets the pointer,
// so `accepted` + a live `supersededBy` is never a normal state and is never
// "valid at" any date. Everything else is the shared `isValidAt` interval
// primitive (`../memory/temporal.ts`) both surfaces already import. This is
// what `--as-of` SCOPES inclusion by, as opposed to the `computeLifecycle`
// call above, which only LABELS a citation once it is already admitted.
function isAdmittedAtAsOf(
  input: {
    status: string | null;
    supersededBy?: string | null | undefined;
    validFrom?: string | null | undefined;
    validTo?: string | null | undefined;
  },
  asOf: string,
): boolean {
  if (input.status === "accepted" && input.supersededBy) {
    return false;
  }
  return isValidAt({ validFrom: input.validFrom ?? null, validTo: input.validTo ?? null }, asOf);
}

async function wikiCandidates(
  cwd: string,
  observedAt: Date,
  historicalMode: boolean,
  asOf: string | undefined,
): Promise<Candidate[]> {
  const pages = await collectPages(cwd);
  const lifecycleByPage = new Map<string, ReturnType<typeof computeLifecycle>>();
  // AFC-06 (flow 234) AC1: this used to admit every wiki page unconditionally,
  // so a future-dated, deprecated or superseded page was cited today as
  // though it were current -- the larger half of the criterion, since the
  // memory candidate path below already applies this rule.
  //
  // T20 finding 5 (flow 234 review): this used to re-read each page's raw
  // content from disk and re-parse it through `parsePageLifecycle`
  // (`./provenance.ts`), on the grounds that `collect.ts` was "out of this
  // task's ownership" and had not populated `WikiPage.validFrom`/`validTo`/
  // `supersededBy`. That was already false when written -- `collect.ts` was
  // changed by the same task and populates all three (see `types.ts`'s
  // corrected comment). Reads the already-parsed fields directly, exactly
  // mirroring `memoryCandidates` below, so a wiki page and a memory entry go
  // through the identical `computeLifecycle` call shape. `collect.ts` (see
  // its own comment there) recognizes BOTH the unhyphenated (`ValidFrom`) and
  // the memory-style hyphenated (`Valid-From`) spellings, so a page written
  // with either alias is honored on this path -- closed, see
  // `ask.test.ts`'s "a hyphenated Valid-From ... is honoured on the wiki
  // path".
  //
  // T22 (flow 234) AC1, second half: `observedAt`/`historicalMode` come from
  // `wikiAsk`'s `asOf` (default: "today", default retrieval). Default mode
  // keeps the exact `continue`-on-non-current behavior above; historical mode
  // additionally admits a non-current page but tags it with the same
  // `LifecycleResult` the classifier already computed, rather than dropping
  // it or re-deriving a second verdict for the label.
  //
  // T24 (flow 234) F-004 (MAJOR): historical mode used to admit every
  // non-current page unconditionally the instant it was on, using `asOf`
  // only to LABEL the citation -- so a future-dated or already-expired page
  // was cited as applying at `asOf` regardless of whether its own validity
  // interval actually contained that date. `isAdmittedAtAsOf` below applies
  // the SAME validity-interval test `searchEntries`'s `asOf` branch
  // (`temporalMatch`, `../memory/search.ts`) already applies to memory
  // entries, so `--as-of` scopes inclusion identically on both surfaces; the
  // label (`lifecycle.state`/`.reasons`) is unchanged.
  //
  // AFC-W01 / AFC-07 (flow 235) T5: the admitted set is unchanged — the
  // lifecycle filter above still decides WHICH pages may be cited, byte for
  // byte — but each admitted page now contributes its SECTIONS instead of one
  // `title + ## Summary` blob. That blob is the measured cause of AC1 failing:
  // `keryx wiki ask "spawnSync"` returned nothing while the term sat in the
  // Details section of `.metaproject/wiki/architecture/os-sandbox.md`.
  const admitted: WikiPage[] = [];
  for (const page of pages) {
    const lifecycle = computeLifecycle(
      {
        status: page.status,
        validFrom: page.validFrom ?? null,
        validTo: page.validTo ?? null,
        supersededBy: page.supersededBy ?? null,
      },
      observedAt,
    );
    if (!lifecycle.current) {
      if (!historicalMode) {
        continue;
      }
      if (!asOf || !isAdmittedAtAsOf(page, asOf)) {
        continue;
      }
    }
    admitted.push(page);
    lifecycleByPage.set(page.relativePath, lifecycle);
  }

  // Built in memory, from bytes already on disk. Nothing here writes: AC-30's
  // "pure search не пишет history" is a property of this function too, not only
  // of the removed translation dictionary.
  const index = buildSectionIndex(
    await Promise.all(
      admitted.map(async (page) => ({
        page,
        content: await readFile(page.absolutePath, "utf8").catch(() => ""),
      })),
    ),
  );

  const result: Candidate[] = [];
  for (const section of index.sections) {
    // A scaffold section is an empty placeholder: there is nothing in it to
    // match, and admitting it would let a title-only hit look like evidence.
    if (section.contentClass === "scaffold") {
      continue;
    }
    const lifecycle = lifecycleByPage.get(section.pageRelativePath);
    result.push({
      // `path` stays the page's own wiki-relative path, unchanged: it is what
      // every existing consumer keys on, including the gdwiki benchmark oracle's
      // page-level gold (`fixtures/benchmark/keryx/wiki-gold.json`). Section
      // identity is carried in the fields beside it, and in the title, so
      // nothing has to be re-keyed to gain it.
      path: `wiki/${section.pageRelativePath}`,
      // The section's own address, rendered where even the narrowest surface
      // sees it: `metaproject-adapter.ts`'s `wikiAsk` re-maps citations down to
      // `{path,title,excerpt,score,source}`, so a `## Details` from one domain
      // and a `## Details` from another are only distinguishable at the agent
      // boundary if the distinction is inside one of those five fields.
      title:
        section.headingPath.length > 0
          ? `${section.pageTitle} › ${section.headingPath.join(" › ")}`
          : section.pageTitle,
      text: section.indexedText,
      excerpt: truncate(section.body || section.title),
      source: "wiki" as const,
      section,
      ...(lifecycle?.historical
        ? {
            historical: true as const,
            lifecycleState: lifecycle.state,
            lifecycleReasons: lifecycle.reasons,
          }
        : {}),
    });
  }
  return result;
}

async function memoryCandidates(
  cwd: string,
  observedAt: Date,
  historicalMode: boolean,
  asOf: string | undefined,
): Promise<Candidate[]> {
  const entries = await collectEntries(cwd);
  // AFC-06 (flow 234) AC1: the shared lifecycle formula (`computeLifecycle`,
  // `../memory/lifecycle.ts`) replaces the local ad hoc check this used to
  // run, which never looked at `validFrom`/`status` and compared `validTo`
  // as an unvalidated raw string.
  //
  // T22 (flow 234) AC1, second half: same `observedAt`/`historicalMode`
  // mirroring as `wikiCandidates` above, so the memory citations `wikiAsk`
  // embeds in an answer go through the identical historical-mode admission
  // and labelling as the wiki citations do.
  //
  // T24 (flow 234) F-004 (MAJOR): same `isAdmittedAtAsOf` scoping as
  // `wikiCandidates` above. Before this fix, THIS function admitted every
  // non-current memory entry unconditionally once `historicalMode` was on --
  // so the identical memory entry `.md` file that `keryx memory search
  // --as-of` (`searchEntries`'s `temporalMatch`, `../memory/search.ts`)
  // rejects (future, expired, or an `accepted` status with a live
  // `supersededBy` pointer) was cited by `keryx wiki ask --as-of` as though
  // it applied at that date, because this function never scoped by the date
  // at all.
  const result: Candidate[] = [];
  for (const entry of entries) {
    const lifecycle = computeLifecycle(
      {
        status: entry.status,
        validFrom: entry.validFrom ?? null,
        validTo: entry.validTo ?? null,
        supersededBy: entry.supersededBy ?? null,
      },
      observedAt,
    );
    if (!lifecycle.current) {
      if (!historicalMode) {
        continue;
      }
      if (!asOf || !isAdmittedAtAsOf(entry, asOf)) {
        continue;
      }
    }
    result.push({
      path: `memory/${entry.relativePath}`,
      title: entry.title,
      text: `${entry.title} ${entry.summary} ${entry.tags.join(" ")}`.trim(),
      excerpt: truncate(entry.summary || entry.title),
      source: "memory" as const,
      ...(lifecycle.historical
        ? {
            historical: true as const,
            lifecycleState: lifecycle.state,
            lifecycleReasons: lifecycle.reasons,
          }
        : {}),
    });
  }
  return result;
}

async function rerankCitations(
  cwd: string,
  question: string,
  items: Scored[],
): Promise<Scored[]> {
  if (items.length === 0) {
    return items;
  }
  try {
    const config = await loadMemoryConfig(cwd);
    const spec = memoryEmbeddingSpec(config.index.runtime, config.index.modelAssetId);
    const adapter = await resolveCapability(cwd, spec);
    if (!adapter) {
      return items; // capability unavailable ⇒ deterministic lexical order stands
    }
    const embed: Embedder = async (texts) => adapter.run({ texts });
    const [queryVector] = await embed([question]);
    if (!queryVector) {
      return items;
    }
    const vectors = await embed(items.map((item) => item.candidate.text));
    return items
      .map((item, i) => ({
        item,
        order: i,
        sim: vectors[i] ? cosine(queryVector, vectors[i] as Float32Array) : -1,
      }))
      .sort((a, b) => b.sim - a.sim || a.order - b.order)
      .map((entry) => entry.item);
  } catch {
    return items;
  }
}

// AFC-06 (flow 234) T22: `historicalMode` echoes `wikiAsk`'s `asOf` presence
// so the answer carries a visible notice even if a reader only skims the
// markdown and never inspects individual citation lines. Per-citation marking
// (below) is what makes each historical item unmistakable on its own; this
// notice is the "so a model reading it cannot mistake it for current
// guidance" requirement applied to the answer as a whole, in the SAME text
// output a model actually reads (not only the JSON citations).
function assembleAnswer(
  question: string,
  citations: WikiAskCitation[],
  historicalMode: boolean,
  status: WikiAskStatus,
  reason: string | undefined,
): string {
  // AFC-M03 / AFC-07 (flow 235) T5: a refusal is rendered as a refusal, with
  // its machine code visible in the prose an agent actually reads. Before this,
  // a zero-information query produced ordinary confident prose ("Based on the
  // project's own wiki and memory: 1. **Project Map** — …") at exit 0, which is
  // the "failure indistinguishable from empty success" class in its worst
  // direction: a wrong answer that reads like a right one.
  if (status !== "ok") {
    const heading = status === "no-match" ? "no-match" : "insufficient-evidence";
    const body = reason ? `${reason}\n` : "";
    const partial =
      citations.length > 0
        ? `\nCandidates were found but are not treated as evidence:\n\n${renderPoints(citations)}\n`
        : "";
    return `# ${question}\n\n**${heading}** — this question was not answered from the project's wiki and memory.\n\n${body}${partial}`;
  }

  const historicalNotice = historicalMode
    ? "\n_Historical mode (`--as-of`): items marked **[HISTORICAL]** are not current and must not be applied as a confirmed current constraint._\n"
    : "";
  return `# ${question}
${historicalNotice}
Based on the project's own wiki and memory:

${renderPoints(citations)}

## Sources

${renderSources(citations)}
`;
}

function renderPoints(citations: WikiAskCitation[]): string {
  return citations
    .map((citation, i) => {
      const marker = citation.historical
        ? ` — **[HISTORICAL — not current: state=${citation.lifecycleState}; reason=${(citation.lifecycleReasons ?? []).join(", ")}]**`
        : "";
      return `${i + 1}. **${citation.title}** — ${citation.excerpt} (\`${citation.path}\`)${marker}`;
    })
    .join("\n");
}

/**
 * The stable identity reaches the agent HERE, and deliberately so.
 *
 * `metaproject-adapter.ts` maps a citation down to
 * `{path,title,excerpt,score,source}` — a section id placed only in a new
 * citation field would be dropped at that boundary, which is exactly the defect
 * the previous phase repeated: a fix that reached the facade and the command
 * line while the agent-facing surface was missed. `answer` is passed through
 * verbatim, so the Sources block carries the section ref and its stability to
 * every surface without touching a file another lane owns.
 */
function renderSources(citations: WikiAskCitation[]): string {
  return citations
    .map((citation) => {
      if (!citation.sectionRef) {
        return `- \`${citation.path}\``;
      }
      const stability =
        citation.sectionStability === "stable"
          ? "stable id"
          : "provisional locator, version-bound — not promised across an edit";
      return `- \`${citation.path}\` — section \`${citation.sectionRef}\` (${stability}; domain \`${citation.domain}\`; lines ${citation.startLine}-${citation.endLine})`;
    })
    .join("\n");
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT_MAX ? `${clean.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : clean;
}

/**
 * An excerpt that contains the term the citation was returned FOR.
 *
 * Citing a section for `spawnSync` and then showing the first 240 characters of
 * that section — which need not contain `spawnSync` at all — is a smaller
 * version of the same defect class this task is closing: the reader is given
 * something that looks like evidence and is not. The window is centred on the
 * first matched term and falls back to the head of the section when nothing
 * matched inside the body (a title-only hit).
 */
function excerptAround(body: string, matched: string[]): string {
  const clean = body.replace(/\s+/g, " ").trim();
  if (clean.length <= EXCERPT_MAX || matched.length === 0) {
    return truncate(clean);
  }
  const lower = clean.toLowerCase();
  let at = -1;
  for (const term of matched) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
    }
  }
  if (at < 0) {
    return truncate(clean);
  }
  const start = Math.max(0, at - Math.floor(EXCERPT_MAX / 3));
  const end = Math.min(clean.length, start + EXCERPT_MAX);
  const window = clean.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${window}${end < clean.length ? "…" : ""}`;
}
