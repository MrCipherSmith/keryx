// gdwiki Q&A (C4 — spec §7.4, §8.3; AC-C9). DETERMINISTIC lexical retrieval over
// the project's own collected wiki pages + current memory entries → top-k
// citations → an assembled Markdown answer. Scope is strictly the metaproject's
// wiki/memory, never an arbitrary corpus (C-8, NG-C4). An OPTIONAL C1 embedding
// rerank reorders the citation set when the memory.embedding capability
// resolves; it never changes the candidate set's provenance. No network.

import { resolveCapability } from "../capability/seam";
import { loadMemoryConfig } from "../memory/config";
import { memoryEmbeddingSpec, type Embedder } from "../memory/embedding/adapter";
import { cosine } from "../memory/embedding/index";
import { readJsonFileOr } from "../lib/json";
import { collectEntries } from "../memory/store";
import { jaccard, tokenSet } from "../memory/text";
import type { MemoryEntry } from "../memory/types";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { collectPages } from "./collect";
import type { WikiAskCitation, WikiAskInput, WikiAskResult, WikiPage } from "./types";
import path from "node:path";

const DEFAULT_K = 8;
const EXCERPT_MAX = 240;
const DICTIONARY_SCHEMA_VERSION = 1;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

type RuntimeRussianDictionary = {
  schemaVersion: number;
  phrases: Record<string, string>;
  terms: Record<string, string>;
  updatedAt?: string;
};

type RuntimeDictionaryState = {
  lockPath: string;
  dictPath: string;
};

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
};

export async function wikiAsk(input: WikiAskInput): Promise<WikiAskResult> {
  const k = input.k && input.k > 0 ? input.k : DEFAULT_K;
  const questionTokens = tokenSet(input.question);
  const candidates = [
    ...(await wikiCandidates(input.cwd)),
    ...(await memoryCandidates(input.cwd)),
  ];

  let scored = scoreByQuestion(input.question, questionTokens, candidates);

  const state = wikiAskDictionaryState(input.cwd);
  if (scored.length === 0 && CYRILLIC_RE.test(input.question)) {
    const translatedQuestion = await fallbackTranslateRussianQuestion(input.question, state);
    if (translatedQuestion !== input.question) {
      const translatedTokens = tokenSet(translatedQuestion);
      scored = scoreByQuestion(translatedQuestion, translatedTokens, candidates);
      if (scored.length > 0) {
        await upsertDynamicTranslation(state, input.question, translatedQuestion);
      }
    }
  }

  let top = scored.slice(0, k);

  // Optional C1 rerank of the citation set (never changes provenance/set).
  if (input.rerank) {
    top = await rerankCitations(input.cwd, input.question, top);
  }

  const citations: WikiAskCitation[] = top.map((item) => ({
    path: item.candidate.path,
    title: item.candidate.title,
    excerpt: item.candidate.excerpt,
    score: item.score,
    source: item.candidate.source,
  }));

  return {
    question: input.question,
    citations,
    answerMarkdown: assembleAnswer(input.question, citations),
  };
}

