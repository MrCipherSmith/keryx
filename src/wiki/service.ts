import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  WIKI_INDEX_BEGIN,
  WIKI_INDEX_END,
  renderWikiIndexScaffold,
  renderWikiPage,
} from "./templates";
import {
  WIKI_PAGE_TYPES,
  WIKI_PAGE_TYPE_VALUES,
  type GdWikiService,
  type WikiBrokenLink,
  type WikiCheckLinksResult,
  type WikiCreatePageInput,
  type WikiCreatePageResult,
  type WikiIndexResult,
  type WikiLinkCheckState,
  type WikiPage,
  type WikiPageType,
  type WikiStatusResult,
  type WikiValidateIssue,
  type WikiValidateResult,
} from "./types";

const EXTERNAL_LINK = /^(https?:|mailto:|tel:)/i;

function wikiRootPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki");
}

function dataRootPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "gdwiki");
}

function linkCheckReportPath(cwd: string): string {
  return path.join(dataRootPath(cwd), "link-check", "latest.md");
}

export async function wikiStatus(cwd: string): Promise<WikiStatusResult> {
  const root = wikiRootPath(cwd);
  const enabled = await pathExists(root);
  const pages = enabled ? await collectPages(cwd) : [];

  return {
    enabled,
    wikiRoot: path.relative(cwd, root),
    totalPages: pages.length,
    countsByType: WIKI_PAGE_TYPES.map(({ type }) => ({
      type,
      count: pages.filter((page) => page.pageType === type).length,
    })),
    lastIndexGeneratedAt: await readIndexGeneratedAt(cwd),
    lastLinkCheck: await readLinkCheckState(cwd),
  };
}

export async function wikiCreatePage(
  input: WikiCreatePageInput,
): Promise<WikiCreatePageResult> {
  const typeConfig = WIKI_PAGE_TYPES.find((entry) => entry.type === input.type);
  if (!typeConfig) {
    throw new Error(
      `Unsupported page type: ${input.type}. Supported types: ${WIKI_PAGE_TYPE_VALUES.join(", ")}`,
    );
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) {
    throw new Error(
      `Invalid slug: ${input.slug}. Use lowercase letters, digits, and hyphens.`,
    );
  }

  const dir = path.join(wikiRootPath(input.cwd), typeConfig.folder);
  const filePath = path.join(dir, `${input.slug}.md`);
  const relativePath = path.relative(input.cwd, filePath);

  if ((await pathExists(filePath)) && !input.force) {
    throw new Error(
      `Page already exists: ${relativePath}. Use --force to overwrite.`,
    );
  }

  await mkdir(dir, { recursive: true });
  const title = input.title ?? slugToTitle(input.slug);
  await writeFile(
    filePath,
    renderWikiPage({ title, type: typeConfig.type }),
    "utf8",
  );

  return { path: relativePath, type: typeConfig.type, created: true };
}

export async function wikiGenerateIndex(cwd: string): Promise<WikiIndexResult> {
  const root = wikiRootPath(cwd);
  const indexPath = path.join(root, "index.md");
  const pages = await collectPages(cwd);
  const generatedAt = new Date().toISOString();
  const managedBlock = `${WIKI_INDEX_BEGIN}\n${renderIndexBody(pages, generatedAt)}\n${WIKI_INDEX_END}`;

  const existing = (await pathExists(indexPath))
    ? await readFile(indexPath, "utf8")
    : renderWikiIndexScaffold();
  const pattern = new RegExp(
    `${escapeRegExp(WIKI_INDEX_BEGIN)}[\\s\\S]*?${escapeRegExp(WIKI_INDEX_END)}`,
  );
  const replaced = pattern.test(existing)
    ? existing.replace(pattern, managedBlock)
    : `${existing.trimEnd()}\n\n${managedBlock}\n`;
  const next = replaced.endsWith("\n") ? replaced : `${replaced}\n`;

  await mkdir(root, { recursive: true });
  await writeFile(indexPath, next, "utf8");

  return {
    path: path.relative(cwd, indexPath),
    pageCount: pages.length,
    generatedAt,
  };
}

