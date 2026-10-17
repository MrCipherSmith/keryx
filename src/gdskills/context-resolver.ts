// Decides, from the files on disk and the arguments alone, which project rules and
// project skills a code-writing or test-writing worker must read, and which are
// only listed. The result is the record the worker's `project_context_applied` is
// checked against. Nothing here asks a model anything.

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside, pathExists } from "../lib/fs";
import { writeContained } from "../lib/contained-write";
import { matchesAnyGlobWithBraces } from "../lib/glob";
import { resolveMaxBytes, type ProjectContextSource } from "./project-context-config";
import { PROJECT_RULES_DIR, projectRulePathFor, readProjectRuleRegistry, sha256Hex, type ProjectRuleRegistryEntry } from "./project-rules";
import { PROJECT_SKILLS_MANIFEST_PATH, resolveOriginPath, type ProjectSkillRegistryEntry } from "./project-skills";
import { parseRuleFrontmatter, type RuleFrontmatter } from "./rule-frontmatter";
import { frontmatterScalar } from "./skill-frontmatter";
import { readJsonFileOr } from "../lib/json";

export type ContextFor = "implement" | "test" | "review";
export type ContextKind = "rule" | "skill" | "contract";

export type ContextEntry = {
  kind: ContextKind;
  source: "project" | "bundled";
  /** Project-relative, posix; an absolute path for a linked rule whose origin is outside the project. */
  path: string;
  sha256: string;
  bytes: number;
  reason: string;
  tier: "must_read" | "on_demand";
  description?: string;
  index?: true;
  linked?: true;
  shadows?: string;
};

export type ContextBudget = { limitBytes: number; usedBytes: number; exceeded: boolean; limitSource: ProjectContextSource };

export type ProjectContextResolution = {
  schema: 1;
  for: ContextFor;
  files: string[];
  entries: ContextEntry[];
  budget: ContextBudget;
  warnings: string[];
};

export type ResolveContextInput = {
  projectRoot: string;
  files: readonly string[];
  taskType?: string;
  for: ContextFor;
  /** The `--max-bytes` flag. */
  maxBytes?: number;
};

/** An always-apply rule bigger than this is a routing index: listed, never read in full up front. */
export const INDEX_THRESHOLD_BYTES = 30720;
/** A cited contract file bigger than this is not listed. */
export const CONTRACT_MAX_BYTES = 262144;

export const LAST_RESOLVE_PATH = ".metaproject/data/skills/project-context/last.json";

const BUNDLED_RULES_DIR = ".metaproject/rules/core";

const ALWAYS_RULES = ["tdd-workflow", "error-handling", "solid-principles"];
const TYPE_RULES: Record<string, string[]> = {
  ui_component: ["code-style-patterns", "frontend-assistant", "storybook-guidelines"],
  store_logic: ["code-style-patterns", "mobx-store-template"],
  service_api: ["code-style-patterns", "nestjs-dto", "api-contracts"],
};
const TEST_RULES = ["tdd-workflow", "testing-conventions"];

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function bundledRuleNames(forWhat: ContextFor, taskType: string | undefined): string[] {
  if (forWhat === "review") return [];
  if (forWhat === "test") return TEST_RULES;
  const names = [...ALWAYS_RULES];
  const byType = taskType === "mixed" ? ["ui_component", "store_logic", "service_api"].flatMap((type) => TYPE_RULES[type] ?? []) : (TYPE_RULES[taskType ?? ""] ?? []);
  for (const name of byType) if (!names.includes(name)) names.push(name);
  return names;
}

/** Front-matter lists split on commas; a brace glob such as `*.{ts,tsx}` has to be put back together. */
function mergeBraceFragments(globs: readonly string[]): string[] {
  const merged: string[] = [];
  let pending: string | undefined;
  for (const piece of globs) {
    const text = pending === undefined ? piece : `${pending},${piece}`;
    const open = (text.match(/\{/g) ?? []).length;
    const close = (text.match(/\}/g) ?? []).length;
    if (open > close) pending = text;
    else {
      merged.push(text);
      pending = undefined;
    }
  }
  if (pending !== undefined) merged.push(pending);
  return merged;
}

