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
import { collectEntries } from "../memory/store";
import { jaccard, tokenSet } from "../memory/text";
import type { MemoryEntry } from "../memory/types";
import { collectPages } from "./service";
import type { WikiAskCitation, WikiAskInput, WikiAskResult, WikiPage } from "./types";

const DEFAULT_K = 8;
const EXCERPT_MAX = 240;

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

  // Deterministic lexical scoring: token overlap (Jaccard) with the question.
  // Tie-break by path so the ordering is stable regardless of collection order.
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: round(jaccard(questionTokens, tokenSet(candidate.text))),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));

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
