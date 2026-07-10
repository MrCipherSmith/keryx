import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderProjectMetaprojectReferenceBlock } from "../lib/agent-entrypoint-blocks";
import { pathExists } from "../lib/fs";
import {
  renderAgentEntrypoint,
  renderImportedAgentRules,
  renderProjectRulesSkillReadme,
} from "../lib/templates";

export type SyncedAgentRule = {
  source: string;
  ruleFile: string;
  priority: "high";
  version: "1.0.0";
};

export type SyncAgentRulesOptions = {
  enableTasks?: boolean;
  manifestSources?: string[];
  createDefault?: boolean;
};

export async function syncAgentRules(
  projectRoot: string,
  metaprojectRoot: string,
  options: SyncAgentRulesOptions = {},
): Promise<SyncedAgentRule[]> {
  const entrypoints = await findAgentEntrypoints(projectRoot, options.manifestSources ?? []);
  const sources =
    options.createDefault === false
      ? entrypoints
      : await ensureDefaultAgentEntrypoints(projectRoot, entrypoints);

  await mkdir(path.join(metaprojectRoot, "rules"), { recursive: true });
  await mkdir(path.join(metaprojectRoot, "skills", "project-rules"), { recursive: true });

  const synced: SyncedAgentRule[] = [];
  for (const source of sources) {
    const sourcePath = path.join(projectRoot, source);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    await ensureMetaprojectReference(
      sourcePath,
      options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks },
    );
    const ruleFile = ruleFileNameFor(source);
    const sourceContent = await readFile(sourcePath, "utf8");
    await writeTextIfChanged(
      path.join(metaprojectRoot, "rules", ruleFile),
      renderImportedAgentRules({ source, content: sourceContent }),
    );
    synced.push({ source, ruleFile, priority: "high", version: "1.0.0" });
  }

  await writeTextIfChanged(
    path.join(metaprojectRoot, "skills", "project-rules", "README.md"),
    renderProjectRulesSkillReadme({ sources: synced.map((rule) => rule.source) }),
  );

  return synced;
}

export async function ensureMetaprojectReference(
  filePath: string,
  options: { enableTasks?: boolean } = {},
): Promise<void> {
  const content = await readFile(filePath, "utf8");
  const marker = "<!-- keryx:index -->";
  const endMarker = "<!-- /keryx:index -->";
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: options.enableTasks !== false });
  if (content.includes(marker)) {
    const next = replaceManagedBlock(content, marker, endMarker, block);
    if (next !== content) {
      await writeFile(filePath, next, "utf8");
    }

    return;
  }

  await writeFile(filePath, insertMetaprojectBlockNearTop(content, block), "utf8");
}

export function ruleFileNameFor(source: string): string {
  return `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
}

async function findAgentEntrypoints(projectRoot: string, manifestSources: string[]): Promise<string[]> {
  const candidates = [...new Set([...manifestSources, "AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"])];
  let files = new Set<string>();
  try {
    files = new Set(await readdir(projectRoot));
  } catch {
    return [];
  }

  const existing: string[] = [];
  const seenRealPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!files.has(candidate)) {
      continue;
    }
    const candidatePath = path.join(projectRoot, candidate);
    const resolved = await realpath(candidatePath);
    if (seenRealPaths.has(resolved)) {
      continue;
    }
    seenRealPaths.add(resolved);
    existing.push(candidate);
  }
  return existing;
}

async function ensureDefaultAgentEntrypoints(projectRoot: string, entrypoints: string[]): Promise<string[]> {
  const sources = [...entrypoints];
  for (const source of ["AGENTS.md", "CLAUDE.md"]) {
    if (!sources.includes(source)) {
      await writeTextIfMissing(path.join(projectRoot, source), renderAgentEntrypoint({ source }));
      sources.push(source);
    }
  }
  return sources;
}

function replaceManagedBlock(content: string, marker: string, endMarker: string, block: string): string {
  const start = content.indexOf(marker);
  if (start < 0) {
    return content;
  }
  const end = content.indexOf(endMarker, start + marker.length);
  if (end < 0) {
    return `${content.slice(0, start)}${block}`;
  }
  return `${content.slice(0, start)}${block}${content.slice(end + endMarker.length)}`.replace(/\n{3,}/g, "\n\n");
}

function insertMetaprojectBlockNearTop(content: string, block: string): string {
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
  const lines = content.split("\n");
  let insertAt = 0;

  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end >= 0) {
      insertAt = end + 1;
      while (lines[insertAt] === "") {
        insertAt += 1;
      }
    }
  }

  if (/^#\s+/.test(lines[insertAt] ?? "")) {
    insertAt += 1;
  }

  while (lines[insertAt] === "") {
    insertAt += 1;
  }

  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(insertAt).join("\n");
  const prefix = before.length > 0 ? `${before}\n\n` : "";
  const suffix = after.length > 0 ? `\n${after}` : "";
  return `${prefix}${normalizedBlock}${suffix}`;
}

async function writeTextIfMissing(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }
  await writeFile(filePath, content, "utf8");
}

async function writeTextIfChanged(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  }
  await writeFile(filePath, content, "utf8");
}
