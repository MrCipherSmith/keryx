import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BASE_CANDIDATES, defaultGitRunner, emptyRangeWarning, resolveBase } from "./git-base";
import { notReviewPackagesAt } from "./round-record";
import { asRecord } from "./record";
import { extractStackRequiresField, parseStackRequires, scopeReviewerByStack, detectProjectStack } from "./stack";
import { collectReviewers, overlapGroupsOf, type ReviewerInventory } from "./reviewers";
import { CORE_MANDATORY_REVIEWER_IDS } from "./jev-select";
import { resolveProjectRoot } from "../lib/contained-path";
import { isAttendedRun, operatorGateApplies, runProfileRefusal } from "./run-profile";
import { confirmedDecision, decisionWriters, type OperatorDecisionKind, type OperatorDecisionSubject } from "./operator-decisions";
import { pendingMutants } from "./mutate";
import { buildReviewScope } from "./scope";
import { assertGitRevision } from "../lib/git-revision";

export type ReviewMode = "all" | "diff";
export type RoundDepth = "light" | "full";
export type DepthRequest = "auto" | "light" | "full";
export const DEPTH_REQUESTS: readonly DepthRequest[] = ["auto", "light", "full"];

/** A diff at or under both limits, outside the risk class, gets a light round under `--depth auto`. */
export const LIGHT_MAX_FILES = 5;
export const LIGHT_MAX_CHANGED_LINES = 300;
/** The light round's logic and testing reviewers; the conventions reviewer is picked from {@link LIGHT_CONVENTIONS_PREFERENCE}. */
export const LIGHT_FIXED_REVIEWERS: readonly string[] = ["review-logic", "review-testing-practices"];
/**
 * Stack-aware choice, first one the stack filter kept wins: React/MobX stacks keep frontend-conventions, a backend stack
 * keeps review-backend, anything else falls to clean-code. A pick that sits in an overlap group is raised to the group's
 * top member when the roster holds it (React/MobX: review-frontend, see `BUNDLED_OVERLAP_GROUPS`).
 */
export const LIGHT_CONVENTIONS_PREFERENCE: readonly string[] = ["review-frontend-conventions", "review-backend", "review-clean-code"];

export type RequiredSet = {
  mode: ReviewMode;
  /** The depth the set was computed for; `full` unless a light round was asked for. */
  depth: RoundDepth;
  required: string[];
  excluded: { reviewer: string; reason: string }[];
  /** False when no scope-A file list was recorded, so path-gated reviewers could not be ruled out. */
  filesKnown: boolean;
  /** Supersedes and overlap removals that were NOT applied, and why (M6). Absent when there is nothing to say. */
  notes?: string[] | undefined;
};

/**
 * Roles no `supersedes` or overlap group ever removes (M6): the core mandatory reviewers and the regression reviewer.
 * A reviewer — bundled or a project overlay — that claims to replace one of them is ignored for that claim.
 */
export const NEVER_SUPERSEDED: ReadonlySet<string> = new Set([...CORE_MANDATORY_REVIEWER_IDS, "review-regression"]);

/** What the supersede and overlap rules need to know about the round. */
export type SupersedeContext = {
  /** The project root, to place a project overlay's directory against the changed files. */
  root?: string | undefined;
  /** The round's changed files (scope A), project-relative; undefined when not recorded. */
  files?: readonly string[] | undefined;
};

/**
 * Why a project overlay may not remove another reviewer this round, or undefined: the round changes the overlay itself
 * (a file of its directory is in scope A), so a branch could add a reviewer that "supersedes" the security reviewer of
 * its own review; or the changed files are not recorded, so that cannot be ruled out.
 */
function overlayChangedByRound(reviewer: { name: string; source: string; path?: string }, context: SupersedeContext): string | undefined {
  if (reviewer.source !== "project-skill" || reviewer.path === undefined) return undefined;
  if (context.files === undefined) return `${reviewer.name} is a project overlay and the round's changed files are not recorded, so it cannot be ruled out that this branch wrote it`;
  const absolute = path.isAbsolute(reviewer.path) ? reviewer.path : path.resolve(context.root ?? process.cwd(), reviewer.path);
  const dir = path.relative(context.root ?? process.cwd(), path.dirname(absolute)).split(path.sep).join("/");
  const changed = context.files.find((file) => file === dir || file.startsWith(`${dir}/`));
  return changed === undefined ? undefined : `${reviewer.name} is a project overlay this round changes (${changed})`;
}