const hasWildcard = (glob: string): boolean => /[*?{[]/.test(glob);

function normaliseFiles(projectRoot: string, files: readonly string[], warnings: string[]): string[] {
  const kept = new Set<string>();
  for (const raw of files) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const relative = path.isAbsolute(trimmed) ? path.relative(projectRoot, trimmed) : path.normalize(trimmed);
    const posix = relative.split(path.sep).join("/");
    if (posix === ".." || posix.startsWith("../") || path.isAbsolute(posix)) {
      warnings.push(`${raw}: outside the project root; ignored.`);
      continue;
    }
    kept.add(posix.replace(/^\.\//, ""));
  }
  return [...kept].sort(compare);
}

type RuleCandidate = {
  ref: string;
  path: string;
  text: string;
  sha256: string;
  bytes: number;
  front: RuleFrontmatter;
  linked: boolean;
};

async function listRuleFiles(projectRoot: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(projectRoot, PROJECT_RULES_DIR, relative), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const ref = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listRuleFiles(projectRoot, ref)));
    else if (entry.isFile() && /\.mdc?$/.test(entry.name)) found.push(ref);
  }
  return found;
}

async function readText(absolute: string): Promise<string | undefined> {
  try {
    return await readFile(absolute, "utf8");
  } catch {
    return undefined;
  }
}

function candidateOf(ref: string, pathValue: string, text: string, linked: boolean): RuleCandidate {
  const front = parseRuleFrontmatter(text);
  return { ref, path: pathValue, text, sha256: sha256Hex(text), bytes: Buffer.byteLength(text), front: { ...front, globs: mergeBraceFragments(front.globs) }, linked };
}

async function collectProjectRules(projectRoot: string, warnings: string[]): Promise<RuleCandidate[]> {
  const registry = new Map<string, ProjectRuleRegistryEntry>((await readProjectRuleRegistry(projectRoot)).map((entry) => [entry.ref, entry]));
  const refs = new Set<string>([...(await listRuleFiles(projectRoot)), ...registry.keys()]);
  const candidates: RuleCandidate[] = [];
  for (const ref of [...refs].sort(compare)) {
    const copy = await readText(path.join(projectRoot, projectRulePathFor(ref)));
    if (copy !== undefined) {
      candidates.push(candidateOf(ref, projectRulePathFor(ref), copy, false));
      continue;
    }
    const entry = registry.get(ref);
    if (entry === undefined || entry.mode !== "link") continue;
    const origin = resolveOriginPath(entry.origin, projectRoot);
    const text = await readText(origin);
    if (text === undefined) {
      warnings.push(`${ref}: the linked file ${origin} cannot be read; the rule is excluded. Fix the link or run \`keryx skills update --rules\`.`);
      continue;
    }
    if (sha256Hex(text) !== entry.sha256) {
      warnings.push(`${ref}: the linked file ${origin} changed since it was linked; the rule is excluded. Review it, then run \`keryx skills update --rules\`.`);
      continue;
    }
    candidates.push(candidateOf(ref, origin, text, true));
  }
  return candidates;
}

type Selected = { candidate: RuleCandidate; reason: string; sortKey: [number, number]; shadows?: string };

function selectRules(
  candidates: readonly RuleCandidate[],
  files: readonly string[],
  taskType: string | undefined,
  bundled: ReadonlyMap<string, string>,
): Selected[] {
  const selected: Selected[] = [];
  for (const candidate of candidates) {
    const shadowsPath = bundled.get(candidate.ref);
    const matching = candidate.front.globs.filter((glob) => files.some((file) => matchesAnyGlobWithBraces(file, [glob])));
    const base = { candidate, ...(shadowsPath !== undefined ? { shadows: shadowsPath } : {}) };
    if (matching.length > 0) {
      const ranked = matching
        .map((glob) => ({ glob, count: files.filter((file) => matchesAnyGlobWithBraces(file, [glob])).length }))
        .sort((a, b) => Number(hasWildcard(a.glob)) - Number(hasWildcard(b.glob)) || a.count - b.count || compare(a.glob, b.glob));
      const best = ranked[0]!;
      selected.push({ ...base, reason: `glob:${best.glob}`, sortKey: [hasWildcard(best.glob) ? 1 : 0, best.count] });
    } else if (candidate.front.alwaysApply) {
      selected.push({ ...base, reason: "always", sortKey: [2, 0] });
    } else if (taskType !== undefined && candidate.front.taskTypes.includes(taskType)) {
      selected.push({ ...base, reason: `task-type:${taskType}`, sortKey: [2, 0] });
    } else if (shadowsPath !== undefined) {
      selected.push({ ...base, reason: "replaces-bundled", sortKey: [3, 0] });
    }
  }
  return selected.sort(
    (a, b) => a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1] || a.candidate.bytes - b.candidate.bytes || compare(a.candidate.path, b.candidate.path),
  );
}