function scoreByQuestion(
  question: string,
  questionTokens: Set<string>,
  candidates: Candidate[],
): Array<{ candidate: Candidate; score: number }> {
  return candidates
    .map((candidate) => ({
      candidate,
      score: round(jaccard(questionTokens, tokenSet(candidate.text))),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));
}

function wikiAskDictionaryState(cwd: string): RuntimeDictionaryState {
  const basePath = path.join(cwd, ".metaproject", "runtime", "wiki-ask");
  return {
    lockPath: path.join(basePath, "translations.lock"),
    dictPath: path.join(basePath, "translations.json"),
  };
}

async function fallbackTranslateRussianQuestion(question: string, state: RuntimeDictionaryState): Promise<string> {
  const translations = await loadDynamicDictionary(state);
  const normalizedQuestion = normalizeLookupQuestion(question);

  const knownPhrase = translations.phrases[normalizedQuestion];
  if (knownPhrase) {
    return knownPhrase;
  }

  const translated = translateRussianQuestionWithTerms(question, translations.terms);
  if (translated !== question) {
    const normalizedTranslated = normalizeLookupQuestion(translated);
    if (normalizedTranslated !== normalizedQuestion) {
      return normalizedTranslated;
    }
  }
  return translated;
}

function translateRussianQuestionWithTerms(question: string, terms: Record<string, string>): string {
  const questionTokens = question.toLowerCase().match(/\p{L}+/gu);
  if (!questionTokens) {
    return question;
  }

  const translatedTokens = questionTokens.map((token) => {
    const directMatch = terms[token];
    if (directMatch) {
      return directMatch;
    }
    const staticMatch = RUSSIAN_TO_ENGLISH[token];
    if (staticMatch) {
      return staticMatch;
    }

    const stemmed = token
      .replace(/(?:[аеёиоуыэюя]м|[ауя]ми|[ауомие]м|[а-я]+ние)$/u, "")
      .replace(/(?:ов|ы|а|я|и|е|ю|ь)$/u, "");

    return RUSSIAN_TO_ENGLISH[stemmed] ?? token;
  });

  const translated = translatedTokens.join(" ");
  return translated === question.toLowerCase() ? question : translated;
}

async function loadDynamicDictionary(state: RuntimeDictionaryState): Promise<RuntimeRussianDictionary> {
  const fallback = { schemaVersion: DICTIONARY_SCHEMA_VERSION, phrases: {}, terms: {} };
  const raw = await readJsonFileOr<unknown>(state.dictPath, fallback);

  if (raw === fallback || raw == null || typeof raw !== "object") {
    return { schemaVersion: DICTIONARY_SCHEMA_VERSION, phrases: {}, terms: {} };
  }

  const dict = raw as Partial<RuntimeRussianDictionary>;
  return {
    phrases: isRecordStringMap(dict.phrases) ? dict.phrases : {},
    terms: isRecordStringMap(dict.terms) ? dict.terms : {},
    schemaVersion: DICTIONARY_SCHEMA_VERSION,
  };
}

function isRecordStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).every(([, v]) => typeof v === "string");
}

function normalizeLookupQuestion(question: string): string {
  return question
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

async function upsertDynamicTranslation(
  state: RuntimeDictionaryState,
  question: string,
  translatedQuestion: string,
): Promise<void> {
  const key = normalizeLookupQuestion(question);
  if (!key || key === translatedQuestion.toLowerCase()) {
    return;
  }

  try {
    const existing = await loadDynamicDictionary(state);
    if (existing.phrases[key] === translatedQuestion) {
      return;
    }

    const next = {
      phrases: { ...existing.phrases, [key]: translatedQuestion },
      terms: { ...existing.terms },
      schemaVersion: DICTIONARY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };

    await withFileLock(state.lockPath, async () => {
      await writeFileAtomic(state.dictPath, `${JSON.stringify(next, null, 2)}\n`);
    });
  } catch {
    // best-effort: dictionary growth should never block answering.
  }
}

async function wikiCandidates(cwd: string): Promise<Candidate[]> {
  const pages = await collectPages(cwd);
  return pages.map((page: WikiPage) => ({
    path: `wiki/${page.relativePath}`,
    title: page.title,
    text: `${page.title} ${page.summary}`.trim(),
    excerpt: truncate(page.summary || page.title),
    source: "wiki" as const,
  }));
}

async function memoryCandidates(cwd: string): Promise<Candidate[]> {
  const entries = await collectEntries(cwd);
  const today = new Date().toISOString().slice(0, 10);
  return entries
    .filter((entry) => isCurrent(entry, today))
    .map((entry) => ({
      path: `memory/${entry.relativePath}`,
      title: entry.title,
      text: `${entry.title} ${entry.summary} ${entry.tags.join(" ")}`.trim(),
      excerpt: truncate(entry.summary || entry.title),
      source: "memory" as const,
    }));
}

function isCurrent(entry: MemoryEntry, today: string): boolean {
  if (entry.supersededBy) {
    return false;
  }
  if (entry.validTo && entry.validTo < today) {
    return false;
  }
  return true;
}

async function rerankCitations(
  cwd: string,
  question: string,
  items: Array<{ candidate: Candidate; score: number }>,
): Promise<Array<{ candidate: Candidate; score: number }>> {
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

function assembleAnswer(question: string, citations: WikiAskCitation[]): string {
  if (citations.length === 0) {
    return `# ${question}\n\n_No matching wiki pages or memory entries were found._\n`;
  }
  const points = citations
    .map((citation, i) => `${i + 1}. **${citation.title}** — ${citation.excerpt} (\`${citation.path}\`)`)
    .join("\n");
  const sources = citations.map((citation) => `- \`${citation.path}\``).join("\n");
  return `# ${question}

Based on the project's own wiki and memory:

${points}

## Sources

${sources}
`;
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT_MAX ? `${clean.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : clean;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
