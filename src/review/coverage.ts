import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractStackRequiresField, parseStackRequires, scopeReviewerByStack, detectProjectStack } from "./stack";
import { collectReviewers } from "./reviewers";
import { ENV_AUTONOMOUS_ANSWERS_FILE } from "./autonomous-answers";

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
  "review-pr-contract",
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
export const BUNDLED_PATH_GATES: Record<string, (file: string) => boolean> = {
  "review-core-boundaries": (f) => /(^|\/)(src\/)?(core|shared|foundation)\//.test(f),
  "review-flow-graph": (f) => /(^|\/)(src\/core\/flow|src\/graph|src\/shared\/flow)\//.test(f),
  "review-testing-practices": (f) => TEST_FILE.test(f) || /\.msw\.ts$/.test(f),
  "review-frontend-conventions": (f) => FRONTEND_EXT.test(f) || /\.stories\.tsx$/.test(f) || CODE_FILE.test(f),
  "review-layout": (f) => /\.(tsx|jsx|css|scss)$/.test(f),
};

export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, (match, offset: number, whole: string) => (offset + match.length === whole.length ? "\uE001" : "\uE000"))
    .replace(/\*/g, "[^/]*")
    .replace(/\uE001/g, ".*")
    .replace(/\uE000/g, "(?:.*/)?");
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

export type RequiredOptions = {
  /** Whether a blast-radius record exists for the package: scope B exists, so the regression reviewer has a set to review. */
  blastRadius?: boolean | undefined;
  /** Whether the package holds `pr-context.md`: there is a PR body checklist for `review-pr-contract` to compare with the diff. */
  prContext?: boolean | undefined;
};

const REGRESSION = "review-regression";
const PR_CONTRACT = "review-pr-contract";

/**
 * Written to `dispatch.roles` by `ledger build` only when the package shows the role was dispatched (a driver for it) or
 * already carries the stamp: the roles added after the original roster that the dispatch knew about. A dispatch without
 * the mark was recorded before the role existed, so a package already in flight, rebuilt or not, is not newly refused for
 * a reviewer nobody could have dispatched.
 */
export const DISPATCH_KNOWN_ROLES: readonly string[] = [PR_CONTRACT];

function dispatchKnowsRole(dispatch: Record<string, unknown>, role: string): boolean {
  return Array.isArray(dispatch.roles) && dispatch.roles.includes(role);
}

/** Warnings the coverage gate does not refuse for: `review-pr-contract` not run on a package that predates the role. */
export function coverageWarnings(dispatch: unknown, options: Pick<CoverageOptions, "prContext">): string[] {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) return [];
  const record = dispatch as Record<string, unknown>;
  if (options.prContext !== true || dispatchKnowsRole(record, PR_CONTRACT)) return [];
  const selected = Array.isArray(record.selected) ? record.selected : [];
  return selected.includes(PR_CONTRACT) ? [] : [`${PR_CONTRACT} not run (package predates the role)`];
}

/** The same warnings, read from a package directory's `research.json`. */
export async function packageCoverageWarnings(packageDir: string): Promise<string[]> {
  try {
    const ledger = JSON.parse(await readFile(path.join(packageDir, "research.json"), "utf8"));
    return coverageWarnings(ledger?.dispatch, { prContext: packageHasPrContext(packageDir) });
  } catch {
    return [];
  }
}

export async function requiredReviewers(root: string, mode: ReviewMode, files: readonly string[] | undefined, options: RequiredOptions = {}): Promise<RequiredSet> {
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
  if (inventory.bundled.some((r) => r.name === REGRESSION)) {
    if (options.blastRadius === true) required.push(REGRESSION);
    else excluded.push({ reviewer: REGRESSION, reason: "no blast radius computed for the package: there is no scope B to review" });
  }
  if (inventory.bundled.some((r) => r.name === PR_CONTRACT)) {
    if (options.prContext === true) required.push(PR_CONTRACT);
    else excluded.push({ reviewer: PR_CONTRACT, reason: "no pr-context.md in the package: there is no PR body checklist to compare with the diff" });
  }
  return { mode, required: required.sort(), excluded, filesKnown };
}

