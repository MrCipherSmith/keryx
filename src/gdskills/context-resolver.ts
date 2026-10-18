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
import { resolveReferences } from "./reference-entries";
import { isDocumentCitation, loadReferences, normaliseCitedPath, REFERENCES_PATH, type ReferenceCondition, type ReferenceDeclaration } from "./references-config";
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
  /** Other project paths holding the same bytes (same sha256); citing any of them counts. */
  also_at?: string[];
  /** Declared references only: the section that matters, from `references.json`. */
  anchor?: string;
  /** Declared references with an anchor: UTF-8 size of the section, the bytes the obligation and the budget count. */
  section_bytes?: number;
  /** Declared references only: where the document applies, so an `on_demand` entry says why it was not required. */
  condition?: ReferenceCondition;
};

export type ContextBudget = { limitBytes: number; usedBytes: number; exceeded: boolean; limitSource: ProjectContextSource };

export type ProjectContextResolution = {
  schema: 1;
  for: ContextFor;
  files: string[];
  entries: ContextEntry[];
  budget: ContextBudget;
  warnings: string[];
  /** Present only when the project has a references file: cited documents it does not declare. */
  undeclared?: string[];
};

export type ResolveContextInput = {
  projectRoot: string;
  files: readonly string[];
  taskType?: string;
  for: ContextFor;
  /** The `--max-bytes` flag. */
  maxBytes?: number;
  /** What the task is about; matched against the keywords of declared references. Cut to {@link TASK_TEXT_MAX_CHARS}. */
  taskText?: string;
};

/** The task text kept for matching and for the last-resolve record, in characters. */
export const TASK_TEXT_MAX_CHARS = 4000;

/** The text cut to {@link TASK_TEXT_MAX_CHARS} characters (code points, never half a pair), and whether it was cut. */
export function truncateTaskText(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  return chars.length > TASK_TEXT_MAX_CHARS ? { text: chars.slice(0, TASK_TEXT_MAX_CHARS).join(""), truncated: true } : { text, truncated: false };
}

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
  /** Every ref this content is reachable under; more than one after a same-sha256 merge. */
  refs: string[];
  alsoAt: string[];
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

/** Refs of the rule files copied under `.metaproject/rules/project/`. */
export async function listRuleRefs(projectRoot: string): Promise<string[]> {
  return listRuleFiles(projectRoot);
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
  return { ref, path: pathValue, text, sha256: sha256Hex(text), bytes: Buffer.byteLength(text), front: { ...front, globs: mergeBraceFragments(front.globs) }, linked, refs: [ref], alsoAt: [] };
}

const segments = (value: string): number => value.split("/").length;
const withoutCorePrefix = (ref: string): string => (ref.startsWith("core/") ? ref.slice("core/".length) : ref);