export async function wikiCheckLinks(
  cwd: string,
): Promise<WikiCheckLinksResult> {
  const root = wikiRootPath(cwd);
  const allFiles = (await pathExists(root)) ? await walkMarkdown(root) : [];
  // Skip the scaffold under `templates/`: it ships intentional placeholder links.
  const files = allFiles.filter(
    (absolutePath) =>
      !path.relative(root, absolutePath).startsWith(`templates${path.sep}`),
  );
  const broken: WikiBrokenLink[] = [];
  let checkedLinks = 0;
  let skippedExternal = 0;

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, "utf8");
    const pageRelative = path.relative(cwd, absolutePath);

    for (const target of extractLinkTargets(content)) {
      if (EXTERNAL_LINK.test(target)) {
        skippedExternal += 1;
        continue;
      }

      const filePart = target.split("#")[0] ?? "";
      if (filePart.length === 0) {
        // Pure in-page anchor, nothing to resolve on disk.
        continue;
      }

      checkedLinks += 1;
      const resolved = path.resolve(path.dirname(absolutePath), filePart);
      if (!(await pathExists(resolved))) {
        broken.push({
          page: pageRelative,
          target,
          reason: "target not found",
        });
      }
    }
  }

  const generatedAt = new Date().toISOString();
  const reportPath = linkCheckReportPath(cwd);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    renderLinkCheckReport({
      generatedAt,
      checkedPages: files.length,
      checkedLinks,
      skippedExternal,
      broken,
    }),
    "utf8",
  );

  return {
    reportPath: path.relative(cwd, reportPath),
    checkedPages: files.length,
    checkedLinks,
    skippedExternal,
    broken,
  };
}

export async function wikiValidate(cwd: string): Promise<WikiValidateResult> {
  const issues: WikiValidateIssue[] = [];
  const pages = await collectPages(cwd);

  for (const page of pages) {
    if (!page.version) {
      issues.push({
        page: page.relativePath,
        kind: "version",
        message: "missing Version field",
      });
    }
    if (!page.type) {
      issues.push({
        page: page.relativePath,
        kind: "metadata",
        message: "missing Type field",
      });
    } else if (page.type !== page.pageType) {
      issues.push({
        page: page.relativePath,
        kind: "metadata",
        message: `Type "${page.type}" does not match folder type "${page.pageType}"`,
      });
    }
    if (!page.status) {
      issues.push({
        page: page.relativePath,
        kind: "metadata",
        message: "missing Status field",
      });
    }
  }

  const linkCheck = await wikiCheckLinks(cwd);
  for (const broken of linkCheck.broken) {
    issues.push({
      page: broken.page,
      kind: "link",
      message: `broken link -> ${broken.target}`,
    });
  }

  if (await isIndexStale(cwd, pages)) {
    issues.push({
      page: path.join(path.relative(cwd, wikiRootPath(cwd)), "index.md"),
      kind: "index",
      message: "index out of date, run `gd-metapro wiki index`",
    });
  }

  return { ok: issues.length === 0, issues };
}

export function createGdWikiService(): GdWikiService {
  return {
    status: (input) => wikiStatus(input.cwd),
    createPage: (input) => wikiCreatePage(input),
    generateIndex: (input) => wikiGenerateIndex(input.cwd),
    checkLinks: (input) => wikiCheckLinks(input.cwd),
    validate: (input) => wikiValidate(input.cwd),
  };
}

async function collectPages(cwd: string): Promise<WikiPage[]> {
  const root = wikiRootPath(cwd);
  const pages: WikiPage[] = [];

  for (const { type, folder } of WIKI_PAGE_TYPES) {
    const dir = path.join(root, folder);
    if (!(await pathExists(dir))) {
      continue;
    }

    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const absolutePath = path.join(dir, entry);
      const content = await readFile(absolutePath, "utf8");
      pages.push(
        parsePage(absolutePath, `${folder}/${entry}`, type, content),
      );
    }
  }

  return pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function parsePage(
  absolutePath: string,
  relativePath: string,
  pageType: WikiPageType,
  content: string,
): WikiPage {
  const lines = content.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));

  return {
    absolutePath,
    relativePath,
    pageType,
    title: titleLine ? titleLine.slice(2).trim() : relativePath,
    version: field(lines, "Version"),
    type: field(lines, "Type"),
    status: field(lines, "Status"),
    summary: extractSummary(lines),
  };
}

