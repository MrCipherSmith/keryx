import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { pathExists, toPosix, writeFileAtomic } from "../lib/fs";
import { BUNDLED_GDSKILLS } from "./catalog";
import {
  createProjectSkill,
  resolveOriginPath,
  type CreateProjectSkillResult,
} from "./project-skills";
import { guardOutput, prepareOutputForPersistence } from "../security/guard";

const BUNDLED_NAMES = new Set(BUNDLED_GDSKILLS.map((entry) => entry.name));

export type SkillFetcher = (url: string) => Promise<{ ok: boolean; status: number; text: string }>;

export type ImportProjectSkillsOptions = {
  projectRoot: string;
  from: string;
  module?: string;
  name?: string;
  /**
   * Only import directory children whose names start with this prefix.
   * `keryx review import` uses `review-vantage-` so generic copies of bundled
   * reviewers cannot sneak in. `keryx skills import` does not set a prefix;
   * it skips bundled names instead.
   */
  namePrefix?: string;
  dryRun?: boolean;
  force?: boolean;
  fetcher?: SkillFetcher;
};

export type ImportedProjectSkill = {
  name: string;
  module: string;
  status: "imported" | "overwritten" | "skipped" | "would-import" | "would-overwrite" | "updated";
  path: string;
  origin: string;
  reason?: string;
  wired?: string;
};

export type ImportProjectSkillsResult = {
  from: string;
  imported: ImportedProjectSkill[];
  dryRun: boolean;
  force: boolean;
};

const DEFAULT_FETCHER: SkillFetcher = async (url) => {
  const response = await fetch(url);
  return { ok: response.ok, status: response.status, text: await response.text() };
};

/**
 * Copy one or more SKILL.md packages into `.metaproject/project-skills/<module>/<name>/`.
 *
 * `--from` is a directory of packages, a SKILL.md file, or an https GitHub URL
 * to a SKILL.md. Origin is stored and hashed so `keryx skills update` /
 * `keryx review reviewers` can later report drift.
 *
 * A skill whose name collides with a bundled gdskill is skipped unless
 * `--force` — otherwise it would shadow the engine.
 *
 * `module=review` is the only module `review-orchestrator` auto-dispatches.
 * Other modules land in the registry and `keryx skills route`, but are not
 * injected into flow-orchestrator's fixed pipeline.
 */
export async function importProjectSkills(options: ImportProjectSkillsOptions): Promise<ImportProjectSkillsResult> {
  const sources = await resolveImportSources(options);
  if (sources.length === 0) {
    throw new Error(
      `keryx skills import: nothing to import from ${options.from}. Pass a SKILL.md, a directory of skill packages, or an https GitHub URL to a SKILL.md.`,
    );
  }

  const imported: ImportedProjectSkill[] = [];
  for (const source of sources) {
    imported.push(await importOne(options, source));
  }
  return {
    from: options.from,
    imported,
    dryRun: options.dryRun === true,
    force: options.force === true,
  };
}

export type UpdateProjectSkillsOptions = {
  projectRoot: string;
  skill?: string;
  all?: boolean;
  from?: string;
  dryRun?: boolean;
  fetcher?: SkillFetcher;
};

/**
 * Re-read each selected skill's Origin and overwrite SKILL.md when the source
 * moved on. A skill with no Origin is skipped, not guessed.
 */
export async function updateProjectSkills(options: UpdateProjectSkillsOptions): Promise<ImportProjectSkillsResult> {
  const registry = await readRegistry(options.projectRoot);
  const selected = selectForUpdate(registry, options);
  if (selected.length === 0) {
    throw new Error(
      options.skill
        ? `keryx skills update: project skill not found: ${options.skill}`
        : "keryx skills update: no project skills with an Origin. Pass --all after an import, or name module/skill.",
    );
  }

  const imported: ImportedProjectSkill[] = [];
  for (const entry of selected) {
    imported.push(await updateOne(options, entry));
  }
  return {
    from: options.from ?? "(each skill Origin)",
    imported,
    dryRun: options.dryRun === true,
    force: true,
  };
}