/** Reviewers that are not part of a round's fan-out: they route, verify, or are opt-in. */
const NOT_ROSTER = new Set([
  "review-orchestrator",
  "review-verifier",
  "review-premise",
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

/**
 * The path gates that mark the risk class. `review-testing-practices` (any test file) and `review-frontend-conventions`
 * (any .ts/.js/.tsx file) are in BUNDLED_PATH_GATES but fire on almost every diff, so counting them would make a light
 * round unreachable; they are left out here. A data/migration file, a project-declared reviewer path gate, and the
 * remaining bundled gates (core/shared, flow graph, layout) do count.
 */
export const RISK_PATH_GATES: Record<string, (file: string) => boolean> = Object.fromEntries(
  Object.entries(BUNDLED_PATH_GATES).filter(([name]) => name !== "review-testing-practices" && name !== "review-frontend-conventions"),
);

export type DepthDecision = {
  requested: DepthRequest;
  depth: RoundDepth;
  reason: string;
  /** Set by {@link packageRoundDepth} when the recorded decision no longer matches the package and was dropped. */
  stale?: string | undefined;
};

export type DepthInput = {
  files?: readonly string[] | undefined;
  changedLines?: number | undefined;
  /** `--all` / `--gating`: a forced round is always full. */
  forceFull?: string | undefined;
};

/**
 * Light is never taken on the operator's word: `--depth light` runs the same checks as `auto` and resolves to full,
 * with the reason, when any of them fails. `--depth full`, `--all` and `--gating` are always full.
 */
export async function decideRoundDepth(root: string, request: DepthRequest, input: DepthInput): Promise<DepthDecision> {
  if (request === "full") return { requested: request, depth: "full", reason: "--depth full" };
  const checked = await autoDepth(root, input);
  if (request === "auto") return { requested: request, ...checked };
  return checked.depth === "light"
    ? { requested: request, depth: "light", reason: `--depth light: ${checked.reason}` }
    : { requested: request, depth: "full", reason: `--depth light not honoured: ${checked.reason.replace(/^auto: /, "")}` };
}

async function autoDepth(root: string, input: DepthInput): Promise<{ depth: RoundDepth; reason: string }> {
  const full = (reason: string): { depth: RoundDepth; reason: string } => ({ depth: "full", reason });
  if (input.forceFull !== undefined) return full(`auto: ${input.forceFull} forces the full set`);
  const files = input.files;
  if (files === undefined) return full("auto: no scope file list, so the diff size and risk class are unknown");
  if (input.changedLines === undefined) return full("auto: no line count (changed-line count unknown; pass --scope <scope.json> or --diff-lines <n>)");
  if (files.length > LIGHT_MAX_FILES) return full(`auto: ${files.length} files exceeds ${LIGHT_MAX_FILES}`);
  if (input.changedLines > LIGHT_MAX_CHANGED_LINES) return full(`auto: ${input.changedLines} changed lines exceeds ${LIGHT_MAX_CHANGED_LINES}`);
  const hit = Object.entries(RISK_PATH_GATES).find(([, gate]) => files.some(gate));
  if (hit) return full(`auto: a file hits the ${hit[0]} path gate (risk class)`);
  if (files.some((f) => DATA_FILE.test(f))) return full("auto: a data/migration file is in the diff (risk class)");
  const inventory = await collectReviewers(root);
  for (const reviewer of inventory.project) {
    if (reviewer.pathsSource === "none" || !reviewer.paths.length) continue;
    const patterns = reviewer.paths.map(globToRegExp);
    if (files.some((f) => patterns.some((p) => p.test(f)))) return full(`auto: a file hits the project reviewer ${reviewer.name} path gate (risk class)`);
  }
  return { depth: "light", reason: `auto: ${files.length} file(s), ${input.changedLines} changed line(s), no risk-class path gate` };
}

/** `round-depth.json` in the package: what `required --package` decided, read back by `ledger build`. */
export const ROUND_DEPTH_FILE = "round-depth.json";

/** The package's scope facts a recorded depth is tied to: head, the sorted scope-A file list and the changed-line count. */
export type DepthBasis = { head?: string | undefined; files?: string[] | undefined; changedLines?: number | undefined };

export async function packageDepthBasis(packageDir: string): Promise<DepthBasis> {
  const manifest = await readFile(path.join(packageDir, "manifest.json"), "utf8").then((t) => JSON.parse(t)).catch(() => undefined);
  const head = manifest?.target?.head;
  const files = await packageScopeFiles(packageDir);
  return { head: typeof head === "string" ? head : undefined, files: files === undefined ? undefined : [...files].sort(), changedLines: await packageChangedLines(packageDir) };
}

/** The changed-line count `keryx review start|ingest --scope` stored next to the file list, when it did. */
export async function packageChangedLines(packageDir: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(packageDir, "scope-files.json"), "utf8"));
    return typeof parsed?.changedLines === "number" && Number.isFinite(parsed.changedLines) && parsed.changedLines >= 0 ? parsed.changedLines : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `required --package` decided for this package, or a full decision marked `stale` when the recorded one was made
 * for another head, file list or line count. Undefined when nothing was recorded.
 */
export async function packageRoundDepth(packageDir: string): Promise<DepthDecision | undefined> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path.join(packageDir, ROUND_DEPTH_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!((parsed?.depth === "light" || parsed?.depth === "full") && typeof parsed.reason === "string")) return undefined;
  const decision: DepthDecision = { requested: (parsed.requested as DepthRequest | undefined) ?? "auto", depth: parsed.depth, reason: parsed.reason };
  if (decision.depth === "full") return decision;
  const now = await packageDepthBasis(packageDir);
  const recorded = Array.isArray(parsed.files) && parsed.files.every((f) => typeof f === "string") ? [...(parsed.files as string[])].sort() : undefined;
  const stale = (why: string): DepthDecision => ({ requested: decision.requested, depth: "full", reason: `${ROUND_DEPTH_FILE} ignored: ${why}`, stale: why });
  if (recorded === undefined || now.files === undefined || recorded.join("\n") !== now.files.join("\n")) return stale("it was decided for a different scope file list");
  if (typeof parsed.changedLines !== "number" || parsed.changedLines !== now.changedLines) return stale("it was decided for a different changed-line count");
  if (parsed.head !== undefined && now.head !== undefined && parsed.head !== now.head) return stale("it was decided for a different head");
  return decision;
}

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
  /** `light` narrows the set to logic, testing and one conventions reviewer; default `full`. */
  depth?: RoundDepth | undefined;
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
  const record = asRecord(dispatch);
  if (record === undefined) return [];
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

