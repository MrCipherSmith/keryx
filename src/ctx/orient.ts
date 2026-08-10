import path from "node:path";
import { spawn } from "node:child_process";
import { pathExists } from "../lib/fs";
import { readFile } from "node:fs/promises";

// Orientation context for the Metaproject bootstrap + graph/wiki enforcement
// layer. Where the gdctx
// guard is a HARD gate (deterministic deny+route on raw rg/cat), graph and wiki
// are about PRECEDENCE — consult them before broad search / deep reads. A raw
// Read/Grep is not reliably a violation, so hard-blocking is the wrong altitude.
//
// The right analogue is AVAILABILITY: inject a compact, freshness-aware map of
// the code graph + wiki index at the start of every turn so the agent cannot
// "not know" that graph/wiki knowledge exists. These producers are harness-
// agnostic — they just emit bounded Markdown; a per-runtime hook (session-start
// / user-prompt-submit) decides how to surface it.

const GRAPH_SUMMARY = ["data", "gdgraph", "artifacts", "summary.md"];
const METAPROJECT_INDEX = ["index.md"];
const WIKI_INDEX = ["wiki", "index.md"];
const WIKI_BEGIN = "<!-- keryx:wiki-index:begin -->";
const WIKI_END = "<!-- keryx:wiki-index:end -->";

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|scala|sh)$/;

const INDEX_SECTIONS = ["Purpose", "Intent Router", "Enabled Modules", "Agent Operating Model"] as const;
const MAX_INDEX_CHARS = 3_200;
const MAX_INDEX_LINE_CHARS = 180;
const MAX_INDEX_LINES = 60;
const MAX_MODULE_ROWS = 12;
const MAX_WIKI_LINES = 40;

function metaPath(cwd: string, parts: string[]): string {
  return path.join(cwd, ".metaproject", ...parts);
}