export type CoverageOptions = {
  root: string;
  /** Scope-A files recorded with the package, when there are any. */
  files?: readonly string[] | undefined;
  /** Whether the package holds a blast-radius record. */
  blastRadius?: boolean | undefined;
  /** Whether the package holds `pr-context.md`. */
  prContext?: boolean | undefined;
  /** Proposed mutants no recorded mutation pass has run (`pendingMutants`). */
  pendingMutants?: number | undefined;
  /** False for `keryx review run --autonomous`; defaults to the environment the process runs in. */
  attended?: boolean | undefined;
};

/** An attended run is every run except the autonomous runner's child shell. */
export function isAttendedRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_AUTONOMOUS_ANSWERS_FILE] === undefined;
}

function mutationErrors(record: Record<string, unknown>, options: CoverageOptions): string[] {
  const pending = options.pendingMutants ?? 0;
  if (pending === 0 || (options.attended ?? isAttendedRun()) === false) return [];
  const w = record.mutationWaiver;
  const waiver = w && typeof w === "object" && !Array.isArray(w) ? (w as Record<string, unknown>) : {};
  const text = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  if (text(waiver.operatorQuote) && text(waiver.reason)) return [];
  return [
    `${pending} proposed mutant(s) in research-evidence/mutants.json were never run, so \`Not run: mutation pass\` is not allowed on an attended review. ` +
      "Run `keryx review mutate --test \"<command>\" --package <review-dir>`, or record dispatch.mutationWaiver {operatorQuote, reason} with the operator's own words",
  ];
}

/** Whether `keryx review start|ingest` stored a blast-radius record in the package. */
export async function packageHasBlastRadius(packageDir: string, name = "blast-radius.json"): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path.join(packageDir, name), "utf8"));
    return Array.isArray(parsed?.files) && Array.isArray(parsed?.changedFiles);
  } catch {
    return false;
  }
}

/** Whether `keryx review context-collect` wrote `pr-context.md` into the package. */
export function packageHasPrContext(packageDir: string, name = "pr-context.md"): boolean {
  return existsSync(path.join(packageDir, name));
}

export async function coverageErrors(dispatch: unknown, options: CoverageOptions): Promise<string[]> {
  const record = dispatch && typeof dispatch === "object" && !Array.isArray(dispatch) ? (dispatch as Record<string, unknown>) : undefined;
  return [...(await reviewerSetErrors(dispatch, options)), ...(record === undefined ? [] : mutationErrors(record, options))];
}

async function reviewerSetErrors(dispatch: unknown, options: CoverageOptions): Promise<string[]> {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) return [];
  const record = dispatch as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (record.mode !== "all" && record.mode !== "diff")
    return ['dispatch must declare mode "all" (every available reviewer) or "diff" (the set derived from the diff); run `keryx review required --mode all|diff`'];
  if (record.mode === "diff" && !text(record.operatorQuote))
    return ['dispatch mode "diff" narrows the reviewer set and needs operatorQuote (the operator\'s own words naming a narrower review); a pull request defaults to mode "all"'];
  const override = record.override;
  if (override !== undefined) {
    const o = override && typeof override === "object" && !Array.isArray(override) ? (override as Record<string, unknown>) : {};
    return text(o.operatorQuote) && text(o.reason)
      ? []
      : ["dispatch override needs operatorQuote (the operator's own words) and reason; without them a smaller reviewer set is not allowed"];
  }
  if (record.mode === "diff" && options.files === undefined)
    return ["diff mode needs the scope-A file list: pass `--scope <scope.json>` to `keryx review start|ingest`, or run mode all"];
  const need = await requiredReviewers(options.root, record.mode, options.files, {
    blastRadius: options.blastRadius,
    prContext: options.prContext === true && dispatchKnowsRole(record, PR_CONTRACT),
  });
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