function field(lines: string[], name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function extractSummary(lines: string[]): string {
  const start = lines.findIndex((line) => /^##\s+Summary\s*$/i.test(line));
  if (start < 0) {
    return "";
  }

  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s/.test(line)) {
      break;
    }
    if (line.trim().length === 0) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    collected.push(line.trim());
  }

  const summary = collected.join(" ").trim();
  return summary === "One paragraph summary." ? "" : summary;
}

function renderIndexBody(pages: WikiPage[], generatedAt: string): string {
  const lines = [`<!-- generated: ${generatedAt} | pages: ${pages.length} -->`, ""];

  for (const { type } of WIKI_PAGE_TYPES) {
    const typed = pages.filter((page) => page.pageType === type);
    lines.push(`### ${titleCase(type)}`, "");
    if (typed.length === 0) {
      lines.push("_No pages yet._", "");
      continue;
    }
    for (const page of typed) {
      const summary = page.summary ? ` - ${page.summary}` : "";
      lines.push(
        `- [${page.title}](${page.relativePath}) (${page.status ?? "draft"})${summary}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function isIndexStale(cwd: string, pages: WikiPage[]): Promise<boolean> {
  const indexPath = path.join(wikiRootPath(cwd), "index.md");
  if (!(await pathExists(indexPath))) {
    return true;
  }

  const content = await readFile(indexPath, "utf8");
  const managed = content.match(
    new RegExp(
      `${escapeRegExp(WIKI_INDEX_BEGIN)}([\\s\\S]*?)${escapeRegExp(WIKI_INDEX_END)}`,
    ),
  );
  if (!managed?.[1]) {
    return true;
  }

  return stripStamp(managed[1]) !== stripStamp(renderIndexBody(pages, ""));
}

function stripStamp(body: string): string {
  return body
    .replace(/<!--\s*generated:[^>]*-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function walkMarkdown(root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdown(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(absolutePath);
    }
  }

  return results.sort();
}

function extractLinkTargets(content: string): string[] {
  const targets: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const raw = match[1]?.trim();
    if (raw && raw.length > 0) {
      // Drop optional link titles: `(path "title")`.
      targets.push(raw.split(/\s+/)[0] ?? raw);
    }
  }

  return targets;
}

function renderLinkCheckReport({
  generatedAt,
  checkedPages,
  checkedLinks,
  skippedExternal,
  broken,
}: {
  generatedAt: string;
  checkedPages: number;
  checkedLinks: number;
  skippedExternal: number;
  broken: WikiBrokenLink[];
}): string {
  const brokenSection =
    broken.length > 0
      ? broken
          .map((item) => `- ${item.page} -> ${item.target} (${item.reason})`)
          .join("\n")
      : "- none";

  const state: WikiLinkCheckState & { skippedExternal: number } = {
    generatedAt,
    broken: broken.length,
    checkedPages,
    checkedLinks,
    skippedExternal,
  };

  return `# gdwiki link check

Generated: ${generatedAt}
Checked pages: ${checkedPages}
Checked internal links: ${checkedLinks}
Skipped external links: ${skippedExternal}
Broken links: ${broken.length}

## Broken Links

${brokenSection}

## Metadata

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
`;
}

async function readIndexGeneratedAt(cwd: string): Promise<string | null> {
  const indexPath = path.join(wikiRootPath(cwd), "index.md");
  if (!(await pathExists(indexPath))) {
    return null;
  }

  const content = await readFile(indexPath, "utf8");
  const match = content.match(/<!--\s*generated:\s*([^|]+?)\s*\|/);
  const value = match?.[1]?.trim();
  return value && value !== "never" ? value : null;
}

async function readLinkCheckState(
  cwd: string,
): Promise<WikiLinkCheckState | null> {
  const reportPath = linkCheckReportPath(cwd);
  if (!(await pathExists(reportPath))) {
    return null;
  }

  const content = await readFile(reportPath, "utf8");
  const matches = [...content.matchAll(/```json\n([\s\S]*?)```/g)];
  const last = matches.at(-1);
  if (!last?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(last[1]) as WikiLinkCheckState;
    return {
      generatedAt: parsed.generatedAt,
      broken: parsed.broken,
      checkedPages: parsed.checkedPages,
      checkedLinks: parsed.checkedLinks,
    };
  } catch {
    return null;
  }
}

function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function titleCase(type: string): string {
  return type
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