/**
 * Drop the reviewers a selected reviewer `supersedes` (flow 458 AC6), recording each as excluded with the reason. Project
 * reviewers are applied first, so an overlay that supersedes a bundled reviewer wins even when the bundled one declares
 * the reverse; a reviewer already superseded supersedes nothing.
 */
export function applySupersedes(
  required: readonly string[],
  inventory: Pick<ReviewerInventory, "bundled" | "project">,
  excluded: RequiredSet["excluded"],
  context: SupersedeContext = {},
  notes: string[] = [],
): string[] {
  const kept = new Set(required);
  for (const reviewer of [...inventory.project, ...inventory.bundled]) {
    if (!kept.has(reviewer.name)) continue;
    const targets = (reviewer.supersedes ?? []).filter((target) => target !== reviewer.name && kept.has(target));
    if (targets.length === 0) continue;
    // M6: the core roles are never superseded, and an overlay this round may have written supersedes nothing.
    const core = targets.filter((target) => NEVER_SUPERSEDED.has(target));
    if (core.length > 0) notes.push(`${reviewer.name} supersedes ${core.join(", ")}: ignored, ${core.length === 1 ? "it is a core role" : "they are core roles"} that always run`);
    const rest = targets.filter((target) => !NEVER_SUPERSEDED.has(target));
    if (rest.length === 0) continue;
    const changed = overlayChangedByRound(reviewer, context);
    if (changed !== undefined) {
      notes.push(`${reviewer.name} supersedes ${rest.join(", ")}: ignored, ${changed}`);
      continue;
    }
    for (const target of rest) {
      kept.delete(target);
      excluded.push({ reviewer: target, reason: `superseded by ${reviewer.name}` });
    }
  }
  return required.filter((name) => kept.has(name));
}

/**
 * One reviewer per overlap group (flow 458 AC6): of the required members of a group, the most specific — project
 * overlay, then bundled specific, then generic — stays, and a lower-ranked member is excluded when the kept one reads
 * every line it would: the kept one has no path gate, or the scope-A files are known and each file the excluded one's
 * gate matches is matched by the kept one's. A path-gated overlay that covers only part of the diff leaves the bundled
 * member in place for the rest; slice routing then gives each slice one of them.
 */
export function applyOverlapGroups(
  required: readonly string[],
  inventory: Pick<ReviewerInventory, "bundled" | "project">,
  files: readonly string[] | undefined,
  excluded: RequiredSet["excluded"],
  context: Omit<SupersedeContext, "files"> = {},
  notes: string[] = [],
): string[] {
  const kept = new Set(required);
  const byName = new Map([...inventory.project, ...inventory.bundled].map((reviewer) => [reviewer.name, reviewer] as const));
  const projectGates = new Map(inventory.project.filter((r) => r.pathsSource !== "none" && r.paths.length > 0).map((r) => [r.name, r.paths.map(globToRegExp)]));
  const gateOf = (name: string): ((file: string) => boolean) | undefined => {
    const bundled = BUNDLED_PATH_GATES[name];
    if (bundled !== undefined) return bundled;
    const patterns = projectGates.get(name);
    return patterns === undefined ? undefined : (file) => patterns.some((p) => p.test(file));
  };
  const covers = (winner: string, loser: string): boolean => {
    const wide = gateOf(winner);
    if (wide === undefined) return true;
    if (files === undefined) return false;
    const narrow = gateOf(loser);
    return files.filter((file) => narrow === undefined || narrow(file)).every((file) => wide(file));
  };
  for (const [group, members] of Object.entries(overlapGroupsOf(inventory))) {
    const present = members.filter((member) => kept.has(member));
    const winner = present[0];
    if (winner === undefined) continue;
    const winnerReviewer = byName.get(winner);
    const changed = winnerReviewer === undefined ? undefined : overlayChangedByRound(winnerReviewer, { ...context, files });
    for (const member of present.slice(1)) {
      if (!covers(winner, member)) continue;
      // M6: a core role always runs, and an overlay this round may have written removes no one.
      if (NEVER_SUPERSEDED.has(member)) {
        notes.push(`overlap group ${group}: ${member} kept beside ${winner}, it is a core role that always runs`);
        continue;
      }
      if (changed !== undefined) {
        notes.push(`overlap group ${group}: ${member} kept beside ${winner}, ${changed}`);
        continue;
      }
      kept.delete(member);
      excluded.push({ reviewer: member, reason: `overlap group ${group}: ${winner} reads the same lines` });
    }
  }
  return required.filter((name) => kept.has(name));
}

