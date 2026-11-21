import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type RebuildIndex = "memory" | "gdgraph" | "wiki";

export interface DependencyConfig {
  dir: string;
  lockfiles: string[];
  install?: string;
}

export interface PortConfig {
  env: string;
  range: [number, number];
}

/** Parsed and kept in stage 1; the baseline itself is a later stage. */
export interface BaselineConfig {
  enabled: boolean;
  timeoutSeconds: number;
  commands?: string[];
}

export interface WorktreeConfig {
  version: 1;
  envFiles: string[];
  dependencies: DependencyConfig[];
  ports: Record<string, PortConfig>;
  prepare: { rebuildIndexes: RebuildIndex[] };
  baseline: BaselineConfig;
}

export const WORKTREE_CONFIG_PATH = ".metaproject/worktree.config.json";

/** A configuration problem; `field` names the offending key (`dependencies[0].dir`). */
export class WorktreeConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${WORKTREE_CONFIG_PATH}: ${field}: ${message}`);
    this.name = "WorktreeConfigError";
    this.field = field;
  }
}

const DEFAULT_BASELINE: BaselineConfig = { enabled: true, timeoutSeconds: 900 };
const ENV_EXCLUDED_SUFFIXES = [".example", ".sample", ".template"];
const REBUILD_INDEXES: readonly string[] = ["memory", "gdgraph", "wiki"];

const LOCKFILE_INSTALLS: ReadonlyArray<{ lockfiles: string[]; install: string }> = [
  { lockfiles: ["bun.lock"], install: "bun install --frozen-lockfile" },
  { lockfiles: ["bun.lockb"], install: "bun install --frozen-lockfile" },
  { lockfiles: ["package-lock.json"], install: "npm ci" },
  { lockfiles: ["pnpm-lock.yaml"], install: "pnpm install --frozen-lockfile" },
  { lockfiles: ["yarn.lock"], install: "yarn install --frozen-lockfile" },
];

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** The configuration used when a project has no `.metaproject/worktree.config.json` (spec §4). */
export async function defaultWorktreeConfig(mainRoot: string): Promise<WorktreeConfig> {
  let names: string[];
  try {
    names = await readdir(mainRoot);
  } catch {
    names = [];
  }
  const envFiles = names
    .filter((name) => name.startsWith(".env") && !ENV_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .sort();

  const dependencies: DependencyConfig[] = [];
  if (await exists(path.join(mainRoot, "package.json"))) {
    let picked: { lockfiles: string[]; install: string } | undefined;
    for (const candidate of LOCKFILE_INSTALLS) {
      if (await exists(path.join(mainRoot, candidate.lockfiles[0] as string))) {
        picked = candidate;
        break;
      }
    }
    dependencies.push({
      dir: "node_modules",
      lockfiles: picked?.lockfiles ?? [],
      install: picked?.install ?? "npm install",
    });
  }

  return {
    version: 1,
    envFiles,
    dependencies,
    ports: {},
    prepare: { rebuildIndexes: ["memory"] },
    baseline: { ...DEFAULT_BASELINE },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new WorktreeConfigError(prefix === "" ? key : `${prefix}.${key}`, "unknown field");
    }
  }
}

/**
 * Why `value` cannot name a path inside a checkout, or `undefined` when it can: it must be
 * non-empty, relative, name something below the root (not `.`), never start in `.git`, and
 * hold no `..` segment (`a..b.env` is a fine file name).
 */
export function relativePathProblem(value: string): string | undefined {
  if (value.length === 0) return "must be a non-empty string";
  if (value.startsWith("/") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return "must be relative to the checkout root, not absolute";
  }
  const segments = value.split(/[\\/]/);
  if (segments.includes("..")) return 'must not contain a ".." segment';
  const meaningful = segments.filter((segment) => segment !== "" && segment !== ".");
  if (meaningful.length === 0) return "must name a path below the checkout root, not the root itself";
  if ((meaningful[0] as string).toLowerCase() === ".git") return "must not point into .git";
  return undefined;
}

function parseRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WorktreeConfigError(field, "must be a non-empty string");
  }
  const problem = relativePathProblem(value);
  if (problem !== undefined) {
    throw new WorktreeConfigError(field, problem);
  }
  return value;
}

function parsePathList(value: unknown, field: string, unique: boolean): string[] {
  if (!Array.isArray(value)) {
    throw new WorktreeConfigError(field, "must be an array of strings");
  }
  const out = value.map((item, index) => parseRelativePath(item, `${field}[${index}]`));
  if (unique && new Set(out).size !== out.length) {
    throw new WorktreeConfigError(field, "must not contain duplicates");
  }
  return out;
}

function parseDependencies(value: unknown): DependencyConfig[] {
  if (!Array.isArray(value)) {
    throw new WorktreeConfigError("dependencies", "must be an array");
  }
  return value.map((item, index): DependencyConfig => {
    const field = `dependencies[${index}]`;
    if (!isRecord(item)) {
      throw new WorktreeConfigError(field, "must be an object");
    }
    rejectUnknownKeys(item, ["dir", "lockfiles", "install"], field);
    const dir = parseRelativePath(item.dir, `${field}.dir`);
    const lockfiles = item.lockfiles === undefined ? [] : parsePathList(item.lockfiles, `${field}.lockfiles`, false);
    if (item.install !== undefined && (typeof item.install !== "string" || item.install.length === 0)) {
      throw new WorktreeConfigError(`${field}.install`, "must be a non-empty string");
    }
    return { dir, lockfiles, ...(typeof item.install === "string" && { install: item.install }) };
  });
}

function parsePorts(value: unknown): Record<string, PortConfig> {
  if (!isRecord(value)) {
    throw new WorktreeConfigError("ports", "must be an object");
  }
  const ports: Record<string, PortConfig> = {};
  const envNames = new Set<string>();
  for (const [name, entry] of Object.entries(value)) {
    const field = `ports.${name}`;
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      throw new WorktreeConfigError(field, "port name must match ^[a-z][a-z0-9_-]{0,31}$");
    }
    if (!isRecord(entry)) {
      throw new WorktreeConfigError(field, "must be an object");
    }
    rejectUnknownKeys(entry, ["env", "range"], field);
    if (typeof entry.env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(entry.env)) {
      throw new WorktreeConfigError(`${field}.env`, "must be an environment variable name like PORT");
    }
    if (envNames.has(entry.env)) {
      throw new WorktreeConfigError(`${field}.env`, `environment variable ${entry.env} is already used by another port`);
    }
    envNames.add(entry.env);
    const range = entry.range;
    if (!Array.isArray(range) || range.length !== 2) {
      throw new WorktreeConfigError(`${field}.range`, "must be [low, high]");
    }
    const [low, high] = range as unknown[];
    for (const bound of [low, high]) {
      if (!Number.isInteger(bound) || (bound as number) < 1024 || (bound as number) > 65535) {
        throw new WorktreeConfigError(`${field}.range`, "bounds must be integers within 1024..65535");
      }
    }
    if ((low as number) > (high as number)) {
      throw new WorktreeConfigError(`${field}.range`, "lower bound must not exceed the upper bound");
    }
    ports[name] = { env: entry.env, range: [low as number, high as number] };
  }
  return ports;
}

function parseBaseline(value: unknown): BaselineConfig {
  if (!isRecord(value)) {
    throw new WorktreeConfigError("baseline", "must be an object");
  }
  rejectUnknownKeys(value, ["enabled", "timeoutSeconds", "commands"], "baseline");
  const baseline: BaselineConfig = { ...DEFAULT_BASELINE };
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new WorktreeConfigError("baseline.enabled", "must be a boolean");
    }
    baseline.enabled = value.enabled;
  }
  if (value.timeoutSeconds !== undefined) {
    const seconds = value.timeoutSeconds;
    if (!Number.isInteger(seconds) || (seconds as number) < 10 || (seconds as number) > 7200) {
      throw new WorktreeConfigError("baseline.timeoutSeconds", "must be an integer within 10..7200");
    }
    baseline.timeoutSeconds = seconds as number;
  }
  if (value.commands !== undefined) {
    const commands = value.commands;
    if (!Array.isArray(commands) || commands.length === 0 || commands.some((c) => typeof c !== "string" || c.length === 0)) {
      throw new WorktreeConfigError("baseline.commands", "must be a non-empty array of non-empty strings");
    }
    baseline.commands = commands as string[];
  }
  return baseline;
}

function parsePrepare(value: unknown): { rebuildIndexes: RebuildIndex[] } {
  if (!isRecord(value)) {
    throw new WorktreeConfigError("prepare", "must be an object");
  }
  rejectUnknownKeys(value, ["rebuildIndexes"], "prepare");
  if (value.rebuildIndexes === undefined) {
    return { rebuildIndexes: ["memory"] };
  }
  const list = value.rebuildIndexes;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !REBUILD_INDEXES.includes(item))) {
    throw new WorktreeConfigError("prepare.rebuildIndexes", `entries must be one of ${REBUILD_INDEXES.join(", ")}`);
  }
  if (new Set(list).size !== list.length) {
    throw new WorktreeConfigError("prepare.rebuildIndexes", "must not contain duplicates");
  }
  return { rebuildIndexes: list as RebuildIndex[] };
}

/** Validate a parsed configuration document. Throws {@link WorktreeConfigError} naming the offending field. */
export function parseWorktreeConfig(raw: unknown): WorktreeConfig {
  if (!isRecord(raw)) {
    throw new WorktreeConfigError("(root)", "must be a JSON object");
  }
  rejectUnknownKeys(raw, ["version", "envFiles", "dependencies", "ports", "baseline", "prepare"], "");
  if (raw.version !== 1) {
    throw new WorktreeConfigError("version", "must be 1");
  }
  return {
    version: 1,
    envFiles: raw.envFiles === undefined ? [] : parsePathList(raw.envFiles, "envFiles", true),
    dependencies: raw.dependencies === undefined ? [] : parseDependencies(raw.dependencies),
    ports: raw.ports === undefined ? {} : parsePorts(raw.ports),
    prepare: raw.prepare === undefined ? { rebuildIndexes: ["memory"] } : parsePrepare(raw.prepare),
    baseline: raw.baseline === undefined ? { ...DEFAULT_BASELINE } : parseBaseline(raw.baseline),
  };
}

/** The project's configuration, or the defaults when the file is absent. Invalid files throw {@link WorktreeConfigError}. */
export async function loadWorktreeConfig(mainRoot: string): Promise<WorktreeConfig> {
  let text: string;
  try {
    text = await readFile(path.join(mainRoot, WORKTREE_CONFIG_PATH), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultWorktreeConfig(mainRoot);
    }
    throw cause;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WorktreeConfigError("(root)", "is not valid JSON");
  }
  return parseWorktreeConfig(raw);
}