export function renderImportProjectSkillsMarkdown(result: ImportProjectSkillsResult): string {
  const counts = countByStatus(result.imported);
  const lines = [
    "# skills import",
    "",
    `from: ${result.from}`,
    `dry-run: ${result.dryRun ? "yes" : "no"}`,
    `force: ${result.force ? "yes" : "no"}`,
    `imported: ${counts.imported} overwritten: ${counts.overwritten} updated: ${counts.updated} skipped: ${counts.skipped} would-import: ${counts["would-import"]} would-overwrite: ${counts["would-overwrite"]}`,
    "",
  ];
  for (const row of result.imported) {
    const extra = [row.reason, row.wired].filter(Boolean).join(" — ");
    lines.push(`- ${row.module}/${row.name}: ${row.status}${extra ? ` — ${extra}` : ""}`);
  }
  lines.push("");
  if (result.imported.some((row) => row.module === "review" && row.status !== "skipped")) {
    lines.push("Reviewers: `keryx review reviewers` must list every imported review/* name. That is the same call review-orchestrator makes.");
  }
  if (result.imported.some((row) => row.module !== "review" && row.status !== "skipped")) {
    lines.push(
      "Non-review modules are registered for `keryx skills route`. They are NOT injected into flow-orchestrator's fixed pipeline — name the skill in a dispatch if you want it there.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function githubBlobToRaw(url: string): string {
  const trimmed = url.trim();
  const blob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(trimmed);
  if (blob) {
    const [, owner, repo, ref, rest] = blob;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.split("?")[0]}`;
  }
  const rawGh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/.exec(trimmed);
  if (rawGh) {
    const [, owner, repo, ref, rest] = rawGh;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.split("?")[0]}`;
  }
  return trimmed.split("?")[0] ?? trimmed;
}

export function isHttpsSkillUrl(from: string): boolean {
  return /^https:\/\//i.test(from.trim());
}

type ImportSource = {
  name: string;
  module: string;
  origin: string;
  content: string;
};

async function resolveImportSources(options: ImportProjectSkillsOptions): Promise<ImportSource[]> {
  if (isHttpsSkillUrl(options.from)) {
    return [await sourceFromUrl(options)];
  }
  const resolved = resolveOriginPath(options.from, options.projectRoot);
  if (!(await pathExists(resolved))) {
    throw new Error(`keryx skills import: --from ${options.from} does not exist (resolved to ${resolved})`);
  }
  const stats = await stat(resolved);
  if (stats.isFile()) {
    return [await sourceFromFile(options, resolved, options.from)];
  }
  if (!stats.isDirectory()) {
    throw new Error(`keryx skills import: --from ${options.from} is not a file or directory`);
  }
  return sourceFromDirectory(options, resolved);
}

async function sourceFromUrl(options: ImportProjectSkillsOptions): Promise<ImportSource> {
  const url = options.from.trim();
  if (!/^https:\/\/(github\.com|raw\.githubusercontent\.com)\//i.test(url)) {
    throw new Error(
      "keryx skills import: a remote --from must be an https GitHub URL to a SKILL.md (github.com/.../blob/... or raw.githubusercontent.com). Other hosts are refused.",
    );
  }
  if (/\/tree\//.test(url)) {
    throw new Error(
      "keryx skills import: a GitHub tree URL cannot be listed. Point --from at a SKILL.md file (blob or raw), not a directory.",
    );
  }
  const raw = githubBlobToRaw(url);
  const fetcher = options.fetcher ?? DEFAULT_FETCHER;
  const response = await fetcher(raw);
  if (!response.ok) {
    throw new Error(`keryx skills import: failed to fetch ${raw}: HTTP ${response.status}`);
  }
  const name = options.name ?? inferNameFromUrl(raw);
  const moduleName = options.module ?? inferModule(name, response.text);
  return { name, module: moduleName, origin: url, content: response.text };
}

async function sourceFromFile(
  options: ImportProjectSkillsOptions,
  absolute: string,
  originRef: string,
): Promise<ImportSource> {
  const content = await readFile(absolute, "utf8");
  const name = options.name ?? inferNameFromPath(absolute, content);
  const moduleName = options.module ?? inferModule(name, content);
  return { name, module: moduleName, origin: originRef, content };
}

async function sourceFromDirectory(
  options: ImportProjectSkillsOptions,
  absolute: string,
): Promise<ImportSource[]> {
  const roots = await skillPackageDirs(absolute);
  const sources: ImportSource[] = [];
  for (const dir of roots) {
    const name = path.basename(dir);
    if (options.namePrefix && !name.startsWith(options.namePrefix)) continue;
    if (options.name && name !== options.name) continue;
    const skillMd = path.join(dir, "SKILL.md");
    const content = await readFile(skillMd, "utf8");
    const moduleName = options.module ?? inferModule(name, content);
    sources.push({ name, module: moduleName, origin: skillMd, content });
  }
  return sources.sort((a, b) => `${a.module}/${a.name}`.localeCompare(`${b.module}/${b.name}`));
}

async function skillPackageDirs(root: string): Promise<string[]> {
  if (await pathExists(path.join(root, "SKILL.md"))) {
    return [root];
  }
  const nestedSkills = path.join(root, "skills");
  const scan = (await pathExists(nestedSkills)) ? nestedSkills : root;
  const entries = await readdir(scan, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(scan, entry.name);
    if (await pathExists(path.join(dir, "SKILL.md"))) {
      dirs.push(dir);
    }
  }
  return dirs;
}

async function importOne(options: ImportProjectSkillsOptions, source: ImportSource): Promise<ImportedProjectSkill> {
  const dest = path.posix.join(".metaproject", "project-skills", source.module, source.name);
  const destAbs = path.join(options.projectRoot, dest, "SKILL.md");
  const exists = await pathExists(destAbs);
  const bundled = BUNDLED_NAMES.has(source.name);

  if (bundled && !options.force) {
    return {
      name: source.name,
      module: source.module,
      status: "skipped",
      path: dest,
      origin: source.origin,
      reason: "name collides with a bundled keryx skill; pass --force to shadow it",
    };
  }

  if (exists && !options.force) {
    return {
      name: source.name,
      module: source.module,
      status: "skipped",
      path: dest,
      origin: source.origin,
      reason: "already exists; pass --force to overwrite",
      wired: wiringNote(source.module),
    };
  }

  if (options.dryRun) {
    return {
      name: source.name,
      module: source.module,
      status: exists ? "would-overwrite" : "would-import",
      path: dest,
      origin: source.origin,
      wired: wiringNote(source.module),
    };
  }

  const created = await createProjectSkill(options.projectRoot, {
    target: source.name,
    module: source.module,
    name: source.name,
    note: `Imported from ${options.from}`,
    origin: source.origin,
    originContent: source.content,
    format: "single",
  });
  await overwriteImportedSkill(options.projectRoot, created, source.content);

  return {
    name: source.name,
    module: source.module,
    status: exists ? "overwritten" : "imported",
    path: created.skillPath,
    origin: source.origin,
    wired: wiringNote(source.module),
  };
}

type RegistryEntry = { module: string; name: string; path: string };

async function updateOne(options: UpdateProjectSkillsOptions, entry: RegistryEntry): Promise<ImportedProjectSkill> {
  const skillMd = path.join(options.projectRoot, entry.path, "SKILL.md");
  const current = await readFile(skillMd, "utf8");
  const origin = options.from ?? metadataLine(current, "Origin");
  if (!origin) {
    return {
      name: entry.name,
      module: entry.module,
      status: "skipped",
      path: entry.path,
      origin: "",
      reason: "no Origin recorded",
    };
  }

  let content: string;
  if (isHttpsSkillUrl(origin)) {
    const fetcher = options.fetcher ?? DEFAULT_FETCHER;
    const response = await fetcher(githubBlobToRaw(origin));
    if (!response.ok) {
      return {
        name: entry.name,
        module: entry.module,
        status: "skipped",
        path: entry.path,
        origin,
        reason: `failed to fetch origin: HTTP ${response.status}`,
      };
    }
    content = response.text;
  } else {
    const resolved = resolveOriginPath(origin, options.projectRoot);
    if (!(await pathExists(resolved))) {
      return {
        name: entry.name,
        module: entry.module,
        status: "skipped",
        path: entry.path,
        origin,
        reason: "origin file can no longer be read",
      };
    }
    content = await readFile(resolved, "utf8");
  }

  if (options.dryRun) {
    return {
      name: entry.name,
      module: entry.module,
      status: "would-overwrite",
      path: entry.path,
      origin,
      wired: wiringNote(entry.module),
    };
  }

  const created = await createProjectSkill(options.projectRoot, {
    target: entry.name,
    module: entry.module,
    name: entry.name,
    note: `Updated from origin ${origin}`,
    origin,
    originContent: content,
    format: "single",
  });
  await overwriteImportedSkill(options.projectRoot, created, content);
  return {
    name: entry.name,
    module: entry.module,
    status: "updated",
    path: created.skillPath,
    origin,
    wired: wiringNote(entry.module),
  };
}

async function overwriteImportedSkill(
  projectRoot: string,
  created: CreateProjectSkillResult,
  source: string,
): Promise<void> {
  const skillPath = path.join(projectRoot, created.skillPath, "SKILL.md");
  const scaffold = await readFile(skillPath, "utf8");
  const originLines = extractOriginBlock(scaffold);
  const stamped = stampOrigin(source, originLines);
  const relative = toPosix(path.join(created.skillPath, "SKILL.md"));
  const guard = await guardOutput({
    cwd: projectRoot,
    content: stamped,
    target: "skill",
    source: "untrusted-external",
    path: relative,
  });
  const output = prepareOutputForPersistence(guard, stamped);
  if (!output.allowed) {
    throw new Error(`Project skill blocked by the security gate: ${output.reason}`);
  }
  await writeFileAtomic(skillPath, output.content);
}

function extractOriginBlock(scaffold: string): string {
  const lines = scaffold.split("\n").filter((line) => /^(Origin:|Origin Hash:|Imported At:)\s/.test(line));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function stampOrigin(source: string, originBlock: string): string {
  if (!originBlock) return source;
  const stripped = source
    .replace(/^Origin Hash:.*\n/gm, "")
    .replace(/^Origin:.*\n/gm, "")
    .replace(/^Imported At:.*\n/gm, "");
  if (stripped.startsWith("---")) {
    const end = stripped.indexOf("\n---", 3);
    if (end !== -1) {
      const afterFence = end + "\n---".length;
      const insertAt = stripped[afterFence] === "\n" ? afterFence + 1 : afterFence;
      return `${stripped.slice(0, insertAt)}${originBlock}${stripped.slice(insertAt)}`;
    }
  }
  return `${originBlock}${stripped}`;
}

function inferNameFromPath(filePath: string, content: string): string {
  const fromFrontmatter = frontmatterName(content);
  if (fromFrontmatter) return fromFrontmatter;
  const parent = path.basename(path.dirname(filePath));
  if (parent && parent !== "skills" && parent !== ".") return parent;
  return path.basename(filePath, path.extname(filePath));
}

function inferNameFromUrl(url: string): string {
  const cleaned = url.replace(/\/SKILL\.md$/i, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "imported-skill";
}

function inferModule(name: string, content: string): string {
  const category = frontmatterCategory(content);
  if (category) return category;
  if (name.startsWith("review-") || name.startsWith("code-")) return "review";
  throw new Error(
    `keryx skills import: cannot infer module for ${name}. Pass --module review|quality|orchestration|…`,
  );
}

function frontmatterName(content: string): string | undefined {
  const match = content.match(/^name:\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function frontmatterCategory(content: string): string | undefined {
  const match = content.match(/^\s+category:\s*(.+)$/m) ?? content.match(/^category:\s*(.+)$/m);
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!value) return undefined;
  const known = new Set(["review", "quality", "orchestration", "planning", "platform", "core"]);
  return known.has(value) ? value : undefined;
}

function wiringNote(moduleName: string): string {
  if (moduleName === "review") {
    return "review-orchestrator will dispatch this after `keryx review reviewers` lists it";
  }
  return "registered for `keryx skills route`; not auto-injected into flow-orchestrator";
}

function metadataLine(content: string, label: string): string | undefined {
  const match = content.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

async function readRegistry(projectRoot: string): Promise<RegistryEntry[]> {
  const { readJsonFileOr } = await import("../lib/json");
  const manifestPath = path.join(projectRoot, ".metaproject", "metaproject.json");
  const manifest = await readJsonFileOr<{
    modules?: { gdskills?: { projectSkillRegistry?: RegistryEntry[] } };
  }>(manifestPath, {});
  return manifest.modules?.gdskills?.projectSkillRegistry ?? [];
}

function selectForUpdate(registry: RegistryEntry[], options: UpdateProjectSkillsOptions): RegistryEntry[] {
  if (options.skill) {
    const normalized = options.skill.replace(/\/SKILL\.md$/i, "");
    const hit = registry.find(
      (entry) => `${entry.module}/${entry.name}` === normalized || entry.name === normalized,
    );
    return hit ? [hit] : [];
  }
  if (options.all) return registry;
  return [];
}

function countByStatus(rows: ImportedProjectSkill[]): Record<ImportedProjectSkill["status"], number> {
  const counts: Record<ImportedProjectSkill["status"], number> = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    "would-import": 0,
    "would-overwrite": 0,
    updated: 0,
  };
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return counts;
}

export async function runSkillsImportCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSkillsImportHelp();
    return;
  }
  const from = optionValue(args, "--from");
  if (!from) {
    printSkillsImportHelp();
    throw new Error("Usage: keryx skills import --from <dir|SKILL.md|https://github.com/.../SKILL.md>");
  }
  const result = await importProjectSkills({
    projectRoot: process.cwd(),
    from,
    module: optionValue(args, "--module"),
    name: optionValue(args, "--name"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderImportProjectSkillsMarkdown(result));
}

export async function runSkillsUpdateCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSkillsUpdateHelp();
    return;
  }
  const positional = args.slice(1).filter((arg) => !arg.startsWith("--"));
  const result = await updateProjectSkills({
    projectRoot: process.cwd(),
    skill: positional[0],
    all: args.includes("--all"),
    from: optionValue(args, "--from"),
    dryRun: args.includes("--dry-run"),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderImportProjectSkillsMarkdown(result));
}

export function printSkillsImportHelp(): void {
  console.log(`keryx skills import

Copy a SKILL.md (or a directory of them) into this project's
.metaproject/project-skills/<module>/<name>/, recording Origin so drift is
detectable.

Usage:
  keryx skills import --from <dir|SKILL.md|https-url> [--module <module>] [--name <name>]
                      [--dry-run] [--force] [--json]

--from:
  a skill package directory, a SKILL.md file, a parent tree that contains
  skills/, or an https GitHub blob/raw URL to a SKILL.md.

--module:
  destination module. \`review\` is the only module review-orchestrator
  auto-dispatches. Other modules register for \`keryx skills route\` and are
  NOT injected into flow-orchestrator.

A name that collides with a bundled keryx skill is skipped unless --force.

Examples:
  keryx skills import --from ./overlays --module review
  keryx skills import --from ./skill-supper.md --module quality --name verifier
  keryx skills import --from https://github.com/org/repo/blob/main/skills/verifier/SKILL.md --module quality
`);
}

export function printSkillsUpdateHelp(): void {
  console.log(`keryx skills update

Re-read a project-skill's Origin and overwrite SKILL.md when the source moved on.

Usage:
  keryx skills update <module>/<name> [--from <new-origin>] [--dry-run] [--json]
  keryx skills update --all [--dry-run] [--json]

Examples:
  keryx skills update review/local-review-skill --from ./skill-supper.md
  keryx skills update --all
`);
}