/** The light round's conventions reviewer: the first preference the roster holds, raised to its overlap group's top member when the roster holds that. */
function lightConventionsReviewer(roster: readonly string[], inventory: Pick<ReviewerInventory, "bundled" | "project">): string | undefined {
  const pick = LIGHT_CONVENTIONS_PREFERENCE.find((name) => roster.includes(name));
  if (pick === undefined) return undefined;
  const group = Object.values(overlapGroupsOf(inventory)).find((members) => members.includes(pick));
  return group?.find((member) => roster.includes(member)) ?? pick;
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
  if (options.depth === "light") {
    const conventions = lightConventionsReviewer(roster, inventory);
    const keep = new Set([...LIGHT_FIXED_REVIEWERS, ...(conventions === undefined ? [] : [conventions])]);
    const light = roster.filter((name) => keep.has(name));
    for (const name of roster) if (!keep.has(name)) excluded.push({ reviewer: name, reason: "light round: only logic, testing and the stack's conventions reviewer run" });
    for (const name of [REGRESSION, PR_CONTRACT]) if (inventory.bundled.some((r) => r.name === name)) excluded.push({ reviewer: name, reason: "light round: not part of the light set" });
    const notes: string[] = [];
    const kept = applySupersedes(light, inventory, excluded, { root, files }, notes).sort();
    return { mode, depth: "light", required: kept, excluded, filesKnown, ...(notes.length === 0 ? {} : { notes }) };
  }
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
  const notes: string[] = [];
  const collapsed = applyOverlapGroups(applySupersedes(required, inventory, excluded, { root, files }, notes), inventory, files, excluded, { root }, notes).sort();
  return { mode, depth: "full", required: collapsed, excluded, filesKnown, ...(notes.length === 0 ? {} : { notes }) };
}

export type CoverageOptions = {
  root: string;
  /** Scope-A files recorded with the package, when there are any. */
  files?: readonly string[] | undefined;
  /** Whether the package holds a blast-radius record. */
  blastRadius?: boolean | undefined;
  /** Whether the package holds `pr-context.md`. */
  prContext?: boolean | undefined;
  /** Changed lines of the scope, from `scope-files.json`; unknown keeps a light dispatch from being accepted. */
  changedLines?: number | undefined;
  /** Proposed mutants no recorded mutation pass has run (`pendingMutants`). */
  pendingMutants?: number | undefined;
  /** False for `keryx review run --autonomous`; defaults to the environment the process runs in. */
  attended?: boolean | undefined;
  /**
   * The package directory. When set, a dispatch that says `light` is checked against the diff the package's target names
   * (recomputed from git), not against the recorded `scope-files.json`, and a recorded full round-depth binds.
   */
  packageDir?: string | undefined;
  /** Recomputes the scope's files and changed lines for the light check; undefined when the diff cannot be resolved. Defaults to git, from the package manifest's target. */
  diffStats?: (() => Promise<{ files: string[]; changedLines: number } | undefined>) | undefined;
};

type DiffStats = { files: string[]; changedLines: number };