/** Two paths with one sha256 are one rule: the shallower path leads, the rest go to `alsoAt`. */
function mergeSameContent(candidates: readonly RuleCandidate[]): RuleCandidate[] {
  const bySha = new Map<string, RuleCandidate[]>();
  for (const candidate of candidates) bySha.set(candidate.sha256, [...(bySha.get(candidate.sha256) ?? []), candidate]);
  const merged: RuleCandidate[] = [];
  for (const group of bySha.values()) {
    const [primary, ...rest] = [...group].sort((a, b) => segments(a.path) - segments(b.path) || compare(a.path, b.path));
    merged.push({ ...primary!, refs: group.map((member) => member.ref), alsoAt: rest.map((member) => member.path) });
  }
  return merged.sort((a, b) => compare(a.ref, b.ref));
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
  return mergeSameContent(candidates);
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
    const shadowsPath = candidate.refs.map((ref) => bundled.get(ref)).find((found) => found !== undefined);
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

/** One file name under two project paths with different content is a real conflict; both stay listed. */
function conflictWarnings(selected: readonly RuleCandidate[]): string[] {
  const byName = new Map<string, string[]>();
  for (const candidate of selected) {
    const name = withoutCorePrefix(candidate.ref);
    byName.set(name, [...(byName.get(name) ?? []), candidate.path]);
  }
  return [...byName]
    .filter(([, found]) => found.length > 1)
    .sort((a, b) => compare(a[0], b[0]))
    .map(([name, found]) => `${name}: found at ${found.join(" and ")} with different content; both are listed. Keep one copy or reconcile them.`);
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

/** A rule cites `core/X.mdc` or `X.mdc` whichever way the project laid its rules out: the project rules folder as written, then with the `core/` prefix flipped, then the repo path as written. */
function citationOptions(cite: string): string[] {
  const flipped = cite.startsWith("core/") ? cite.slice("core/".length) : `core/${cite}`;
  return [`${PROJECT_RULES_DIR}/${cite}`, `${PROJECT_RULES_DIR}/${flipped}`, cite];
}

async function collectContracts(
  projectRoot: string,
  cited: ReadonlyMap<string, string>,
  taken: ReadonlySet<string>,
  declared: ReadonlySet<string>,
  warnings: string[],
): Promise<ContextEntry[]> {
  const rootReal = await realpath(projectRoot).catch(() => projectRoot);
  const entries: ContextEntry[] = [];
  const listed = new Set(taken);
  for (const [cite, by] of [...cited].sort((a, b) => compare(a[0], b[0]))) {
    if (declared.has(cite)) continue;
    const reject = (why: string): void => void warnings.push(`${cite}: cited by ${by} but ${why}; not listed.`);
    if (path.isAbsolute(cite) || cite.split("/").includes("..")) {
      reject("is not a repo-relative path");
      continue;
    }
    let rel: string | undefined;
    let real = "";
    for (const option of citationOptions(cite)) {
      try {
        await lstat(path.join(projectRoot, option));
        real = await realpath(path.join(projectRoot, option));
        rel = option;
        break;
      } catch {
        // try the next spelling
      }
    }
    if (rel === undefined) {
      reject("does not exist");
      continue;
    }
    if (listed.has(rel)) continue;
    listed.add(rel);
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
  return entries.sort((a, b) => compare(a.path, b.path));
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
  const declarations = await loadDeclarations(projectRoot, warnings);

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
      ...(candidate.alsoAt.length > 0 ? { also_at: candidate.alsoAt } : {}),
    });
  }
  warnings.push(...conflictWarnings(rules.map((rule) => rule.candidate)));
  for (const skill of skills) projectEntries.push({ ...skill, tier: fit(skill.bytes) ? "must_read" : "on_demand" });

  const shadowed = new Set(rules.flatMap((rule) => (rule.shadows !== undefined ? [rule.shadows] : [])));
  const bundled = (await collectBundled(projectRoot, bundledNames)).filter((entry) => !shadowed.has(entry.path));

  const cited = new Map<string, string>();
  for (const { candidate } of rules) {
    for (const match of candidate.text.matchAll(CITATION)) {
      // A spelling that cannot be normalised (absolute, climbing out) stays raw so the contract pass can refuse it by name.
      const rel = normaliseCitedPath(match[1]!) ?? match[1]!;
      if (!cited.has(rel)) cited.set(rel, candidate.path);
    }
  }
  const taken = new Set([...projectEntries, ...bundled].flatMap((entry) => [entry.path, ...(entry.also_at ?? [])]));
  const task = truncateTaskText(input.taskText ?? "");
  if (task.truncated && (declarations ?? []).some((declaration) => declaration.when.keywords.length > 0)) {
    warnings.push(
      `the task text is longer than ${TASK_TEXT_MAX_CHARS} characters; only the first ${TASK_TEXT_MAX_CHARS} were matched against the keywords of declared references, so a keyword after the cut cannot promote a reference. Put what the task is about first, or match by files.`,
    );
  }
  const references = await resolveReferences({
    projectRoot,
    declarations: declarations ?? [],
    files,
    taskText: task.text,
    taken,
    maxFileBytes: CONTRACT_MAX_BYTES,
  });
  warnings.push(...references.warnings);
  const declaredPaths = new Set(references.entries.map((entry) => entry.path));
  const contracts = await collectContracts(projectRoot, cited, new Set([...taken, ...declaredPaths]), new Set((declarations ?? []).map((declaration) => declaration.path)), warnings);

  if (exceeded) {
    warnings.push(
      `project context is over the ${cap.limitBytes}-byte cap (${cap.limitSource}); some entries are on_demand. Raise gdskills.projectContext.maxBytes in .metaproject/tasks.config.json (or pass --max-bytes) instead of cutting rules.`,
    );
  }

  // A promoted reference is an obligation: the cap never demotes it, it only says so.
  const total = used + references.promotedBytes;
  const overCap = total > cap.limitBytes;
  if (references.promotedBytes > 0 && overCap) {
    const promoted = references.entries.filter((entry) => entry.tier === "must_read").map((entry) => `${entry.path} (${entry.section_bytes ?? entry.bytes} bytes)`);
    warnings.push(
      `promoted references ${promoted.join(", ")} bring the must_read total to ${total} bytes, over the ${cap.limitBytes}-byte cap (${cap.limitSource}); they stay must_read because a matched reference is an obligation. Raise gdskills.projectContext.maxBytes in .metaproject/tasks.config.json (or pass --max-bytes) or narrow the declared anchors.`,
    );
  }

  return {
    schema: 1,
    for: input.for,
    files,
    entries: [...projectEntries, ...references.entries, ...contracts, ...bundled],
    budget: { limitBytes: cap.limitBytes, usedBytes: total, exceeded: exceeded || overCap, limitSource: cap.limitSource },
    warnings,
    ...(declarations !== undefined ? { undeclared: contracts.map((contract) => contract.path).filter(isDocumentCitation) } : {}),
  };
}

/** The project's declarations, or undefined when there is no usable references file (a bad one warns and reads as absent). */
async function loadDeclarations(projectRoot: string, warnings: string[]): Promise<ReferenceDeclaration[] | undefined> {
  const loaded = await loadReferences(projectRoot);
  if (!loaded.ok) {
    for (const message of loaded.errors) warnings.push(`${message}; conditional references are ignored. Fix ${REFERENCES_PATH} (\`keryx skills references check\` lists every problem).`);
    return undefined;
  }
  return loaded.present ? loaded.references : undefined;
}

export type RecordedResolve = {
  recordedAt: string;
  result: ProjectContextResolution;
  /** The task text the resolve was given, cut to {@link TASK_TEXT_MAX_CHARS}; absent when none was given. */
  taskText?: string;
  /** True when {@link taskText} is a cut of a longer text. */
  taskTextTruncated?: true;
};

/** Best effort: the TUI reads this, so a failed write must not fail a resolve. */
export async function recordLastResolve(projectRoot: string, result: ProjectContextResolution, options: { taskText?: string } = {}): Promise<void> {
  try {
    const task = options.taskText !== undefined && options.taskText.trim() !== "" ? truncateTaskText(options.taskText) : undefined;
    const record: RecordedResolve = {
      recordedAt: new Date().toISOString(),
      result,
      ...(task !== undefined ? { taskText: task.text, ...(task.truncated ? { taskTextTruncated: true as const } : {}) } : {}),
    };
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
