/**
 * Flow 458 AC1/AC3: which round this is, and against what.
 *
 * `review start|attach` asks every place a previous round of the same target can be recorded, in a fixed order:
 *
 * 1. local-package — `.metaproject/reviews/*` and `.metaproject/flows/*\/reviews/*` in this checkout;
 * 2. git-history — the same package files as the local branches (and the target's base branch) committed them in the
 *    last {@link HISTORY_DAYS} days (another machine's round, pushed, fetched and merged, is found here);
 * 3. github-block — the hidden `<!-- keryx:round … -->` block `review publish` appends, read from our own comments;
 * 4. github-comments — everybody else's comments on the pull request: prior findings, with no reviewed head;
 * 5. flow — the review rounds of the flow the package is bound to (they may name a different target ref).
 *
 * Each source is injectable. The previous round is the NEWEST reviewed head that is an ancestor of the current head
 * (fewest commits between it and the head); when a round newer than that was reviewed at a head that is NOT an
 * ancestor — a force-push or rebase — the round falls back to a full review over merge-base..head with the prior
 * findings attached (`fallback-first`).
 *
 * Trust (TM-04 §4d). A delta round reviews only prevHead..head, so the round it is cut from must be one this pipeline
 * really ran; the boundary is the user, as everywhere in TM-04:
 *
 * - a round block counts only from our own login (pr-comments.ts keeps the blocks of `self` alone);
 * - every package needs completion evidence (published.json, a ledger with `scopeReviewed`, or a closed package);
 * - a package in the working tree that no commit of merge-base..head added or changed — typically an untracked one — is
 *   the user's own and trusted;
 * - a package read from git history must be merged into the base branch (its commit an ancestor of the base), since a
 *   local branch may be anybody's checked-out pull request;
 * - a package the branch under review committed (or an unmerged one from history) is trusted only when the machine-local
 *   round registry (./round-registry.ts) holds keryx's own record of exactly its files.
 *
 * So data a pull request can commit never narrows a round: a forged package fails the merge-base or merged-base check
 * and has no registry entry on the reviewer's machine. An agent running as the same user can write the registry as it
 * can any user-owned file; that is the same-user limit TM-04 states. A candidate that is not trusted is kept as context
 * only — the round falls back to a full review with its findings attached — and `sourcesTried` says why.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readReviewRounds, type ReviewRoundRecord } from "../flow/review-gate";
import { flowsRoot } from "../flow/store";
import { defaultGitRunner, emptyRangeWarning, mergeBaseOf, resolveBase, type GitResult, type GitRunner } from "./git-base";
import { REVIEW_PACKAGE_MANIFEST_GLOBS, flowReviewsRoot, reviewsRoot } from "./package-location";
import { collectPrComments, createGhPort, type CollectedComment, type CollectedRoundBlock } from "./pr-comments";
import { mentionsFindingId } from "./publish";
import { readRoundRegistryReport, registryVouches, repoIdentity, type RoundRegistryEntry } from "./round-registry";
import {
  completionOf,
  findingStatus,
  isOpenStatus,
  NOT_REVIEW_PACKAGES,
  previousRoundFacts,
  packageFacts,
  packageHashesOf,
  quoteSha256,
  roundStampOf,
  type PackageHashes,
  SEARCH_ORDER,
  type FixHunk,
  type PriorFinding,
  type RoundHunk,
  type RoundMode,
  type RoundRecord,
  type RoundSource,
  type SearchedSource,
  type SourceAttempt,
} from "./round-record";

export type { GitResult, GitRunner };
export { defaultGitRunner, emptyRangeWarning, resolveBase };

export type GithubLookup =
  | { status: "consulted"; blocks: CollectedRoundBlock[]; comments: CollectedComment[] }
  | { status: "not-consulted"; detail: string };

export type PriorRoundTarget = { kind: string; ref: string; base?: string | undefined };

export type PriorRoundDeps = {
  cwd: string;
  git?: GitRunner | undefined;
  /** The pull request read (sources 3 and 4). Default: `gh`, with "not-consulted" when gh is missing or offline. */
  github?: ((target: PriorRoundTarget) => Promise<GithubLookup>) | undefined;
  /** Source 5. Default: {@link readReviewRounds}. */
  flowRounds?: ((cwd: string, flowDir: string) => Promise<ReviewRoundRecord[]>) | undefined;
  /** The flow directory name the new package is bound to, when it is. */
  flowDir?: string | undefined;
  /** The package being created: never its own previous round. */
  excludeReviewId?: string | undefined;
  /** Commits of package history read from git (source 2). Default 200. */
  historyLimit?: number | undefined;
  /** `--prior <package|reviewId>`: use this round, wherever it is found, instead of searching. It is held to the same trust rules. */
  forced?: string | undefined;
  /** The machine-local registry of rounds keryx finished (./round-registry.ts). Default: this repository's file. */
  registry?: readonly RoundRegistryEntry[] | undefined;
};

/** Whether a package candidate may be cut from: `ok` false keeps it as context only, with why. */
export type CandidateTrust = { ok: boolean; why: string };

/** One previous round as a source recorded it. */
export type RoundCandidate = {
  source: Exclude<SearchedSource, "github-comments">;
  reviewId: string;
  reviewedHead: string | null;
  round: number;
  /** Epoch ms of when the source says the round happened; 0 when it does not say. */
  at: number;
  packagePath?: string | undefined;
  findings: PriorFinding[];
  /** The package directory, repo-relative, whose history the trust check reads (package sources only). */
  packageDir?: string | undefined;
  /** Completion evidence the package shows (package sources only). */
  completed?: CandidateTrust | undefined;
  /** How the recorded target matched: the same target, or a branch target on the same branch line (checked by ancestry). */
  match?: "same" | "branch-line" | undefined;
  /** The base the recorded round named (its stamp's targetBase, or target.base), when it named one. */
  recordedBase?: string | undefined;
  /** git-history only: the commit that last touched the package's manifest, whose files the candidate was read from. */
  commit?: string | undefined;
  /** sha256 of the package's manifest/findings/round files as this source holds them (package sources only). */
  hashes?: PackageHashes | undefined;
  /** Set by the trust check. */
  trust?: CandidateTrust | undefined;
  /** Reasons the round's own record shows it read its scope weakly (uncovered slices, skipped reviewers, "Not run" lines). */
  weak?: string[] | undefined;
  /** The merge-base the round recorded in its round.json; undefined when it recorded none. */
  prevMergeBase?: string | null | undefined;
};