/** One `git diff base...head` at `cwd`: the stats, or why git could not answer. */
async function gitDiffAt(cwd: string, base: string, head: string, pathspec: readonly string[]): Promise<DiffStats | { error: string }> {
  try {
    assertGitRevision(base);
    assertGitRevision(head);
    const proc = Bun.spawn(["git", "diff", "--no-color", "-U20", "--end-of-options", `${base}...${head}`, "--", ...pathspec], { cwd, stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode !== null) return { error: `git was stopped (${proc.signalCode})` };
    if (exitCode !== 0) return { error: stderr.trim().split("\n")[0] || `git exited ${exitCode}` };
    const scope = buildReviewScope(stdout);
    return { files: scope.files, changedLines: scope.counts.changedLinesRetained };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** At most this many entries are kept in each per-process cache below; the oldest goes first. */
const GIT_CACHE_ENTRIES = 64;
/**
 * How long a cached git answer is trusted. The gate runs inside the long-lived keryx shell, where the process outlives
 * many commands, checkouts and worktree moves; a short life keeps one command (readiness then complete, a panel refresh)
 * paying for git once without an answer outliving the checkout it was read from. It also bounds a pending entry: one
 * older than this is recomputed rather than awaited.
 */
const GIT_CACHE_TTL_MS = 30_000;
/** Every git call of the light recheck is killed after this long (SIGKILL) and reads as a failure. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Remembers `compute(arg)` for {@link GIT_CACHE_TTL_MS}, keyed by `keyOf(arg)`, at most GIT_CACHE_ENTRIES keys; a value
 * `keep` rejects is not remembered. The arguments travel typed; the key is only a key.
 */
function processCache<A, T>(compute: (arg: A) => Promise<T>, keep: (value: T) => boolean, keyOf: (arg: A) => string): (arg: A) => Promise<T> {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (arg) => {
    const key = keyOf(arg);
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at <= GIT_CACHE_TTL_MS) return hit.value;
    cache.delete(key);
    const entry = { at: Date.now(), value: compute(arg) };
    entry.value = entry.value.then((value) => {
      if (!keep(value) && cache.get(key) === entry) cache.delete(key);
      return value;
    });
    cache.set(key, entry);
    if (cache.size > GIT_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    return entry.value;
  };
}

/** The repository top level that holds `dir`, or undefined when it is not inside a git work tree. Cached briefly per directory (see GIT_CACHE_TTL_MS). */
const gitTopLevel = processCache(uncachedGitTopLevel, (top) => top !== undefined, (dir) => dir);

async function uncachedGitTopLevel(dir: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stdout: "pipe", stderr: "ignore", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const top = stdout.trim();
    return exitCode === 0 && top !== "" ? top : undefined;
  } catch {
    return undefined;
  }
}

const UNRESOLVED = "the diff could not be resolved from git to confirm the size";

/**
 * The scope the package's target names, recomputed from git (flow 460). The base is resolved for every target kind —
 * never the target's own ref, which for a branch target is the head itself — by `resolveBase` (git-base.ts, as `review
 * plan` reads it): the recorded `target.base`, else the first of origin/main, main, origin/master, master that resolves.
 * A recorded base can only widen the check: it is supplied by whoever started the round, so when the default base gives
 * a larger diff, that one is measured (a `--base head~1` on a large pull request cannot make it look small). Git runs at
 * the repository top level of the package — the scope's files are repository paths, and a package can sit under a
 * subdirectory's `.metaproject` — with the review packages of the project root excluded (the slicer's exclusion). A range
 * that resolves empty (base equals head, as for a merged pull request with no recorded base) is not a small diff: it
 * refuses with the empty-range warning, so the full set applies until a base is given. A refusal names the directory,
 * the base and the head. A successful result is remembered briefly (see processCache).
 */
async function packageDiffStats(options: CoverageOptions): Promise<DiffStats | { error: string }> {
  if (options.diffStats !== undefined) return (await options.diffStats()) ?? { error: UNRESOLVED };
  if (options.packageDir === undefined) return { error: UNRESOLVED };
  const target = await readPackageTarget(options.packageDir);
  if (target.head === undefined) return { error: `${UNRESOLVED}: the package manifest records no target head (cwd ${options.packageDir}, base ${target.recordedBase ?? "unresolved"}, head unrecorded)` };
  return packageDiffStatsCached({ packageDir: options.packageDir, root: options.root, target: { ...target, head: target.head } });
}

/**
 * The target fields the light recheck reads from the package manifest: the base the round was started with (`--base`,
 * else the pull request's own base as `review start` read it), the pull request's base when it was read beside a
 * `--base` (`prBase`), and the head.
 */
type PackageTarget = { recordedBase?: string | undefined; prBase?: string | undefined; head?: string | undefined };
type DiffRequest = { packageDir: string; root: string; target: PackageTarget & { head: string } };

async function readPackageTarget(packageDir: string): Promise<PackageTarget> {
  const manifest: unknown = await readFile(path.join(packageDir, "manifest.json"), "utf8").then((t): unknown => JSON.parse(t)).catch(() => undefined);
  const target = asRecord(asRecord(manifest)?.target) ?? {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  return { recordedBase: str(target.base), prBase: str(target.prBase), head: str(target.head) };
}

const packageDiffStatsCached = processCache(diffOfTarget, (value) => !("error" in value), (request: DiffRequest) => JSON.stringify([request.packageDir, request.root, request.target]));

/**
 * The bases the diff runs against, in order of preference: the recorded base (or, without one, the pull request's own
 * base, then the default base) first; then the pull request's base and the default base when they resolve to another
 * merge-base, so the widest is measured — a `--base` the starter chose cannot narrow the diff, even in a repository with
 * no main/master ref. An empty range on the first is a refusal.
 */
async function resolveDiffBases(cwd: string, target: DiffRequest["target"]): Promise<{ bases: string[] } | { error: string }> {
  const git = defaultGitRunner(cwd, { timeoutMs: GIT_TIMEOUT_MS });
  // resolveBase falls back to the defaults when the given base does not resolve: only the given base itself counts here.
  const exactly = (base: string | undefined) => (base === undefined ? Promise.resolve(null) : resolveBase(git, { base }, target.head).then((found) => (found?.ref === base ? found : null)));
  const [recorded, prBase, fallback] = await Promise.all([exactly(target.recordedBase), exactly(target.prBase), resolveBase(git, {}, target.head)]);
  const primary = recorded ?? prBase ?? fallback;
  if (primary === null) return { error: `no base resolves (tried ${[target.recordedBase, target.prBase, ...DEFAULT_BASE_CANDIDATES].filter(Boolean).join(", ")})` };
  const empty = emptyRangeWarning(primary, target.head);
  if (empty !== undefined) return { error: empty };
  const seen = new Set([primary.sha]);
  const wider: string[] = [];
  for (const other of [prBase, fallback]) {
    if (other === null || seen.has(other.sha) || emptyRangeWarning(other, target.head) !== undefined) continue;
    seen.add(other.sha);
    wider.push(other.ref);
  }
  return { bases: [primary.ref, ...wider] };
}

/** The widest of several diffs, per dimension: every file any of them changes, and the most changed lines any of them counts. */
export function widestDiff(diffs: readonly DiffStats[]): DiffStats {
  return { files: [...new Set(diffs.flatMap((diff) => diff.files))], changedLines: Math.max(0, ...diffs.map((diff) => diff.changedLines)) };
}

async function diffOfTarget({ packageDir, root, target }: DiffRequest): Promise<DiffStats | { error: string }> {
  const cwd = (await gitTopLevel(packageDir)) ?? (await gitTopLevel(root));
  const where = (base: string | undefined): string => `cwd ${cwd ?? packageDir}, base ${base ?? "unresolved"}, head ${target.head}`;
  if (cwd === undefined) return { error: `${UNRESOLVED}: the package is not inside a git work tree (${where(target.recordedBase)})` };
  const resolved = await resolveDiffBases(cwd, target);
  if ("error" in resolved) return { error: `${UNRESOLVED}: ${resolved.error} (${where(target.recordedBase)})` };
  // git prints its top level with symlinks resolved: the project root is resolved the same way, or a project reached
  // through a symlink (macOS /tmp -> /private/tmp) yields a `../..` pathspec that excludes no review package.
  const realRoot = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const pathspec = notReviewPackagesAt(path.relative(cwd, realRoot));
  const diffs: DiffStats[] = [];
  for (const base of resolved.bases) {
    const result = await gitDiffAt(cwd, base, target.head, pathspec);
    if ("error" in result) return { error: `${UNRESOLVED}: git diff ${base}...${target.head} failed (${where(base)}): ${result.error}` };
    diffs.push(result);
  }
  return widestDiff(diffs);
}

/**
 * An attended run is every run except the autonomous runner's child shell and a round whose package records an
 * unattended start (`review start --unattended`, ./run-profile.ts). Re-exported for the callers that read it here.
 */
export { isAttendedRun };

/**
 * The depth the gate holds a dispatch to. A dispatch that says `light` is trusted only while the current scope still
 * qualifies for a light round (small, outside the risk class); otherwise the full-round rules apply.
 */
async function effectiveDepth(record: Record<string, unknown>, options: CoverageOptions): Promise<{ depth: RoundDepth; refused?: string }> {
  if (record.depth !== "light") return { depth: "full" };
  if (options.packageDir !== undefined) {
    const recorded = await packageRoundDepth(options.packageDir);
    if (recorded?.depth === "full" && recorded.stale === undefined) return { depth: "full", refused: `${ROUND_DEPTH_FILE} records a full round (${recorded.reason}), which binds` };
  }
  let input: DepthInput = { files: options.files, changedLines: options.changedLines };
  if (options.packageDir !== undefined || options.diffStats !== undefined) {
    const stats = await packageDiffStats(options);
    if ("error" in stats) return { depth: "full", refused: stats.error };
    input = { files: stats.files, changedLines: stats.changedLines };
  }
  const decision = await decideRoundDepth(options.root, "auto", input);
  return decision.depth === "light" ? { depth: "light" } : { depth: "full", refused: decision.reason.replace(/^auto: /, "") };
}

/** The head the package records (`manifest.target.head`), or undefined. */
async function packageHead(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(packageDir, "manifest.json"), "utf8")) as { target?: { head?: unknown } };
    return typeof manifest.target?.head === "string" && manifest.target.head.trim() !== "" ? manifest.target.head.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The required reviewers (mode all) of a package that `selected` leaves out; all of them when `selected` is undefined. */
export async function reviewersLeftOut(packageDir: string, selected: readonly string[] | undefined): Promise<{ required: string[]; missing: string[] }> {
  const need = await requiredReviewers(projectRootOfPackage(packageDir), "all", await packageScopeFiles(packageDir), {
    blastRadius: await packageHasBlastRadius(packageDir),
    prContext: packageHasPrContext(packageDir),
  });
  return { required: need.required, missing: selected === undefined ? need.required : need.required.filter((role) => !selected.includes(role)) };
}

/**
 * What a decision of `kind` waives on this package right now (security review M4): the package head, and the unrun
 * mutant ids (mutation waiver) or the required reviewers `selected` leaves out (override). The card, the terminal
 * command and the gate all compute it here, so the record binds to what the operator was shown.
 */
export async function operatorDecisionSubject(packageDir: string, kind: OperatorDecisionKind, selected?: readonly string[]): Promise<OperatorDecisionSubject> {
  const head = await packageHead(packageDir);
  const items = kind === "mutation-waiver" ? (await pendingMutants(packageDir)).map((mutant) => mutant.id) : (await reviewersLeftOut(packageDir, selected)).missing;
  return { ...(head === undefined ? {} : { head }), items: [...new Set(items)].sort() };
}

/**
 * On a package stamped with the operator gate (./run-profile.ts), a quote in the dispatch is not the operator's word
 * unless a card or a terminal recorded the decision (./operator-decisions.ts), bound to the head and to at least what
 * is waived now. Undefined: nothing is missing.
 */
async function unconfirmedDecision(options: CoverageOptions, kind: OperatorDecisionKind, selected?: readonly string[]): Promise<string | undefined> {
  const dir = options.packageDir;
  if (dir === undefined || !operatorGateApplies(dir)) return undefined;
  const now = await operatorDecisionSubject(dir, kind, selected);
  if ((await confirmedDecision(dir, kind, now)) !== undefined) return undefined;
  const recorded = await confirmedDecision(dir, kind);
  const stale =
    recorded === undefined
      ? ""
      : `the recorded decision (${recorded.at}) does not cover this: it was ${recorded.subject === undefined ? "not bound to a head or to what it waived" : `shown head ${recorded.subject.head ?? "unknown"} and ${recorded.subject.items.length} item(s)`}, and now the head is ${now.head ?? "unknown"} with ${now.items.length === 0 ? "nothing" : now.items.join(", ")} to waive. `;
  return `${stale}${writersFor(kind, dir)}`;
}

/** The card and terminal command that record an operator decision of `kind` for the package, named relative to the working directory. */
function writersFor(kind: OperatorDecisionKind, packageDir: string | undefined): string {
  return decisionWriters(kind, packageDir === undefined ? "<review-dir>" : path.relative(process.cwd(), packageDir) || ".");
}

async function mutationErrors(record: Record<string, unknown>, options: CoverageOptions, depth: RoundDepth): Promise<string[]> {
  const pending = options.pendingMutants ?? 0;
  if (depth === "light") return [];
  if (pending === 0 || (options.attended ?? isAttendedRun(process.env, options.packageDir)) === false) return [];
  const missing = await unconfirmedDecision(options, "mutation-waiver");
  if (operatorGateApplies(options.packageDir)) {
    if (missing === undefined) return [];
    return [
      `${pending} proposed mutant(s) in research-evidence/mutants.json were never run, so \`Not run: mutation pass\` is not allowed on an attended review. ` +
        `Run \`keryx review mutate --test "<command>" --package <review-dir>\`, or have the operator waive it: ${missing}. ` +
        "A mutationWaiver quote written into the dispatch is not the operator's word. A run with nobody present declares it at the start: `keryx review start --unattended`",
    ];
  }
  const waiver = asRecord(record.mutationWaiver) ?? {};
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
  const record = asRecord(dispatch);
  const effective = record === undefined ? undefined : await effectiveDepth(record, options);
  const profileMissing = runProfileRefusal(options.packageDir);
  return [...(profileMissing === undefined ? [] : [profileMissing]), ...(await reviewerSetErrors(dispatch, options, effective)), ...(record === undefined || effective === undefined ? [] : await mutationErrors(record, options, effective.depth))];
}

async function reviewerSetErrors(dispatch: unknown, options: CoverageOptions, effective: { depth: RoundDepth; refused?: string } | undefined): Promise<string[]> {
  const record = asRecord(dispatch);
  if (record === undefined) return [];
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (record.mode !== "all" && record.mode !== "diff")
    return ['dispatch must declare mode "all" (every available reviewer) or "diff" (the set derived from the diff); run `keryx review required --mode all|diff`'];
  if (record.mode === "diff" && !text(record.operatorQuote))
    return ['dispatch mode "diff" narrows the reviewer set and needs operatorQuote (the operator\'s own words naming a narrower review); a pull request defaults to mode "all"'];
  const override = record.override;
  // A narrowed set (mode diff, or an override) is the operator's decision; on a gated package only a card or a terminal records it.
  const selectedNow = Array.isArray(record.selected) ? record.selected.filter(text) : [];
  const unconfirmed = record.mode === "diff" || override !== undefined ? await unconfirmedDecision(options, "reviewer-override", selectedNow) : undefined;
  if (unconfirmed !== undefined) {
    return [`dispatch ${override !== undefined ? "override" : 'mode "diff"'} narrows the reviewer set, and an operatorQuote written into the dispatch is not the operator's word on this package: ${unconfirmed}`];
  }
  if (override !== undefined) {
    const o = asRecord(override) ?? {};
    return text(o.operatorQuote) && text(o.reason)
      ? []
      : ["dispatch override needs operatorQuote (the operator's own words) and reason; without them a smaller reviewer set is not allowed"];
  }
  if (record.mode === "diff" && options.files === undefined)
    return ["diff mode needs the scope-A file list: pass `--scope <scope.json>` to `keryx review start|ingest`, or run mode all"];
  const need = await requiredReviewers(options.root, record.mode, options.files, {
    blastRadius: options.blastRadius,
    prContext: options.prContext === true && dispatchKnowsRole(record, PR_CONTRACT),
    depth: effective?.depth ?? "full",
  });
  const selected = new Set(Array.isArray(record.selected) ? record.selected.filter(text) : []);
  // A deliberate skip (`ledger build --skip <reviewer> --reason`) accounts for a required reviewer only with its reason
  // AND the operator's recorded decision (M5): `dispatch.skipped` is written by the agent's command, so the entry alone is
  // never the operator's word.
  const skips = dispatchSkips(record).filter((skip) => need.required.includes(skip.reviewer) && !selected.has(skip.reviewer));
  const decided = await skipDecision(options.packageDir, skips.map((skip) => skip.reviewer));
  if (decided.ok) for (const skip of skips) selected.add(skip.reviewer);
  const missing = need.required.filter((name) => !selected.has(name));
  if (!missing.length) return [];
  if (!decided.ok) return [`dispatch.skipped is not accepted: ${decided.refusal}`];
  if (await overrideRecorded(options.packageDir, selectedNow, missing)) return [];
  const repair = operatorGateApplies(options.packageDir)
    ? `Dispatch them, or have the operator leave them out (${writersFor("reviewer-override", options.packageDir)})`
    : "Dispatch them, or record an operator override {operatorQuote, reason}";
  return [
    `dispatch covers ${need.required.length - missing.length} of ${need.required.length} reviewers that mode ${record.mode} requires; missing: ${missing.join(", ")}. ` +
      repair +
      "; `keryx review required` prints the set" +
      (effective?.refused === undefined ? "" : `. The dispatch says depth light, but the full set applies: ${effective.refused}`),
  ];
}

/**
 * Flow 460 (B). The `review_override_reviewers` card and `keryx review override-reviewers` write only the operator
 * decision, never a dispatch `override` field, so the decision itself accounts for the reviewers it left out: one bound
 * to the package's current head and shown at least every reviewer `selected` leaves out now (and every one missing here).
 * A decision for another head or a smaller set of left-out reviewers counts for nothing.
 */
async function overrideRecorded(packageDir: string | undefined, selected: readonly string[], missing: readonly string[]): Promise<boolean> {
  if (packageDir === undefined) return false;
  const now = await operatorDecisionSubject(packageDir, "reviewer-override", selected);
  const subject = { ...now, items: [...new Set([...now.items, ...missing])].sort() };
  return (await confirmedDecision(packageDir, "reviewer-override", subject)) !== undefined;
}

/** A reviewer the operator chose not to run, with why: `dispatch.skipped` as `ledger build --skip --reason` writes it. */
export type ReviewerSkip = { reviewer: string; reason: string };

/**
 * Whether the operator decided these skips (M5). A skip of a required reviewer is a smaller reviewer set, so it needs the
 * same record an override does: a `reviewer-override` decision (the `review_override_reviewers` card or `keryx review
 * override-reviewers` at a terminal) bound to the package head and shown at least these reviewers as left out. The
 * reason typed after `--skip`, or a `dispatch.skipped` entry, is the agent's word and never enough on its own.
 */
export async function skipDecision(packageDir: string | undefined, skipped: readonly string[]): Promise<{ ok: true } | { ok: false; refusal: string }> {
  if (skipped.length === 0) return { ok: true };
  const writers = writersFor("reviewer-override", packageDir);
  if (packageDir === undefined) return { ok: false, refusal: `skipping ${skipped.join(", ")} needs the operator's decision recorded in the package: ${writers}` };
  const { required } = await reviewersLeftOut(packageDir, undefined);
  const outside = skipped.filter((name) => !required.includes(name));
  if (outside.length > 0) return { ok: false, refusal: `${outside.join(", ")} cannot be skipped: no operator decision can name ${outside.length === 1 ? "it" : "them"} (not in the mode-all required set ${required.join(", ") || "none"}); run ${outside.length === 1 ? "it" : "them"}` };
  const skip = new Set(skipped);
  const now = await operatorDecisionSubject(packageDir, "reviewer-override", required.filter((name) => !skip.has(name)));
  if ((await confirmedDecision(packageDir, "reviewer-override", now)) !== undefined) return { ok: true };
  return { ok: false, refusal: `skipping ${skipped.join(", ")} narrows the reviewer set and needs the operator's decision for head ${now.head ?? "unknown"} leaving out ${now.items.join(", ") || "nothing"}: ${writers} with --selected naming every other required reviewer` };
}

/** The well-formed entries of `dispatch.skipped`; an entry without a reviewer or a reason is not a skip. */
export function dispatchSkips(dispatch: unknown): ReviewerSkip[] {
  const record = asRecord(dispatch);
  if (record === undefined || !Array.isArray(record.skipped)) return [];
  const out: ReviewerSkip[] = [];
  for (const entry of record.skipped) {
    const skip = asRecord(entry);
    if (skip === undefined) continue;
    const { reviewer, reason } = skip;
    if (typeof reviewer === "string" && reviewer.trim() !== "" && typeof reason === "string" && reason.trim() !== "") out.push({ reviewer: reviewer.trim(), reason: reason.trim() });
  }
  return out;
}

/** The report line of one skip. */
export function skipLine(skip: ReviewerSkip): string {
  return `Not run: ${skip.reviewer} — ${skip.reason}`;
}

export async function packageScopeFiles(packageDir: string): Promise<string[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(packageDir, "scope-files.json"), "utf8"));
    return Array.isArray(parsed?.files) && parsed.files.every((f: unknown) => typeof f === "string") ? parsed.files : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project a package belongs to: the directory holding the nearest `.metaproject` above it. A package lives at
 * `<root>/.metaproject/reviews/<id>` or, bound to a flow, at `<root>/.metaproject/flows/<dir>/reviews/<id>` — counting
 * three levels up answered `.metaproject/flows` for the second. A package outside any `.metaproject` falls back to the
 * project root found from it, and with none, to the old three levels up.
 */
export function projectRootOfPackage(packageDir: string): string {
  const resolved = path.resolve(packageDir);
  const parts = resolved.split(path.sep);
  const at = parts.lastIndexOf(".metaproject");
  if (at > 0) return parts.slice(0, at).join(path.sep) || path.sep;
  const found = resolveProjectRoot(resolved);
  return found !== resolved ? found : path.resolve(resolved, "..", "..", "..");
}