function skillMatches(entry: ProjectSkillRegistryEntry, files: readonly string[], taskType: string | undefined): string | undefined {
  if (taskType !== undefined && entry.taskTypes?.includes(taskType)) return `task-type:${taskType}`;
  const target = entry.target.trim();
  if (target === "") return undefined;
  const prefix = target.replace(/\/+$/, "");
  const hit = files.some((file) => matchesAnyGlobWithBraces(file, [target]) || file === prefix || file.startsWith(`${prefix}/`));
  return hit ? "route" : undefined;
}

async function collectSkills(projectRoot: string, forWhat: ContextFor, files: readonly string[], taskType: string | undefined): Promise<ContextEntry[]> {
  if (forWhat === "review") return [];
  const manifest = await readJsonFileOr<{ modules?: { gdskills?: { projectSkillRegistry?: ProjectSkillRegistryEntry[] } } }>(
    path.join(projectRoot, PROJECT_SKILLS_MANIFEST_PATH),
    {},
  );
  const registry = manifest.modules?.gdskills?.projectSkillRegistry;
  if (!Array.isArray(registry)) return [];
  const module = forWhat === "test" ? "testing" : "implementation";
  const entries: ContextEntry[] = [];
  for (const skill of registry) {
    if (skill.module !== module || skill.status !== "active" || typeof skill.path !== "string" || typeof skill.target !== "string") continue;
    const reason = skillMatches(skill, files, taskType);
    if (reason === undefined) continue;
    const skillPath = `${skill.path.replace(/\/+$/, "")}/SKILL.md`;
    const text = await readText(path.join(projectRoot, skillPath));
    if (text === undefined) continue;
    const description = frontmatterScalar(text, "description") ?? "";
    entries.push({
      kind: "skill",
      source: "project",
      path: skillPath,
      sha256: sha256Hex(text),
      bytes: Buffer.byteLength(text),
      reason,
      tier: "must_read",
      ...(description !== "" ? { description } : {}),
    });
  }
  return entries.sort((a, b) => compare(a.path, b.path));
}

async function collectBundled(projectRoot: string, names: readonly string[]): Promise<ContextEntry[]> {
  const entries: ContextEntry[] = [];
  for (const name of names) {
    const rel = `${BUNDLED_RULES_DIR}/${name}.mdc`;
    const text = await readText(path.join(projectRoot, rel));
    if (text === undefined) continue;
    entries.push({ kind: "rule", source: "bundled", path: rel, sha256: sha256Hex(text), bytes: Buffer.byteLength(text), reason: "bundled-default", tier: "must_read" });
  }
  return entries;
}

async function bundledPaths(projectRoot: string, names: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of names) {
    const rel = `${BUNDLED_RULES_DIR}/${name}.mdc`;
    if (await pathExists(path.join(projectRoot, rel))) map.set(`${name}.mdc`, rel);
  }
  return map;
}

