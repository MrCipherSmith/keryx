import path from "node:path";

// Backlinks — the missing half of the wiki knowledge graph (the Karpathy LLM-wiki
// pattern: knowledge compounds when links are bidirectional). Wiki pages already
// link OUT (to other pages + to code via the graph-generated `Related Code`
// section); this inverts those edges so any page or code file can answer "what
// references me". Pure over an in-memory page set; the command layer does IO and
// joins the result with the code graph (gdgraph) for code targets.

export interface WikiPageRef {
  // Path relative to the repo root, e.g. ".metaproject/wiki/architecture/x.md".
  repoPath: string;
  content: string;
}

const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const CODE_SPAN = /`([^`]+)`/g;
// A code span that is a source-file reference (has a dir separator + code ext).
// Wiki `collect` writes Related Code / Key files as `src/x.ts` code spans, so
// these are the wiki→code edges the backlink inversion must also see.
const FILE_LIKE = /^[\w./@-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|scala|sh)$/;

// Extract repo-relative source paths written as inline code spans.
export function extractCodePaths(content: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  CODE_SPAN.lastIndex = 0;
  while ((match = CODE_SPAN.exec(content)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw.includes("/") && FILE_LIKE.test(raw)) {
      out.push(raw);
    }
  }
  return out;
}

// Extract local markdown link targets (skip external URLs and pure anchors).
export function extractLinks(content: string): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  LINK.lastIndex = 0;
  while ((match = LINK.exec(content)) !== null) {
    const raw = (match[1] ?? "").trim().split(/\s+/)[0] ?? "";
    if (!raw || raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("#") || raw.startsWith("mailto:")) {
      continue;
    }
    out.push(raw);
  }
  return out;
}

// Resolve a link written in `fromRepoPath` to a repo-root-relative target,
// dropping any `#anchor`. Uses posix semantics so results are stable cross-OS.
export function resolveLink(fromRepoPath: string, raw: string): string {
  const clean = (raw.split("#")[0] ?? "").trim();
  if (!clean) return "";
  const fromDir = path.posix.dirname(fromRepoPath.split(path.sep).join("/"));
  return path.posix.normalize(path.posix.join(fromDir, clean));
}

// Build the reverse index: target repo-path -> sorted list of pages linking to it.
export function buildBacklinkIndex(pages: WikiPageRef[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const add = (target: string, from: string): void => {
    if (!target) return;
    const list = index.get(target) ?? [];
    if (!list.includes(from)) {
      list.push(from);
      index.set(target, list);
    }
  };
  for (const page of pages) {
    const from = page.repoPath.split(path.sep).join("/");
    // Markdown links are page-relative; code-span file refs are repo-relative.
    for (const raw of extractLinks(page.content)) add(resolveLink(from, raw), from);
    for (const raw of extractCodePaths(page.content)) add(path.posix.normalize(raw), from);
  }
  for (const list of index.values()) list.sort();
  return index;
}

// Pages that link to `targetRepoPath` (repo-root-relative, posix or native).
export function backlinksFor(index: Map<string, string[]>, targetRepoPath: string): string[] {
  const key = path.posix.normalize(targetRepoPath.split(path.sep).join("/"));
  return index.get(key) ?? [];
}