export type PriorRoundResult = { round: RoundRecord; priorFindings: PriorFinding[]; identity: { targetKey: string; targetBase?: string | undefined } };

/** How far back the git-history source reads. */
export const HISTORY_DAYS = 180;

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const SHA = /^[0-9a-f]{7,64}$/i;

/** A recorded head, only when it is a commit id: anything else (or a dash-leading value) is no head at all. */
function commitId(value: unknown): string | null {
  return typeof value === "string" && SHA.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const PR_URL = /github\.com\/([^/\s]+\/[^/\s#?]+)\/pull\/(\d+)/i;
const PR_SHORT = /^([^/\s]+\/[^/\s#]+)#(\d+)$/;
const PR_BARE = /^#?(\d+)$/;

/**
 * `owner/repo` and number of a pull request ref, or undefined when the ref names none. A bare number (`7`, `#7`) names
 * a pull request of this checkout's repository: its repo is "" and it matches that number in any repository spelling.
 */
export function pullRequestOf(ref: string): { repo: string; number: number } | undefined {
  const value = ref.trim();
  const match = PR_URL.exec(value) ?? PR_SHORT.exec(value);
  if (match !== null) return { repo: match[1]!.toLowerCase(), number: Number(match[2]) };
  const bare = PR_BARE.exec(value);
  return bare === null ? undefined : { repo: "", number: Number(bare[1]) };
}

/** Whether a recorded target is this target: the same ref, or the same pull request however it was written. */
export function sameReviewTarget(recorded: unknown, target: PriorRoundTarget): boolean {
  const raw = object(recorded);
  const ref = text(raw?.ref);
  if (ref === undefined) return false;
  if (ref.trim() === target.ref.trim() && (text(raw?.kind) ?? target.kind) === target.kind) return true;
  // A bare number is a pull request only where the target says it is one; a branch called "7" is a branch.
  const mine = target.kind === "pr" || !PR_BARE.test(target.ref.trim()) ? pullRequestOf(target.ref) : undefined;
  const theirs = text(raw?.kind) === "pr" || !PR_BARE.test(ref.trim()) ? pullRequestOf(ref) : undefined;
  return mine !== undefined && theirs !== undefined && mine.number === theirs.number && (mine.repo === theirs.repo || mine.repo === "" || theirs.repo === "");
}

/**
 * The normalised identity of a target: `pr:<owner/repo>#<n>` (`pr:#<n>` for a bare number), `branch:<name>`, or
 * `range:<base>` for a commit target (its ref is a SHA, which names no branch line on its own).
 */
export function targetKeyOf(target: { kind: string; ref: string }, base?: string | undefined): string {
  const ref = target.ref.trim();
  const pr = target.kind === "pr" ? pullRequestOf(ref) : undefined;
  if (pr !== undefined) return `pr:${pr.repo}#${pr.number}`;
  if (target.kind === "branch" && SHA.test(ref)) return `range:${base ?? "unknown"}`;
  return `${target.kind}:${ref}`;
}

/**
 * How a package's recorded target relates to this one: the same target (same ref or pull request, or the same non-range
 * key), a branch target that may sit on the same branch line (two branch targets whatever their spelling — confirmed
 * later by ancestry and merge-base), or no match.
 */
export function targetMatchOf(manifest: Record<string, unknown>, target: PriorRoundTarget, targetKey: string): RoundCandidate["match"] {
  const recorded = object(manifest.target);
  if (sameReviewTarget(recorded, target)) return "same";
  const recordedKey = roundStampOf(manifest)?.targetKey;
  if (recordedKey !== undefined && recordedKey === targetKey && !recordedKey.startsWith("range:")) return "same";
  if (target.kind === "branch" && text(recorded?.kind) === "branch") return "branch-line";
  return undefined;
}

/** The base a recorded round named: its stamp's targetBase, else target.base. */
function recordedBaseOf(manifest: Record<string, unknown>): string | undefined {
  return text(roundStampOf(manifest)?.targetBase) ?? text(object(manifest.target)?.base);
}

export { completionOf };

function priorFindingsOf(findings: unknown, source: RoundSource): PriorFinding[] {
  if (!Array.isArray(findings)) return [];
  const out: PriorFinding[] = [];
  findings.forEach((entry, index) => {
    const raw = object(entry);
    if (raw === undefined) return;
    const quote = text(raw.quote);
    const disposition = text(object(raw.disposition)?.state);
    out.push({
      id: text(raw.id) ?? `#${index + 1}`,
      reviewer: text(raw.reviewer) ?? "unknown",
      severity: text(raw.severity) ?? "info",
      file: text(raw.file) ?? null,
      line: typeof raw.line === "number" ? raw.line : null,
      ...(quote === undefined ? {} : { quote, quoteSha256: quoteSha256(quote) }),
      ...(text(raw.symbol) === undefined ? {} : { symbol: text(raw.symbol) }),
      problem: text(raw.problem) ?? text(raw.title) ?? "",
      status: findingStatus(raw),
      ...(disposition === undefined ? {} : { disposition }),
      source,
    });
  });
  return out;
}

function roundNumberOf(raw: unknown): number | undefined {
  const value = object(raw)?.round;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function stamp(manifest: Record<string, unknown>): number {
  const at = Date.parse(text(manifest.updatedAt) ?? text(manifest.createdAt) ?? "");
  return Number.isNaN(at) ? 0 : at;
}

const toPosix = (file: string): string => file.split(path.sep).join("/");

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** `git cat-file --batch` over `<rev>:<path>` specs: one process for any number of reads. Missing objects are absent. */
async function catFiles(git: GitRunner, specs: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (specs.length === 0) return out;
  const result = await git(["cat-file", "--batch"], { input: `${specs.join("\n")}\n` });
  if (result.exitCode !== 0) return out;
  const bytes = Buffer.from(result.stdout, "utf8");
  let cursor = 0;
  for (const spec of specs) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline === -1) break;
    const header = bytes.subarray(cursor, newline).toString("utf8");
    cursor = newline + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    out.set(spec, bytes.subarray(cursor, cursor + size).toString("utf8"));
    cursor += size + 1;
  }
  return out;
}

async function isAncestor(git: GitRunner, ancestor: string, head: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", "--end-of-options", ancestor, head])).exitCode === 0;
}

async function distance(git: GitRunner, from: string, head: string): Promise<number> {
  const result = await git(["rev-list", "--count", "--end-of-options", `${from}..${head}`]);
  const count = Number(result.stdout.trim());
  return result.exitCode === 0 && Number.isFinite(count) ? count : Number.MAX_SAFE_INTEGER;
}

/** New-side hunks of `from` with every line `remove` covers cut out: what `from` holds that `remove` does not. */
export function subtractHunks(from: readonly RoundHunk[], remove: readonly RoundHunk[]): RoundHunk[] {
  const out: RoundHunk[] = [];
  for (const hunk of from) {
    let pieces: Array<[number, number]> = [[hunk.startLine, hunk.endLine]];
    for (const cut of remove) {
      if (cut.file !== hunk.file) continue;
      pieces = pieces.flatMap(([start, end]): Array<[number, number]> => {
        if (cut.endLine < start || cut.startLine > end) return [[start, end]];
        const kept: Array<[number, number]> = [];
        if (cut.startLine > start) kept.push([start, cut.startLine - 1]);
        if (cut.endLine < end) kept.push([cut.endLine + 1, end]);
        return kept;
      });
    }
    for (const [startLine, endLine] of pieces) out.push({ file: hunk.file, startLine, endLine });
  }
  return out;
}

/**
 * The trust half of the rule for a package candidate: it must show completion evidence, and no commit of
 * merge-base..head may have added or changed its directory (with no merge-base known, no commit reachable from head).
 */
export async function packageTrust(
  git: GitRunner,
  candidate: RoundCandidate,
  head: string | null,
  base: { ref: string; sha: string } | null,
  registry: readonly RoundRegistryEntry[] = [],
): Promise<CandidateTrust> {
  if (candidate.completed?.ok !== true) return { ok: false, why: candidate.completed?.why ?? "no completion evidence" };
  if (candidate.packageDir === undefined) return { ok: false, why: "no package directory to check" };
  // The machine-local registry of rounds keryx finished: a package whose files hash to an entry is one keryx finished
  // here, whichever commit carries it (a flow package keryx committed on the PR branch, a round fetched from a branch).
  const vouched = registryVouches(registry, candidate.reviewId, candidate.hashes);
  const byRegistry = (detail: string): CandidateTrust => ({ ok: true, why: `trusted: local registry (${vouched!.event} at ${vouched!.completedAt}; the files match what keryx recorded), though ${detail}` });
  // A package read from another branch's history is anybody's commit — a checked-out foreign pull request among them.
  // It counts only once merged into the base branch, or with keryx's own record of it.
  if (candidate.source === "git-history") {
    const where = candidate.commit === undefined ? candidate.packageDir : `${candidate.packageDir} (at ${candidate.commit.slice(0, 12)})`;
    if (base === null || candidate.commit === undefined || !(await isAncestor(git, candidate.commit, base.ref))) {
      if (vouched !== undefined) return byRegistry(`${where} is not merged into ${base?.ref ?? "a known base"}`);
      return { ok: false, why: `${where} was committed on a branch not merged into ${base?.ref ?? "a known base"}, and the local round registry has no entry matching its files` };
    }
  }
  if (head === null) return { ok: true, why: `${candidate.completed.why}; no head, so the branch's own commits were not checked` };
  const range = base === null ? head : `${base.sha}..${head}`;
  const log = await git(["log", "-n1", "--format=%H", "--end-of-options", range, "--", candidate.packageDir]);
  if (log.exitCode !== 0) return { ok: false, why: `the branch's history of ${candidate.packageDir} could not be read` };
  const commit = log.stdout.trim();
  if (commit === "") return { ok: true, why: candidate.completed.why };
  // Committed by the branch — a flow package keryx commits on the PR branch, or a forgery; only the registry tells.
  if (vouched !== undefined) return byRegistry(`${candidate.packageDir} was committed by ${commit.slice(0, 12)}`);
  return {
    ok: false,
    why: `${candidate.packageDir} was added or changed by ${commit.slice(0, 12)}, a commit of ${base === null ? "this head's history" : "merge-base..head"}, and the local round registry has no entry matching its files: the branch under review cannot record its own previous round`,
  };
}

// ---------------------------------------------------------------------------
// The five sources
// ---------------------------------------------------------------------------

function packageDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const add = (root: string): void => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
  };
  add(reviewsRoot(cwd));
  const flows = flowsRoot(cwd);
  if (existsSync(flows)) {
    for (const entry of readdirSync(flows, { withFileTypes: true })) if (entry.isDirectory()) add(flowReviewsRoot(cwd, entry.name));
  }
  return dirs;
}

/** A package directory on disk as a candidate, with its completion evidence; undefined when it has no manifest. */
function diskCandidate(dir: string, cwd: string, source: "local-package" | "flow"): (RoundCandidate & { eligible: boolean; manifest: Record<string, unknown> }) | undefined {
  const manifest = object(readJsonFile(path.join(dir, "manifest.json")));
  if (manifest === undefined) return undefined;
  const findings = readJsonFile(path.join(dir, "findings.json"));
  const { eligible, completed } = completionOf(manifest, readJsonFile(path.join(dir, "research.json")), existsSync(path.join(dir, "published.json")));
  const relative = toPosix(path.relative(cwd, dir));
  return {
    source,
    reviewId: text(manifest.reviewId) ?? path.basename(dir),
    reviewedHead: commitId(object(manifest.target)?.head),
    round: roundNumberOf(readJsonFile(path.join(dir, "round.json"))) ?? 1,
    at: stamp(manifest),
    packagePath: relative,
    packageDir: relative,
    findings: priorFindingsOf(findings, source),
    completed,
    recordedBase: recordedBaseOf(manifest),
    hashes: packageFacts(dir)?.hashes,
    ...weakFacts(readJsonFile(path.join(dir, "research.json")), readJsonFile(path.join(dir, "round.json"))),
    eligible,
    manifest,
  };
}

function weakFacts(research: unknown, round: unknown): Pick<RoundCandidate, "weak" | "prevMergeBase"> {
  const facts = previousRoundFacts(research, round);
  return { weak: facts.weak, prevMergeBase: facts.mergeBase };
}

const strip = ({ eligible: _eligible, manifest: _manifest, ...candidate }: RoundCandidate & { eligible: boolean; manifest: Record<string, unknown> }): RoundCandidate => candidate;

/** Source 1: packages in this checkout for this target, past their draft (M1), with a head. */
export function localPackageCandidates(cwd: string, target: PriorRoundTarget, targetKey = targetKeyOf(target)): RoundCandidate[] {
  const found: RoundCandidate[] = [];
  for (const dir of packageDirs(cwd)) {
    const candidate = diskCandidate(dir, cwd, "local-package");
    if (candidate === undefined || candidate.reviewedHead === null || !candidate.eligible) continue;
    const match = targetMatchOf(candidate.manifest, target, targetKey);
    if (match === undefined) continue;
    found.push({ ...strip(candidate), match });
  }
  return found;
}

type HistoryEntry = { commit: string; at: number; manifestPath: string };

/** Read from the local branches, and the target's base branch (a resolved base ref, never dash-leading) when given. */
async function historyEntries(git: GitRunner, limit: number, baseRef: string | undefined): Promise<HistoryEntry[]> {
  const base = baseRef === undefined || baseRef.startsWith("-") ? [] : [baseRef];
  const log = await git(["log", "--branches", `--since=${HISTORY_DAYS} days ago`, `-n${limit}`, "--format=%x01%H %ct", "--name-only", "--end-of-options", ...base, "--", ...REVIEW_PACKAGE_MANIFEST_GLOBS]);
  if (log.exitCode !== 0) return [];
  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  for (const chunk of log.stdout.split("\x01")) {
    const [header, ...files] = chunk.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    if (header === undefined) continue;
    const [commit, seconds] = header.split(" ");
    if (commit === undefined || !/^[0-9a-f]{40,64}$/.test(commit)) continue;
    for (const file of files) {
      if (!file.endsWith("/manifest.json") || seen.has(file)) continue;
      // `git log` is newest first: the first commit that touched a manifest holds its latest committed state.
      seen.add(file);
      entries.push({ commit, at: Number(seconds) * 1000, manifestPath: file });
    }
  }
  return entries;
}

/**
 * Source 2: package files as the local branches and the base branch committed them in the last {@link HISTORY_DAYS}
 * days. Bounded to `limit` commits; two git reads.
 */
export async function gitHistoryCandidates(
  git: GitRunner,
  target: PriorRoundTarget | undefined,
  limit = 200,
  reviewId?: string,
  options: { baseRef?: string | undefined; targetKey?: string | undefined } = {},
): Promise<RoundCandidate[]> {
  const entries = await historyEntries(git, limit, options.baseRef);
  const manifests = await catFiles(git, entries.map((entry) => `${entry.commit}:${entry.manifestPath}`));
  const key = target === undefined ? undefined : (options.targetKey ?? targetKeyOf(target));
  const matching: Array<{ entry: HistoryEntry; manifest: Record<string, unknown>; match: RoundCandidate["match"] }> = [];
  for (const entry of entries) {
    const manifest = object(parseJson(manifests.get(`${entry.commit}:${entry.manifestPath}`)));
    if (manifest === undefined) continue;
    const id = text(manifest.reviewId) ?? path.basename(path.dirname(entry.manifestPath));
    if (reviewId !== undefined) {
      if (id === reviewId) matching.push({ entry, manifest, match: "same" });
      continue;
    }
    const match = target === undefined ? undefined : targetMatchOf(manifest, target, key!);
    if (match !== undefined) matching.push({ entry, manifest, match });
  }
  const extras = await catFiles(git, matching.flatMap(({ entry }) => {
    const dir = path.posix.dirname(entry.manifestPath);
    return ["findings.json", "round.json", "research.json", "published.json"].map((name) => `${entry.commit}:${dir}/${name}`);
  }));
  const found: RoundCandidate[] = [];
  for (const { entry, manifest, match } of matching) {
    const dir = path.posix.dirname(entry.manifestPath);
    const at = (name: string): string => `${entry.commit}:${dir}/${name}`;
    const findings = parseJson(extras.get(at("findings.json")));
    const { eligible, completed } = completionOf(manifest, parseJson(extras.get(at("research.json"))), extras.has(at("published.json")));
    const reviewedHead = commitId(object(manifest.target)?.head);
    if (reviewId === undefined && (reviewedHead === null || !eligible)) continue;
    found.push({
      source: "git-history",
      reviewId: text(manifest.reviewId) ?? path.basename(dir),
      reviewedHead,
      round: roundNumberOf(parseJson(extras.get(at("round.json")))) ?? 1,
      at: stamp(manifest) || entry.at,
      packagePath: `${dir} (at ${entry.commit.slice(0, 12)})`,
      packageDir: dir,
      commit: entry.commit,
      findings: priorFindingsOf(findings, "git-history"),
      completed,
      match,
      recordedBase: recordedBaseOf(manifest),
      ...weakFacts(parseJson(extras.get(at("research.json"))), parseJson(extras.get(at("round.json")))),
      hashes: packageHashesOf({ manifest: manifests.get(`${entry.commit}:${entry.manifestPath}`), findings: extras.get(at("findings.json")), round: extras.get(at("round.json")) }),
    });
  }
  return found;
}

/** Source 3: the round blocks of our own published reviews (pr-comments.ts keeps only blocks authored by our login). */
export function githubBlockCandidates(blocks: readonly CollectedRoundBlock[]): RoundCandidate[] {
  return blocks
    .filter((block) => block.reviewedHead !== null)
    .map((block) => ({
      source: "github-block" as const,
      reviewId: block.reviewId,
      reviewedHead: block.reviewedHead,
      round: block.round,
      at: Number.isNaN(Date.parse(block.submittedAt)) ? 0 : Date.parse(block.submittedAt),
      match: "same" as const,
      trust: { ok: true, why: "a round block authored by our own login on this pull request" },
      findings: block.findings.map((finding) => ({
        id: finding.id,
        reviewer: "unknown",
        severity: finding.severity,
        file: finding.file ?? null,
        line: finding.line ?? null,
        ...(finding.quoteSha256 === undefined ? {} : { quoteSha256: finding.quoteSha256 }),
        ...(finding.symbol === undefined ? {} : { symbol: finding.symbol }),
        problem: `(see the published review ${block.url || block.commentId})`,
        status: finding.status,
        source: "github-block" as const,
      })),
    }));
}

/** Source 4: everybody else's comments, as prior findings with no reviewed head. */
export function githubCommentFindings(comments: readonly CollectedComment[]): PriorFinding[] {
  return comments.map((comment) => ({
    id: comment.id,
    reviewer: comment.author,
    severity: comment.severity,
    file: comment.path,
    line: comment.line,
    problem: (comment.body.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim().slice(0, 300),
    status: "open",
    source: "github-comments",
  }));
}

/** Source 5: the rounds of the flow this package is bound to, with the completion evidence of each package on disk. */
export function flowCandidates(rounds: readonly ReviewRoundRecord[], cwd: string): RoundCandidate[] {
  return rounds.flatMap((round, index) => {
    if (commitId(round.head) === null || !round.ingested) return [];
    const disk = diskCandidate(path.resolve(cwd, round.dir), cwd, "flow");
    if (disk !== undefined && !disk.eligible) return [];
    const at = Date.parse(round.sortKey);
    return [{
      source: "flow" as const,
      reviewId: round.reviewId,
      reviewedHead: commitId(round.head),
      round: roundNumberOf(readJsonFile(path.join(cwd, round.dir, "round.json"))) ?? index + 1,
      at: Number.isNaN(at) ? 0 : at,
      packagePath: round.dir,
      packageDir: toPosix(round.dir),
      match: "same" as const,
      completed: disk?.completed ?? { ok: false, why: `no package on disk at ${round.dir}` },
      hashes: disk?.hashes,
      weak: disk?.weak,
      prevMergeBase: disk?.prevMergeBase,
      findings: priorFindingsOf(round.findings, "flow"),
    }];
  });
}

/** The default pull request read: `gh`, never throwing; anything short of a full read is "not consulted". */
export async function defaultGithubLookup(target: PriorRoundTarget): Promise<GithubLookup> {
  const pr = target.kind === "pr" || !PR_BARE.test(target.ref.trim()) ? pullRequestOf(target.ref) : undefined;
  if (pr === undefined) return { status: "not-consulted", detail: "the target is not a pull request" };
  const spawn = async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    try {
      const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 20_000);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      return { stdout, stderr, exitCode };
    } catch (error) {
      return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 127 };
    }
  };
  const user = await spawn(["gh", "api", "user", "--jq", ".login"]);
  const self = user.stdout.trim();
  if (user.exitCode !== 0 || self === "") {
    return { status: "not-consulted", detail: `gh is missing, signed out or offline (${user.stderr.trim().split("\n")[0] || `exit ${user.exitCode}`})` };
  }
  let repo = pr.repo;
  if (repo === "") {
    const view = await spawn(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    repo = view.exitCode === 0 ? view.stdout.trim().toLowerCase() : "";
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { status: "not-consulted", detail: `pull request #${pr.number} names no repository and this checkout's could not be read` };
  }
  try {
    const result = await collectPrComments({ port: createGhPort(spawn), repo, number: pr.number, self });
    return { status: "consulted", blocks: result.roundBlocks, comments: result.comments };
  } catch (error) {
    return { status: "not-consulted", detail: `the pull request could not be read (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
  }
}

// ---------------------------------------------------------------------------
// Hunks: the FIX / NEW split of a delta round
// ---------------------------------------------------------------------------

/** New-side hunks of a `git diff -U0` (or `git show -U0`) text. A pure deletion is the line after which it happened. */
export function parseDiffHunks(diff: string): RoundHunk[] {
  const hunks: RoundHunk[] = [];
  let file: string | null = null;
  let oldFile: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) oldFile = line === "--- /dev/null" ? null : line.replace(/^--- (a\/)?/, "");
    else if (line.startsWith("+++ ")) file = line === "+++ /dev/null" ? oldFile : line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("@@") && file !== null) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match === null) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      const first = Math.max(start, 1);
      hunks.push({ file, startLine: first, endLine: count === 0 ? first : start + count - 1 });
    }
  }
  return hunks;
}

export { NOT_REVIEW_PACKAGES };

/** Lines of slack either side when a hunk is matched to a finding's location. */
export const FIX_TOLERANCE = 2;

const overlaps = (hunk: RoundHunk, start: number, end: number): boolean =>
  hunk.startLine <= end + FIX_TOLERANCE && hunk.endLine >= start - FIX_TOLERANCE;

/** Where an open finding sits at `head`: by its quote, else its symbol, else its recorded line. Nearest to the old line. */
export function relocateFinding(finding: PriorFinding, content: string | undefined): { start: number; end: number } | undefined {
  if (content === undefined) return finding.line === null ? undefined : { start: finding.line, end: finding.line };
  const lines = content.split("\n");
  const near = (hits: number[]): number | undefined =>
    hits.length === 0 ? undefined : hits.reduce((best, hit) => (Math.abs(hit - (finding.line ?? hit)) < Math.abs(best - (finding.line ?? best)) ? hit : best));
  const quoteLines = finding.quote?.split("\n").map((line) => line.trim()).filter((line) => line !== "") ?? [];
  if (quoteLines.length > 0) {
    const first = quoteLines[0]!;
    const hit = near(lines.flatMap((line, index) => (line.includes(first) ? [index + 1] : [])));
    if (hit !== undefined) return { start: hit, end: hit + quoteLines.length - 1 };
  }
  if (finding.symbol !== undefined && finding.symbol !== "") {
    const escaped = finding.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
    const hit = near(lines.flatMap((line, index) => (pattern.test(line) ? [index + 1] : [])));
    if (hit !== undefined) return { start: hit, end: hit };
  }
  return finding.line === null ? undefined : { start: finding.line, end: finding.line };
}

/**
 * Split prevHead..head into FIX hunks (overlapping a still-open prior finding relocated at head, or in a commit whose
 * message names a prior finding id, overlapping that commit's own change) and NEW hunks (everything else).
 *
 * `context` findings (PR comments from others, M2) never make a hunk FIX: they are attached to a hunk that is already FIX
 * when they sit on it, so its reviewers check whether the comment was resolved, and are otherwise carried.
 */
export async function splitDelta(
  git: GitRunner,
  base: string,
  head: string,
  prior: readonly PriorFinding[],
  context: readonly PriorFinding[] = [],
): Promise<{ fixHunks: FixHunk[]; newHunks: RoundHunk[] }> {
  const diff = await git(["diff", "-U0", "--no-color", "--no-ext-diff", "--end-of-options", base, head, "--", ...NOT_REVIEW_PACKAGES]);
  if (diff.exitCode !== 0) return { fixHunks: [], newHunks: [] };
  const hunks = parseDiffHunks(diff.stdout);
  const ids = new Map<RoundHunk, Set<string>>();
  const mark = (hunk: RoundHunk, id: string): void => void (ids.get(hunk) ?? ids.set(hunk, new Set()).get(hunk)!).add(id);

  const located = (list: readonly PriorFinding[]): PriorFinding[] => list.filter((finding) => finding.file !== null && isOpenStatus(finding.status));
  const open = located(prior);
  const openContext = located(context);
  const files = [...new Set([...open, ...openContext].map((finding) => finding.file!))].filter((file) => hunks.some((hunk) => hunk.file === file));
  const contents = await catFiles(git, files.map((file) => `${head}:${file}`));
  const sitsOn = (finding: PriorFinding, hunk: RoundHunk): boolean => {
    if (hunk.file !== finding.file) return false;
    const location = relocateFinding(finding, contents.get(`${head}:${finding.file}`));
    return location === undefined ? !contents.has(`${head}:${finding.file}`) : overlaps(hunk, location.start, location.end);
  };
  for (const finding of open) for (const hunk of hunks) if (sitsOn(finding, hunk)) mark(hunk, finding.id);

  const log = await git(["log", "--format=%x01%H%x02%B", "--end-of-options", `${base}..${head}`]);
  if (log.exitCode === 0) {
    for (const chunk of log.stdout.split("\x01")) {
      const [commit, message = ""] = chunk.split("\x02");
      if (commit === undefined || !/^[0-9a-f]{40,64}$/.test(commit.trim())) continue;
      const named = prior.filter((finding) => !finding.id.startsWith("#") && mentionsFindingId(message, finding.id));
      if (named.length === 0) continue;
      const own = await git(["show", "-U0", "--no-color", "--no-ext-diff", "--format=", "--end-of-options", commit.trim()]);
      if (own.exitCode !== 0) continue;
      for (const change of parseDiffHunks(own.stdout)) {
        for (const hunk of hunks) {
          if (hunk.file === change.file && overlaps(hunk, change.startLine, change.endLine)) for (const finding of named) mark(hunk, finding.id);
        }
      }
    }
  }

  // Context only: onto hunks that are FIX already.
  for (const finding of openContext) for (const hunk of hunks) if (ids.has(hunk) && sitsOn(finding, hunk)) mark(hunk, finding.id);

  const fixHunks: FixHunk[] = [];
  const newHunks: RoundHunk[] = [];
  for (const hunk of hunks) {
    const named = ids.get(hunk);
    if (named === undefined) newHunks.push(hunk);
    else fixHunks.push({ ...hunk, findingIds: [...named].sort() });
  }
  return { fixHunks, newHunks };
}

/**
 * Why the previous round counts as weak (empty: it does not): it did not complete, its own record shows uncovered slices,
 * skipped required reviewers or "Not run" lines, or it reviewed a scope narrower than the current merge-base..head (its
 * recorded merge-base is not the current one and not an ancestor of it).
 */
export async function weakReasons(git: GitRunner, previous: RoundCandidate, base: { ref: string; sha: string }): Promise<string[]> {
  const reasons: string[] = [];
  if (previous.completed !== undefined && !previous.completed.ok) reasons.push(`not completed (${previous.completed.why})`);
  reasons.push(...(previous.weak ?? ["no package record of the round's coverage (only a published block or flow record was found)"]));
  const was = previous.prevMergeBase;
  if (was === null) reasons.push("it recorded no merge-base, so the scope it reviewed is unknown");
  if (typeof was === "string" && was.toLowerCase() !== base.sha.toLowerCase() && !(await isAncestor(git, was, base.sha))) {
    reasons.push(`it reviewed a scope narrower than the current merge-base..head (its merge-base ${was.slice(0, 12)} is not ${base.sha.slice(0, 12)} or older)`);
  }
  return reasons;
}

async function allHunks(git: GitRunner, base: string | null, head: string): Promise<RoundHunk[]> {
  if (base === null) return [];
  const diff = await git(["diff", "-U0", "--no-color", "--no-ext-diff", "--end-of-options", base, head, "--", ...NOT_REVIEW_PACKAGES]);
  return diff.exitCode === 0 ? parseDiffHunks(diff.stdout) : [];
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const SOURCE_RANK: Record<RoundCandidate["source"], number> = { "local-package": 0, "git-history": 1, "github-block": 2, flow: 3 };

/**
 * The previous round among the candidates, and how this round relates to it. Exported for the disagreement tests.
 *
 * Ancestors of `head` compete on distance (fewest commits to head wins; ties go to the earlier source, which has the
 * richer record). A non-ancestor wins instead when it is newer than the best ancestor — a force-push after that round.
 */
export async function choosePrevious(git: GitRunner, candidates: readonly RoundCandidate[], head: string | null): Promise<{ previous: RoundCandidate | undefined; mode: RoundMode; detail: string }> {
  const headed = candidates.filter((candidate) => candidate.reviewedHead !== null);
  if (headed.length === 0) return { previous: undefined, mode: "first", detail: "no previous round has a reviewed head" };
  const newest = [...headed].sort((a, b) => b.at - a.at || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0]!;
  if (head === null) return { previous: newest, mode: "fallback-first", detail: "this round has no head, so ancestry cannot be read" };
  const ancestors: Array<{ candidate: RoundCandidate; distance: number }> = [];
  const others: RoundCandidate[] = [];
  for (const candidate of headed) {
    if (await isAncestor(git, candidate.reviewedHead!, head)) ancestors.push({ candidate, distance: await distance(git, candidate.reviewedHead!, head) });
    else others.push(candidate);
  }
  ancestors.sort((a, b) => a.distance - b.distance || b.candidate.at - a.candidate.at || SOURCE_RANK[a.candidate.source] - SOURCE_RANK[b.candidate.source]);
  const best = ancestors[0]?.candidate;
  const newerNonAncestor = others.filter((candidate) => best === undefined || candidate.at > best.at).sort((a, b) => b.at - a.at)[0];
  if (newerNonAncestor !== undefined) {
    return { previous: newerNonAncestor, mode: "fallback-first", detail: `${newerNonAncestor.reviewedHead!.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)} (force-push or rebase, or a commit this clone has not fetched)` };
  }
  return { previous: best, mode: "delta", detail: `${best!.reviewedHead!.slice(0, 12)} is an ancestor of ${head.slice(0, 12)}` };
}

function resolveForced(forced: string, cwd: string): RoundCandidate | undefined {
  const asPath = path.resolve(cwd, forced);
  const dirs = existsSync(path.join(asPath, "manifest.json")) ? [asPath] : packageDirs(cwd).filter((dir) => (text(object(readJsonFile(path.join(dir, "manifest.json")))?.reviewId) ?? path.basename(dir)) === forced);
  const disk = dirs[0] === undefined ? undefined : diskCandidate(dirs[0], cwd, "local-package");
  return disk === undefined ? undefined : { ...strip(disk), match: "same" };
}

/**
 * A branch-line candidate (a branch target recorded under another spelling) is this target only when its reviewed head
 * is an ancestor of the current head and both have the same merge-base with the base — and, when it recorded a base,
 * that base is ours.
 */
async function onBranchLine(git: GitRunner, candidate: RoundCandidate, head: string | null, base: { ref: string; sha: string } | null): Promise<boolean> {
  if (candidate.match !== "branch-line") return true;
  if (head === null || base === null || candidate.reviewedHead === null) return false;
  if (candidate.recordedBase !== undefined && candidate.recordedBase !== base.ref) return false;
  if (!(await isAncestor(git, candidate.reviewedHead, head))) return false;
  return (await mergeBaseOf(git, base.ref, candidate.reviewedHead)) === base.sha;
}

/** Find the previous round of `target` and build this round's record. Never throws for a source that fails. */
export async function findPreviousRound(target: PriorRoundTarget, head: string | null, deps: PriorRoundDeps): Promise<PriorRoundResult> {
  const git = deps.git ?? defaultGitRunner(deps.cwd);
  const tried: SourceAttempt[] = [];
  const candidates: RoundCandidate[] = [];
  let commentFindings: PriorFinding[] = [];
  const exclude = (list: RoundCandidate[]): RoundCandidate[] => list.filter((candidate) => candidate.reviewId !== deps.excludeReviewId);
  const base = head === null ? null : await resolveBase(git, target, head);
  const targetKey = targetKeyOf(target, base?.ref);
  const limit = deps.historyLimit ?? 200;

  if (deps.forced !== undefined) {
    const found = resolveForced(deps.forced, deps.cwd) ?? (await gitHistoryCandidates(git, undefined, limit, deps.forced, { baseRef: base?.ref }))[0];
    if (found === undefined) throw new Error(`--prior ${deps.forced}: no review package with that path or review id, in this checkout or in git history.`);
    candidates.push(found);
    for (const source of SEARCH_ORDER) {
      tried.push(source === found.source ? { source, result: "found", detail: `forced by --prior ${deps.forced}` } : { source, result: "not-consulted", detail: "--prior given" });
    }
  } else {
    /** Check `list` against the branch line and record the attempt; `note` is appended to its detail. */
    const record = async (source: SearchedSource, list: RoundCandidate[], none: string, note = ""): Promise<RoundCandidate[]> => {
      const found: RoundCandidate[] = [];
      const off: string[] = [];
      for (const candidate of list) {
        if (await onBranchLine(git, candidate, head, base)) found.push(candidate);
        else off.push(candidate.reviewId);
      }
      candidates.push(...found);
      const offLine = off.length === 0 ? "" : `; ${off.length} branch package(s) not on this branch line: ${off.join(", ")}`;
      tried.push({ source, result: found.length > 0 ? "found" : "none", detail: `${found.length > 0 ? `${found.length} round(s): ${found.map((c) => c.reviewId).join(", ")}` : none}${offLine}${note}` });
      return found;
    };
    const local = await record("local-package", exclude(localPackageCandidates(deps.cwd, target, targetKey)), "no package for this target in this checkout");
    const known = new Set(local.map((candidate) => candidate.reviewId));
    const historyFound = exclude(await gitHistoryCandidates(git, target, limit, undefined, { baseRef: base?.ref, targetKey })).filter((candidate) => !known.has(candidate.reviewId));
    const history = await record("git-history", historyFound, `no committed package for this target in the last ${limit} package commits of the local branches${base === null ? "" : ` and ${base.ref}`} (${HISTORY_DAYS} days)`);
    for (const candidate of history) known.add(candidate.reviewId);

    const lookup = await (deps.github ?? defaultGithubLookup)(target).catch((error: unknown): GithubLookup => ({ status: "not-consulted", detail: error instanceof Error ? error.message : String(error) }));
    if (lookup.status === "not-consulted") {
      tried.push({ source: "github-block", result: "not-consulted", detail: lookup.detail });
      tried.push({ source: "github-comments", result: "not-consulted", detail: lookup.detail });
    } else {
      await record("github-block", exclude(githubBlockCandidates(lookup.blocks)), "no keryx round block in our own comments");
      commentFindings = githubCommentFindings(lookup.comments);
      tried.push({ source: "github-comments", result: commentFindings.length > 0 ? "found" : "none", detail: commentFindings.length > 0 ? `${commentFindings.length} comment(s) from others` : "no comments from others" });
    }

    if (deps.flowDir === undefined) {
      tried.push({ source: "flow", result: "not-consulted", detail: "the package is not bound to a flow" });
    } else {
      // Review LG4-002: a read that fails is reported, not read as "no round", and a package that is not ingested is
      // named beside the result, so one unreadable package never silently hides the flow's rounds.
      const read = await (deps.flowRounds ?? readReviewRounds)(deps.cwd, deps.flowDir).then(
        (rounds) => ({ rounds }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      if ("error" in read) {
        tried.push({ source: "flow", result: "not-consulted", detail: `the rounds of flow ${deps.flowDir} could not be read (${read.error})` });
      } else {
        // The package being started (excludeReviewId) is not an earlier round, so it is never named as skipped (review LG5-001).
        const skipped = read.rounds.filter((round) => !round.ingested && round.reviewId !== deps.excludeReviewId);
        const note = skipped.length === 0 ? "" : `; skipped, not ingested: ${skipped.map((round) => `${round.reviewId} (${round.problems.join("; ")})`).join(", ")}`;
        await record("flow", exclude(flowCandidates(read.rounds, deps.cwd)).filter((candidate) => !known.has(candidate.reviewId)), `no reviewed round in flow ${deps.flowDir}`, note);
      }
    }
  }

  // Trust: a package is cut from only when the pipeline finished it and this branch did not write it — or, when the
  // branch did commit it, the machine-local registry holds keryx's own record of exactly these files.
  const registryRead: { entries: readonly RoundRegistryEntry[]; warning?: string | undefined } = deps.registry === undefined ? readRoundRegistryReport(repoIdentity(deps.cwd)) : { entries: deps.registry };
  const registry = registryRead.entries;
  if (registryRead.warning !== undefined) {
    const local = tried.find((attempt) => attempt.source === "local-package");
    if (local !== undefined) local.detail = `${local.detail}; ${registryRead.warning}`;
  }
  for (const candidate of candidates) {
    if (candidate.trust === undefined) candidate.trust = await packageTrust(git, candidate, head, base, registry);
    if (candidate.trust.ok && candidate.trust.why.startsWith("trusted: local registry")) {
      const at = tried.find((attempt) => attempt.source === candidate.source);
      if (at !== undefined) at.detail = `${at.detail}; ${candidate.reviewId} ${candidate.trust.why}`;
    }
    if (candidate.trust.ok) continue;
    const at = tried.find((attempt) => attempt.source === candidate.source);
    if (at !== undefined) at.detail = `${at.detail}; not trusted ${candidate.reviewId}: ${candidate.trust.why}`;
  }
  const trusted = candidates.filter((candidate) => candidate.trust?.ok === true);
  const untrusted = candidates.filter((candidate) => candidate.trust?.ok !== true && candidate.reviewedHead !== null);
  let choice = await choosePrevious(git, trusted, head);
  if (choice.previous === undefined && untrusted.length > 0) {
    const newest = [...untrusted].sort((a, b) => b.at - a.at || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0]!;
    choice = { previous: newest, mode: "fallback-first", detail: `no trusted previous round; ${newest.reviewId} is not trusted (${newest.trust?.why ?? "unchecked"}), so this is a full review with its findings as context only` };
  }
  const previous = choice.previous;
  const priorFindings = [...(previous?.findings ?? []), ...commentFindings];
  const source: RoundSource = previous?.source ?? (commentFindings.length > 0 ? "github-comments" : "none");
  const round = previous === undefined ? 1 : previous.round + 1;

  let range: RoundRecord["range"] = { base: null, head };
  let fixHunks: FixHunk[] = [];
  let newHunks: RoundHunk[] = [];
  let carried: RoundRecord["carried"] = [];
  let secondLookHunks: RoundHunk[] = [];
  let weakPrevious: string | undefined;
  const warnings: string[] = [];
  if (head !== null && previous !== undefined && choice.mode === "delta") {
    range = { base: previous.reviewedHead, head };
    ({ fixHunks, newHunks } = await splitDelta(git, previous.reviewedHead!, head, previous.findings, commentFindings));
    const attached = new Set(fixHunks.flatMap((hunk) => hunk.findingIds));
    carried = [...previous.findings, ...commentFindings].filter((finding) => !attached.has(finding.id)).map((finding) => ({ findingId: finding.id, disposition: finding.status }));
    // Cheap second look: code of merge-base..head that did not change since the previous round was read once, by that
    // round, which may have missed something (a delta round only reads what changed). It gets one more pass by logic and
    // security-code — or, when that round was itself weak, the full round-1 treatment.
    if (base !== null && emptyRangeWarning(base, head) === undefined) {
      const unchanged = subtractHunks(await allHunks(git, base.sha, head), [...fixHunks, ...newHunks]);
      if (unchanged.length > 0) {
        const reasons = await weakReasons(git, previous, base);
        if (reasons.length === 0) secondLookHunks = unchanged;
        else {
          weakPrevious = reasons.join("; ");
          newHunks = [...newHunks, ...unchanged];
        }
      }
    }
  } else if (head !== null) {
    range = { base: base?.sha ?? null, head };
    newHunks = await allHunks(git, range.base, head);
  }
  const empty = emptyRangeWarning(base, head);
  if (empty !== undefined) warnings.push(empty);
  if (previous !== undefined) {
    const at = tried.find((attempt) => attempt.source === previous.source);
    if (at !== undefined) at.detail = `${at.detail}; chosen ${previous.reviewId} (${choice.detail})`;
  }

  return {
    round: {
      v: 1,
      round,
      source,
      sourcesTried: tried,
      previous: previous === undefined ? null : { reviewId: previous.reviewId, reviewedHead: previous.reviewedHead, ...(previous.packagePath === undefined ? {} : { packagePath: previous.packagePath }) },
      mode: previous === undefined ? "first" : choice.mode,
      range,
      fixHunks,
      newHunks,
      carried,
      mergeBase: base?.sha ?? null,
      ...(previous === undefined ? {} : { modeReason: weakPrevious === undefined ? choice.detail : `${choice.detail}; previous round weak: ${weakPrevious}` }),
      ...(secondLookHunks.length === 0 ? {} : { secondLookHunks }),
      ...(weakPrevious === undefined ? {} : { weakPrevious: `previous round weak: ${weakPrevious}` }),
      ...(warnings.length === 0 ? {} : { warnings }),
    },
    priorFindings,
    identity: { targetKey, ...(base === null ? {} : { targetBase: base.ref }) },
  };
}

/** The record `--no-prior-round` writes: round 1, and every source marked as deliberately not consulted. */
export function skippedRound(head: string | null, target?: { kind: string; ref: string }): PriorRoundResult {
  return {
    round: {
      v: 1,
      round: 1,
      source: "none",
      sourcesTried: SEARCH_ORDER.map((source) => ({ source, result: "not-consulted" as const, detail: "--no-prior-round" })),
      previous: null,
      mode: "first",
      range: { base: null, head },
      fixHunks: [],
      newHunks: [],
      carried: [],
    },
    priorFindings: [],
    identity: { targetKey: target === undefined ? "unknown" : targetKeyOf(target) },
  };
}
