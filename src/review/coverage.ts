import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractStackRequiresField, parseStackRequires, scopeReviewerByStack, detectProjectStack } from "./stack";
import { collectReviewers } from "./reviewers";

export type ReviewMode = "all" | "diff";

export type RequiredSet = {
  mode: ReviewMode;
  required: string[];
  excluded: { reviewer: string; reason: string }[];
  /** False when no scope-A file list was recorded, so path-gated reviewers could not be ruled out. */
  filesKnown: boolean;
};

/** Reviewers that are not part of a round's fan-out: they route, verify, or are opt-in. */
const NOT_ROSTER = new Set([
  "review-orchestrator",
  "review-verifier",
  "review-regression",
  "review-pr-feedback",
  "review-greptile",
  "review-strict",
]);

const FRONTEND_EXT = /\.(tsx|jsx|css|scss|html)$/;
const TEST_FILE = /(\.test\.|\.spec\.)|(^|\/)(src\/test|test|e2e)\//;
const BACKEND_DIR = /(^|\/)src\/(api|services|controllers|modules)\//;
const DATA_FILE = /(\.sql$|(^|\/)prisma\/schema\.prisma$|(^|\/)migrations?\/)/;
const CODE_FILE = /\.(ts|js|tsx|jsx)$/;

/** Path gates the orchestrator names for the generic convention reviewers. Anything not listed here is not path-gated. */
const BUNDLED_PATH_GATES: Record<string, (file: string) => boolean> = {
  "review-core-boundaries": (f) => /(^|\/)(src\/)?(core|shared|foundation)\//.test(f),
  "review-flow-graph": (f) => /(^|\/)(src\/core\/flow|src\/graph|src\/shared\/flow)\//.test(f),
  "review-testing-practices": (f) => TEST_FILE.test(f) || /\.msw\.ts$/.test(f),
  "review-frontend-conventions": (f) => FRONTEND_EXT.test(f) || /\.stories\.tsx$/.test(f) || CODE_FILE.test(f),
  "review-layout": (f) => /\.(tsx|jsx|css|scss)$/.test(f),
};

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${body}$`);
}

/** What `--frontend`/`--backend`/auto-detection select from the file list alone, before roster and stack filtering. */
export function derivedFromFiles(files: readonly string[]): Set<string> {
  const picked = new Set<string>();
  const add = (...names: string[]) => names.forEach((name) => picked.add(name));
  let frontend = false;
  let backend = false;
  for (const file of files) {
    if (FRONTEND_EXT.test(file) || /\.store\.ts$/.test(file)) frontend = true;
    if (BACKEND_DIR.test(file) && /\.(ts|js)$/.test(file)) backend = true;
    if (DATA_FILE.test(file)) add("review-backend", "review-architecture");
    if (TEST_FILE.test(file)) add("review-logic");
  }
  if (frontend) add("review-logic", "review-frontend", "review-style");
  if (backend) add("review-logic", "review-backend", "review-architecture");
  if (picked.size === 0) add("review-logic", "review-architecture");
  for (const [name, gate] of Object.entries(BUNDLED_PATH_GATES)) if (files.some(gate)) add(name);
  return picked;
}

async function readSkill(root: string, relativePath: string): Promise<string | undefined> {
  const file = path.join(root, relativePath, "SKILL.md");
  return existsSync(file) ? readFile(file, "utf8").catch(() => undefined) : undefined;
}

export async function requiredReviewers(root: string, mode: ReviewMode, files: readonly string[] | undefined): Promise<RequiredSet> {
  const inventory = await collectReviewers(root);
  const stack = await detectProjectStack(root);
  const excluded: RequiredSet["excluded"] = [];
  const roster: string[] = [];
  for (const reviewer of inventory.bundled) {
    if (!reviewer.name.startsWith("review-") || NOT_ROSTER.has(reviewer.name) || reviewer.engine !== undefined) continue;
    const content = await readSkill(root, reviewer.path);
    const decision = scopeReviewerByStack(reviewer.name, parseStackRequires(content ? extractStackRequiresField(content) : undefined), stack);
    if (!decision.include) { excluded.push({ reviewer: reviewer.name, reason: `stack: ${decision.reason}` }); continue; }
    roster.push(reviewer.name);
  }
  const projectGates = new Map<string, RegExp[]>();
  for (const reviewer of inventory.project) {
    roster.push(reviewer.name);
    if (reviewer.pathsSource !== "none" && reviewer.paths.length) projectGates.set(reviewer.name, reviewer.paths.map(globToRegExp));
  }
  const filesKnown = files !== undefined;
  const gated = (name: string): boolean | undefined => {
    if (!filesKnown) return undefined;
    const bundled = BUNDLED_PATH_GATES[name];
    if (bundled) return files.some(bundled);
    const patterns = projectGates.get(name);
    return patterns ? files.some((file) => patterns.some((p) => p.test(file))) : undefined;
  };
  let required = roster.filter((name) => {
    if (gated(name) === false) { excluded.push({ reviewer: name, reason: "no-matching-paths: no scope-A file matches its path triggers" }); return false; }
    return true;
  });
  if (mode === "diff") {
    const derived = derivedFromFiles(files ?? []);
    const project = new Set(inventory.project.map((p) => p.name));
    required = required.filter((name) => {
      if (derived.has(name) || project.has(name)) return true;
      excluded.push({ reviewer: name, reason: "diff mode: not derived from the changed files" });
      return false;
    });
  }
  return { mode, required: required.sort(), excluded, filesKnown };
}

export type CoverageOptions = {
  root: string;
  /** Scope-A files recorded with the package, when there are any. */
  files?: readonly string[] | undefined;
};

export async function coverageErrors(dispatch: unknown, options: CoverageOptions): Promise<string[]> {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) return [];
  const record = dispatch as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (record.mode !== "all" && record.mode !== "diff")
    return ['dispatch must declare mode "all" (every available reviewer) or "diff" (the set derived from the diff); run `keryx review required --mode all|diff`'];
  const override = record.override;
  if (override !== undefined) {
    const o = override && typeof override === "object" && !Array.isArray(override) ? (override as Record<string, unknown>) : {};
    return text(o.operatorQuote) && text(o.reason)
      ? []
      : ["dispatch override needs operatorQuote (the operator's own words) and reason; without them a smaller reviewer set is not allowed"];
  }
  if (record.mode === "diff" && options.files === undefined)
    return ["diff mode needs the scope-A file list: pass `--scope <scope.json>` to `keryx review start|ingest`, or run mode all"];
  const need = await requiredReviewers(options.root, record.mode, options.files);
  const selected = new Set(Array.isArray(record.selected) ? record.selected.filter(text) : []);
  const missing = need.required.filter((name) => !selected.has(name));
  if (!missing.length) return [];
  return [
    `dispatch covers ${need.required.length - missing.length} of ${need.required.length} reviewers that mode ${record.mode} requires; missing: ${missing.join(", ")}. ` +
      "Dispatch them, or record an operator override {operatorQuote, reason}; `keryx review required` prints the set",
  ];
}

export async function packageScopeFiles(packageDir: string): Promise<string[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(packageDir, "scope-files.json"), "utf8"));
    return Array.isArray(parsed?.files) && parsed.files.every((f: unknown) => typeof f === "string") ? parsed.files : undefined;
  } catch {
    return undefined;
  }
}

/** `<root>/.metaproject/reviews/<id>` → `<root>`. */
export function projectRootOfPackage(packageDir: string): string {
  return path.resolve(packageDir, "..", "..", "..");
}