function boundedIndexExcerpt(raw: string): string {
  const sections = new Map<string, string[]>();
  let projectTitle = "# Metaproject Index";
  let currentSection: string | undefined;

  for (const line of raw.split("\n")) {
    if (/^#\s+/.test(line) && !/^##\s+/.test(line)) {
      projectTitle = line;
      continue;
    }

    const section = line.match(/^##\s+(.+?)\s*$/)?.[1];
    if (section !== undefined) {
      currentSection = INDEX_SECTIONS.includes(section as (typeof INDEX_SECTIONS)[number]) ? section : undefined;
      if (currentSection !== undefined) sections.set(currentSection, [line]);
      continue;
    }
    if (currentSection !== undefined) sections.get(currentSection)?.push(line);
  }

  const candidates = [
    projectTitle,
    "",
    ...INDEX_SECTIONS.flatMap((section) => {
      const lines = sections.get(section) ?? [];
      while (lines.at(-1)?.trim().length === 0) lines.pop();
      return lines.length > 0 ? [...lines, ""] : [];
    }),
  ];
  const kept: string[] = [];
  let charCount = 0;
  for (const line of candidates) {
    const boundedLine =
      line.length > MAX_INDEX_LINE_CHARS ? `${line.slice(0, MAX_INDEX_LINE_CHARS - 1)}…` : line;
    const nextCount = charCount + boundedLine.length + (kept.length > 0 ? 1 : 0);
    if (kept.length >= MAX_INDEX_LINES || nextCount > MAX_INDEX_CHARS) break;
    kept.push(boundedLine);
    charCount = nextCount;
  }

  while (kept.at(-1)?.trim().length === 0) kept.pop();
  return [
    ...kept,
    "… (bounded excerpt — read `.metaproject/index.md` for the complete routing instructions)",
  ].join("\n");
}

// Advertise the mandatory Metaproject entrypoint only when it exists in the
// project root passed by the harness. Deliberately do not walk ancestors:
// `keryx shell` treats its launch cwd as the project boundary. The injected
// excerpt is bounded orientation; the model reads the full file via read_file.
export async function metaprojectIndexContext(cwd: string): Promise<string> {
  const file = metaPath(cwd, METAPROJECT_INDEX);
  if (!(await pathExists(file))) {
    return "";
  }

  const excerpt = boundedIndexExcerpt(await readFile(file, "utf8"));
  return [
    "## Keryx Metaproject bootstrap — mandatory entrypoint (precedence)",
    "",
    "The project root contains `.metaproject/index.md`. Before other project work, use `read_file` to read that file in full and follow its routing. The bounded excerpt below is orientation, not an enforced runtime gate. Do not search parent directories for another Metaproject.",
    "",
    "### Project-root index (bounded excerpt)",
    "",
    excerpt,
  ].join("\n");
}

// Count uncommitted code-file changes — a deterministic freshness signal that
// needs no stored build ref. Local git only; failure ⇒ 0 (never blocks/networks).
export async function uncommittedCodeCount(cwd: string): Promise<number> {
  const files = await new Promise<string[]>((resolve) => {
    try {
      const child = spawn("git", ["diff", "--name-only", "HEAD"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve([]));
      child.on("close", () => resolve(out.split("\n").map((l) => l.trim()).filter(Boolean)));
    } catch {
      resolve([]);
    }
  });
  return files.filter((f) => CODE_EXT.test(f)).length;
}

function freshnessNote(count: number): string {
  return count > 0
    ? `freshness: ${count} uncommitted code file(s) may not be reflected — \`keryx gdgraph build\` to refresh`
    : "freshness: working tree clean";
}

// Compact code-graph orientation: the Stats headline + Top Modules table from
// the gdgraph summary, plus a freshness note. Empty string if not built.
export async function graphContext(cwd: string): Promise<string> {
  const file = metaPath(cwd, GRAPH_SUMMARY);
  if (!(await pathExists(file))) {
    return "## Code graph\n\n_not built — run `keryx gdgraph build` for a navigable map._";
  }
  const lines = (await readFile(file, "utf8")).split("\n");
  const indexed = lines.find((l) => /Source files indexed:/i.test(l))?.trim();

  const start = lines.findIndex((l) => /^##\s+Top Modules/i.test(l));
  const table: string[] = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (/^##\s+/.test(line)) break;
      if (line.trim()) table.push(line);
      if (table.length >= MAX_MODULE_ROWS + 2) break; // header + separator + rows
    }
  }

  const count = await uncommittedCodeCount(cwd);
  return [
    "## Code graph (map)",
    "",
    indexed ? `- ${indexed.replace(/^-\s*/, "")}` : null,
    "",
    "### Top modules",
    ...(table.length > 0 ? table : ["(no module stats)"]),
    "",
    freshnessNote(count),
    "Use `keryx gdgraph affected <file>` / `keryx gdgraph query` for impact & relationships before broad search.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// Compact wiki orientation: the generated page index (types with pages), with
// empty `_No pages yet._` sections dropped to stay small.
export async function wikiContext(cwd: string): Promise<string> {
  const file = metaPath(cwd, WIKI_INDEX);
  if (!(await pathExists(file))) {
    return "## Wiki\n\n_no wiki index — run `keryx wiki index`._";
  }
  const raw = await readFile(file, "utf8");
  const begin = raw.indexOf(WIKI_BEGIN);
  const end = raw.indexOf(WIKI_END);
  const block = begin >= 0 && end > begin ? raw.slice(begin + WIKI_BEGIN.length, end) : raw;

  // Drop empty type sections and their headers to keep the injection tight.
  const kept: string[] = [];
  const sourceLines = block.split("\n");
  for (let i = 0; i < sourceLines.length; i += 1) {
    const line = sourceLines[i] ?? "";
    if (/^###\s+/.test(line)) {
      // Look ahead: keep the header only if a page entry follows before the next header.
      let hasPage = false;
      for (let j = i + 1; j < sourceLines.length; j += 1) {
        const next = sourceLines[j] ?? "";
        if (/^###\s+/.test(next)) break;
        if (/^\s*-\s+\[/.test(next)) {
          hasPage = true;
          break;
        }
      }
      if (hasPage) kept.push(line);
      continue;
    }
    if (/_No pages yet._/.test(line)) continue;
    if (line.trim()) kept.push(line);
    if (kept.length >= MAX_WIKI_LINES) {
      kept.push(`… (truncated — \`keryx wiki ask "<question>"\` for the rest)`);
      break;
    }
  }

  return [
    "## Wiki (knowledge index)",
    "",
    ...(kept.length > 0 ? kept : ["(no pages yet — `keryx wiki collect` to seed)"]),
    "",
    'Read the relevant page or `keryx wiki ask "<question>"` for architecture / domain / decisions before deep code reads.',
  ].join("\n");
}

// Combined turn-start orientation block: bounded project-root Metaproject
// excerpt + bounded graph map and wiki index. Safe to inject on every prompt.
export async function buildOrientation(cwd: string): Promise<string> {
  const [metaprojectIndex, graph, wiki] = await Promise.all([
    metaprojectIndexContext(cwd),
    graphContext(cwd),
    wikiContext(cwd),
  ]);
  return [
    "# keryx orientation — consult before broad search / deep reads",
    "",
    ...(metaprojectIndex.length > 0 ? [metaprojectIndex, ""] : []),
    graph,
    "",
    wiki,
  ].join("\n");
}
