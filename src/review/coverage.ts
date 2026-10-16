import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractStackRequiresField, parseStackRequires, scopeReviewerByStack, detectProjectStack } from "./stack";
import { collectReviewers, overlapGroupsOf, type ReviewerInventory } from "./reviewers";
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

/**
 * Drop the reviewers a selected reviewer `supersedes` (flow 458 AC6), recording each as excluded with the reason. Project
 * reviewers are applied first, so an overlay that supersedes a bundled reviewer wins even when the bundled one declares
 * the reverse; a reviewer already superseded supersedes nothing.
 */
export function applySupersedes(required: readonly string[], inventory: Pick<ReviewerInventory, "bundled" | "project">, excluded: RequiredSet["excluded"]): string[] {
  const kept = new Set(required);
  for (const reviewer of [...inventory.project, ...inventory.bundled]) {
    if (!kept.has(reviewer.name)) continue;
    for (const target of reviewer.supersedes ?? []) {
      if (target === reviewer.name || !kept.has(target)) continue;
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
): string[] {
  const kept = new Set(required);
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
    for (const member of present.slice(1)) {
      if (!covers(winner, member)) continue;
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
    return { mode, depth: "light", required: applySupersedes(light, inventory, excluded).sort(), excluded, filesKnown };
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
  return { mode, depth: "full", required: applyOverlapGroups(applySupersedes(required, inventory, excluded), inventory, files, excluded).sort(), excluded, filesKnown };
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

/** The files and retained changed lines of `ref...head`, from one `git diff`; undefined when git cannot answer. */
export async function gitDiffStats(root: string, target: { ref: string; head: string }): Promise<{ files: string[]; changedLines: number } | undefined> {
  try {
    assertGitRevision(target.ref);
    assertGitRevision(target.head);
    const proc = Bun.spawn(["git", "diff", "--no-color", "-U20", "--end-of-options", `${target.ref}...${target.head}`], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0 || proc.signalCode !== null) return undefined;
    const scope = buildReviewScope(stdout);
    return { files: scope.files, changedLines: scope.counts.changedLinesRetained };
  } catch {
    return undefined;
  }
}

async function packageDiffStats(options: CoverageOptions): Promise<{ files: string[]; changedLines: number } | undefined> {
  if (options.diffStats !== undefined) return options.diffStats();
  if (options.packageDir === undefined) return undefined;
  const manifest = await readFile(path.join(options.packageDir, "manifest.json"), "utf8").then((t) => JSON.parse(t)).catch(() => undefined);
  const { ref, head } = manifest?.target ?? {};
  return typeof ref === "string" && typeof head === "string" ? gitDiffStats(options.root, { ref, head }) : undefined;
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
    if (stats === undefined) return { depth: "full", refused: "the diff could not be resolved from git to confirm the size" };
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
  return `${stale}${decisionWriters(kind, path.relative(process.cwd(), dir) || ".")}`;
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
  const effective = record === undefined ? undefined : await effectiveDepth(record, options);
  const profileMissing = runProfileRefusal(options.packageDir);
  return [...(profileMissing === undefined ? [] : [profileMissing]), ...(await reviewerSetErrors(dispatch, options, effective)), ...(record === undefined || effective === undefined ? [] : await mutationErrors(record, options, effective.depth))];
}

async function reviewerSetErrors(dispatch: unknown, options: CoverageOptions, effective: { depth: RoundDepth; refused?: string } | undefined): Promise<string[]> {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) return [];
  const record = dispatch as Record<string, unknown>;
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
    depth: effective?.depth ?? "full",
  });
  const selected = new Set(Array.isArray(record.selected) ? record.selected.filter(text) : []);
  // A deliberate skip (`ledger build --skip <reviewer> --reason`) accounts for a required reviewer only with its reason;
  // it is written as a `Not run:` line into the dispatch, so it is on the record, never a silent pass.
  for (const skip of dispatchSkips(record)) selected.add(skip.reviewer);
  const missing = need.required.filter((name) => !selected.has(name));
  if (!missing.length) return [];
  return [
    `dispatch covers ${need.required.length - missing.length} of ${need.required.length} reviewers that mode ${record.mode} requires; missing: ${missing.join(", ")}. ` +
      "Dispatch them, or record an operator override {operatorQuote, reason}; `keryx review required` prints the set" +
      (effective?.refused === undefined ? "" : `. The dispatch says depth light, but the full set applies: ${effective.refused}`),
  ];
}

/** A reviewer the operator chose not to run, with why: `dispatch.skipped` as `ledger build --skip --reason` writes it. */
export type ReviewerSkip = { reviewer: string; reason: string };

/** The well-formed entries of `dispatch.skipped`; an entry without a reviewer or a reason is not a skip. */
export function dispatchSkips(dispatch: unknown): ReviewerSkip[] {
  const record = dispatch && typeof dispatch === "object" && !Array.isArray(dispatch) ? (dispatch as Record<string, unknown>) : undefined;
  if (record === undefined || !Array.isArray(record.skipped)) return [];
  const out: ReviewerSkip[] = [];
  for (const entry of record.skipped) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { reviewer, reason } = entry as Record<string, unknown>;
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