const CITATION = /`([^`\s]+\.mdc?)`/g;

async function collectContracts(projectRoot: string, cited: ReadonlyMap<string, string>, taken: ReadonlySet<string>, warnings: string[]): Promise<ContextEntry[]> {
  const rootReal = await realpath(projectRoot).catch(() => projectRoot);
  const entries: ContextEntry[] = [];
  for (const [rel, by] of [...cited].sort((a, b) => compare(a[0], b[0]))) {
    if (taken.has(rel)) continue;
    const reject = (why: string): void => void warnings.push(`${rel}: cited by ${by} but ${why}; not listed.`);
    if (path.isAbsolute(rel) || rel.split("/").includes("..")) {
      reject("is not a repo-relative path");
      continue;
    }
    const absolute = path.join(projectRoot, rel);
    let real: string;
    try {
      await lstat(absolute);
      real = await realpath(absolute);
    } catch {
      reject("does not exist");
      continue;
    }
    if (!isPathInside(rootReal, real)) {
      reject("resolves outside the project root");
      continue;
    }
    const info = await lstat(real);
    if (!info.isFile()) {
      reject("is not a regular file");
      continue;
    }
    if (info.size > CONTRACT_MAX_BYTES) {
      reject(`is larger than ${CONTRACT_MAX_BYTES} bytes`);
      continue;
    }
    const text = await readText(real);
    if (text === undefined) {
      reject("cannot be read");
      continue;
    }
    entries.push({ kind: "contract", source: "project", path: rel, sha256: sha256Hex(text), bytes: Buffer.byteLength(text), reason: `referenced-by:${by}`, tier: "on_demand" });
  }
  return entries;
}

export async function resolveProjectContext(input: ResolveContextInput): Promise<ProjectContextResolution> {
  const { projectRoot } = input;
  const warnings: string[] = [];
  const files = normaliseFiles(projectRoot, input.files, warnings);
  const cap = await resolveMaxBytes(projectRoot, input.maxBytes);
  warnings.push(...cap.warnings);

  const bundledNames = bundledRuleNames(input.for, input.taskType);
  const shadowable = await bundledPaths(projectRoot, bundledNames);
  const candidates = await collectProjectRules(projectRoot, warnings);
  const rules = selectRules(candidates, files, input.taskType, shadowable);
  const skills = await collectSkills(projectRoot, input.for, files, input.taskType);

  let used = 0;
  let exceeded = false;
  const projectEntries: ContextEntry[] = [];
  const fit = (bytes: number): boolean => {
    if (used + bytes > cap.limitBytes) {
      exceeded = true;
      return false;
    }
    used += bytes;
    return true;
  };
  const describe = (candidate: RuleCandidate): { description?: string } => (candidate.front.description !== "" ? { description: candidate.front.description } : {});

  for (const { candidate, reason, shadows } of rules) {
    const isIndex = candidate.front.alwaysApply && candidate.bytes > INDEX_THRESHOLD_BYTES;
    const tier = isIndex ? "on_demand" : fit(candidate.bytes) ? "must_read" : "on_demand";
    projectEntries.push({
      kind: "rule",
      source: "project",
      path: candidate.path,
      sha256: candidate.sha256,
      bytes: candidate.bytes,
      reason,
      tier,
      ...describe(candidate),
      ...(isIndex ? { index: true as const } : {}),
      ...(candidate.linked ? { linked: true as const } : {}),
      ...(shadows !== undefined ? { shadows } : {}),
    });
  }
  for (const skill of skills) projectEntries.push({ ...skill, tier: fit(skill.bytes) ? "must_read" : "on_demand" });

  const shadowed = new Set(rules.flatMap((rule) => (rule.shadows !== undefined ? [rule.shadows] : [])));
  const bundled = (await collectBundled(projectRoot, bundledNames)).filter((entry) => !shadowed.has(entry.path));

  const cited = new Map<string, string>();
  for (const { candidate } of rules) {
    for (const match of candidate.text.matchAll(CITATION)) {
      const rel = match[1]!;
      if (!cited.has(rel)) cited.set(rel, candidate.path);
    }
  }
  const taken = new Set([...projectEntries, ...bundled].map((entry) => entry.path));
  const contracts = await collectContracts(projectRoot, cited, taken, warnings);

  if (exceeded) {
    warnings.push(
      `project context is over the ${cap.limitBytes}-byte cap (${cap.limitSource}); some entries are on_demand. Raise gdskills.projectContext.maxBytes in .metaproject/tasks.config.json (or pass --max-bytes) instead of cutting rules.`,
    );
  }

  return {
    schema: 1,
    for: input.for,
    files,
    entries: [...projectEntries, ...contracts, ...bundled],
    budget: { limitBytes: cap.limitBytes, usedBytes: used, exceeded, limitSource: cap.limitSource },
    warnings,
  };
}

export type RecordedResolve = { recordedAt: string; result: ProjectContextResolution };

/** Best effort: the TUI reads this, so a failed write must not fail a resolve. */
export async function recordLastResolve(projectRoot: string, result: ProjectContextResolution): Promise<void> {
  try {
    const record: RecordedResolve = { recordedAt: new Date().toISOString(), result };
    await writeContained(projectRoot, LAST_RESOLVE_PATH, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // nothing to do: the record is a convenience
  }
}

export async function readLastResolve(projectRoot: string): Promise<RecordedResolve | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(projectRoot, LAST_RESOLVE_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Partial<RecordedResolve>;
    return typeof record.recordedAt === "string" && typeof record.result === "object" && record.result !== null ? (record as RecordedResolve) : undefined;
  } catch {
    return undefined;
  }
}
