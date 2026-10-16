/**
 * Flow 458 AC1/AC3: which round this is, and against what.
 *
 * `review start|attach` asks every place a previous round of the same target can be recorded, in a fixed order:
 *
 * 1. local-package — `.metaproject/reviews/*` and `.metaproject/flows/*\/reviews/*` in this checkout;
 * 2. git-history — the same package files as any branch of this clone has ever committed them (another machine's
 *    round, pushed and fetched, is found here without its checkout);
 * 3. github-block — the hidden `<!-- keryx:round … -->` block `review publish` appends, read from our own comments;
 * 4. github-comments — everybody else's comments on the pull request: prior findings, with no reviewed head;
 * 5. flow — the review rounds of the flow the package is bound to (they may name a different target ref).
 *
 * Each source is injectable. The previous round is the NEWEST reviewed head that is an ancestor of the current head
 * (fewest commits between it and the head); when a round newer than that was reviewed at a head that is NOT an
 * ancestor — a force-push or rebase — the round falls back to a full review over merge-base..head with the prior
 * findings attached (`fallback-first`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readReviewRounds, type ReviewRoundRecord } from "../flow/review-gate";
import { collectPrComments, createGhPort, type CollectedComment, type CollectedRoundBlock } from "./pr-comments";
import { mentionsFindingId } from "./publish";
import {
  findingStatus,
  isOpenStatus,
  quoteSha256,
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

export type GitResult = { stdout: string; exitCode: number };
/** Runs `git <args>` in `cwd`, with `input` on stdin when given. Never throws: a failure is a non-zero exit. */
export type GitRunner = (args: string[], options?: { input?: string }) => Promise<GitResult>;

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
  /** `--prior <package|reviewId>`: use this round, wherever it is found, instead of searching. */
  forced?: string | undefined;
};

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
};

export type PriorRoundResult = { round: RoundRecord; priorFindings: PriorFinding[] };

const PACKAGE_GLOBS = [".metaproject/reviews/*/manifest.json", ".metaproject/flows/*/reviews/*/manifest.json"];

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** A recorded head, only when it is a commit id: anything else (or a dash-leading value) is no head at all. */
function commitId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
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

/** `owner/repo` and number of a pull request ref, or undefined when the ref names none. */
export function pullRequestOf(ref: string): { repo: string; number: number } | undefined {
  const match = PR_URL.exec(ref.trim()) ?? PR_SHORT.exec(ref.trim());
  return match === null ? undefined : { repo: match[1]!.toLowerCase(), number: Number(match[2]) };
}

/** Whether a recorded target is this target: the same ref, or the same pull request however it was written. */
export function sameReviewTarget(recorded: unknown, target: PriorRoundTarget): boolean {
  const raw = object(recorded);
  const ref = text(raw?.ref);
  if (ref === undefined) return false;
  if (ref.trim() === target.ref.trim()) return true;
  const mine = pullRequestOf(target.ref);
  const theirs = pullRequestOf(ref);
  return mine !== undefined && theirs !== undefined && mine.repo === theirs.repo && mine.number === theirs.number;
}

/** A round worth calling "previous": it has a head, and it is not an abandoned draft that recorded nothing. */
function reviewed(manifest: Record<string, unknown>, findings: unknown): boolean {
  if (commitId(object(manifest.target)?.head) === null) return false;
  return manifest.status !== "draft" || (Array.isArray(findings) && findings.length > 0);
}

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

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export function defaultGitRunner(cwd: string): GitRunner {
  return async (args, options = {}) => {
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
        stdout: "pipe",
        stderr: "ignore",
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { stdout, exitCode };
    } catch {
      return { stdout: "", exitCode: 127 };
    }
  };
}

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

async function mergeBase(git: GitRunner, target: PriorRoundTarget, head: string): Promise<string | null> {
  for (const ref of [target.base, "origin/main", "main", "origin/master", "master"]) {
    if (ref === undefined || ref === "" || ref.startsWith("-")) continue;
    const result = await git(["merge-base", "--end-of-options", ref, head]);
    const sha = result.stdout.trim();
    if (result.exitCode === 0 && /^[0-9a-f]{7,64}$/i.test(sha)) return sha;
  }
  return null;
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
  add(path.join(cwd, ".metaproject", "reviews"));
  const flows = path.join(cwd, ".metaproject", "flows");
  if (existsSync(flows)) {
    for (const entry of readdirSync(flows, { withFileTypes: true })) if (entry.isDirectory()) add(path.join(flows, entry.name, "reviews"));
  }
  return dirs;
}

function localCandidate(dir: string, cwd: string): RoundCandidate | undefined {
  const manifest = object(readJsonFile(path.join(dir, "manifest.json")));
  if (manifest === undefined) return undefined;
  const findings = readJsonFile(path.join(dir, "findings.json"));
  return {
    source: "local-package",
    reviewId: text(manifest.reviewId) ?? path.basename(dir),
    reviewedHead: commitId(object(manifest.target)?.head),
    round: roundNumberOf(readJsonFile(path.join(dir, "round.json"))) ?? 1,
    at: stamp(manifest),
    packagePath: path.relative(cwd, dir),
    findings: priorFindingsOf(findings, "local-package"),
  };
}

/** Source 1: packages in this checkout for the same target. */
export function localPackageCandidates(cwd: string, target: PriorRoundTarget): RoundCandidate[] {
  const found: RoundCandidate[] = [];
  for (const dir of packageDirs(cwd)) {
    const manifest = object(readJsonFile(path.join(dir, "manifest.json")));
    if (manifest === undefined || !sameReviewTarget(manifest.target, target)) continue;
    if (!reviewed(manifest, readJsonFile(path.join(dir, "findings.json")))) continue;
    const candidate = localCandidate(dir, cwd);
    if (candidate !== undefined) found.push(candidate);
  }
  return found;
}

type HistoryEntry = { commit: string; at: number; manifestPath: string };

async function historyEntries(git: GitRunner, limit: number): Promise<HistoryEntry[]> {
  const log = await git(["log", "--all", `-n${limit}`, "--format=%x01%H %ct", "--name-only", "--end-of-options", "--", ...PACKAGE_GLOBS]);
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

/** Source 2: package files as any branch of this clone committed them. Bounded to `limit` commits; one git read. */
export async function gitHistoryCandidates(git: GitRunner, target: PriorRoundTarget | undefined, limit = 200, reviewId?: string): Promise<RoundCandidate[]> {
  const entries = await historyEntries(git, limit);
  const manifests = await catFiles(git, entries.map((entry) => `${entry.commit}:${entry.manifestPath}`));
  const matching: Array<{ entry: HistoryEntry; manifest: Record<string, unknown> }> = [];
  for (const entry of entries) {
    const manifest = object(parseJson(manifests.get(`${entry.commit}:${entry.manifestPath}`)));
    if (manifest === undefined) continue;
    const id = text(manifest.reviewId) ?? path.basename(path.dirname(entry.manifestPath));
    if (reviewId !== undefined ? id !== reviewId : target === undefined || !sameReviewTarget(manifest.target, target)) continue;
    matching.push({ entry, manifest });
  }
  const extras = await catFiles(git, matching.flatMap(({ entry }) => {
    const dir = path.posix.dirname(entry.manifestPath);
    return [`${entry.commit}:${dir}/findings.json`, `${entry.commit}:${dir}/round.json`];
  }));
  const found: RoundCandidate[] = [];
  for (const { entry, manifest } of matching) {
    const dir = path.posix.dirname(entry.manifestPath);
    const findings = parseJson(extras.get(`${entry.commit}:${dir}/findings.json`));
    if (reviewId === undefined && !reviewed(manifest, findings)) continue;
    found.push({
      source: "git-history",
      reviewId: text(manifest.reviewId) ?? path.basename(dir),
      reviewedHead: commitId(object(manifest.target)?.head),
      round: roundNumberOf(parseJson(extras.get(`${entry.commit}:${dir}/round.json`))) ?? 1,
      at: stamp(manifest) || entry.at,
      packagePath: `${dir} (at ${entry.commit.slice(0, 12)})`,
      findings: priorFindingsOf(findings, "git-history"),
    });
  }
  return found;
}

/** Source 3: the round blocks of our own published reviews. */
export function githubBlockCandidates(blocks: readonly CollectedRoundBlock[]): RoundCandidate[] {
  return blocks
    .filter((block) => block.reviewedHead !== null)
    .map((block) => ({
      source: "github-block" as const,
      reviewId: block.reviewId,
      reviewedHead: block.reviewedHead,
      round: block.round,
      at: Number.isNaN(Date.parse(block.submittedAt)) ? 0 : Date.parse(block.submittedAt),
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

/** Source 5: the rounds of the flow this package is bound to. */
export function flowCandidates(rounds: readonly ReviewRoundRecord[], cwd: string): RoundCandidate[] {
  return rounds.flatMap((round, index) => {
    if (commitId(round.head) === null || !round.ingested) return [];
    const at = Date.parse(round.sortKey);
    return [{
      source: "flow" as const,
      reviewId: round.reviewId,
      reviewedHead: commitId(round.head),
      round: roundNumberOf(readJsonFile(path.join(cwd, round.dir, "round.json"))) ?? index + 1,
      at: Number.isNaN(at) ? 0 : at,
      packagePath: round.dir,
      findings: priorFindingsOf(round.findings, "flow"),
    }];
  });
}

/** The default pull request read: `gh`, never throwing; anything short of a full read is "not consulted". */
export async function defaultGithubLookup(target: PriorRoundTarget): Promise<GithubLookup> {
  const pr = pullRequestOf(target.ref);
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
  try {
    const result = await collectPrComments({ port: createGhPort(spawn), repo: pr.repo, number: pr.number, self });
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

/** The round's code: everything but committed review packages, which record a review rather than being reviewed. */
const NOT_REVIEW_PACKAGES = [".", ":(exclude).metaproject/reviews", ":(exclude,glob).metaproject/flows/*/reviews/**"];

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
 */
export async function splitDelta(git: GitRunner, base: string, head: string, prior: readonly PriorFinding[]): Promise<{ fixHunks: FixHunk[]; newHunks: RoundHunk[] }> {
  const diff = await git(["diff", "-U0", "--no-color", "--no-ext-diff", "--end-of-options", base, head, "--", ...NOT_REVIEW_PACKAGES]);
  if (diff.exitCode !== 0) return { fixHunks: [], newHunks: [] };
  const hunks = parseDiffHunks(diff.stdout);
  const ids = new Map<RoundHunk, Set<string>>();
  const mark = (hunk: RoundHunk, id: string): void => void (ids.get(hunk) ?? ids.set(hunk, new Set()).get(hunk)!).add(id);

  const open = prior.filter((finding) => finding.file !== null && isOpenStatus(finding.status));
  const files = [...new Set(open.map((finding) => finding.file!))].filter((file) => hunks.some((hunk) => hunk.file === file));
  const contents = await catFiles(git, files.map((file) => `${head}:${file}`));
  for (const finding of open) {
    const location = relocateFinding(finding, contents.get(`${head}:${finding.file}`));
    for (const hunk of hunks) {
      if (hunk.file !== finding.file) continue;
      if (location === undefined ? !contents.has(`${head}:${finding.file}`) : overlaps(hunk, location.start, location.end)) mark(hunk, finding.id);
    }
  }

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

  const fixHunks: FixHunk[] = [];
  const newHunks: RoundHunk[] = [];
  for (const hunk of hunks) {
    const named = ids.get(hunk);
    if (named === undefined) newHunks.push(hunk);
    else fixHunks.push({ ...hunk, findingIds: [...named].sort() });
  }
  return { fixHunks, newHunks };
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
  if (existsSync(path.join(asPath, "manifest.json"))) return localCandidate(asPath, cwd);
  for (const dir of packageDirs(cwd)) {
    const manifest = object(readJsonFile(path.join(dir, "manifest.json")));
    if ((text(manifest?.reviewId) ?? path.basename(dir)) === forced) return localCandidate(dir, cwd);
  }
  return undefined;
}

/** Find the previous round of `target` and build this round's record. Never throws for a source that fails. */
export async function findPreviousRound(target: PriorRoundTarget, head: string | null, deps: PriorRoundDeps): Promise<PriorRoundResult> {
  const git = deps.git ?? defaultGitRunner(deps.cwd);
  const tried: SourceAttempt[] = [];
  const candidates: RoundCandidate[] = [];
  let commentFindings: PriorFinding[] = [];
  const exclude = (list: RoundCandidate[]): RoundCandidate[] => list.filter((candidate) => candidate.reviewId !== deps.excludeReviewId);

  if (deps.forced !== undefined) {
    const found = resolveForced(deps.forced, deps.cwd) ?? (await gitHistoryCandidates(git, undefined, deps.historyLimit ?? 200, deps.forced))[0];
    if (found === undefined) throw new Error(`--prior ${deps.forced}: no review package with that path or review id, in this checkout or in git history.`);
    candidates.push(found);
    for (const source of SEARCH_ORDER) {
      tried.push(source === found.source ? { source, result: "found", detail: `forced by --prior ${deps.forced}` } : { source, result: "not-consulted", detail: "--prior given" });
    }
  } else {
    const record = (source: SearchedSource, found: RoundCandidate[], none: string): void => {
      candidates.push(...found);
      tried.push({ source, result: found.length > 0 ? "found" : "none", detail: found.length > 0 ? `${found.length} round(s): ${found.map((c) => c.reviewId).join(", ")}` : none });
    };
    const local = exclude(localPackageCandidates(deps.cwd, target));
    record("local-package", local, "no package for this target in this checkout");
    const known = new Set(local.map((candidate) => candidate.reviewId));
    const history = exclude(await gitHistoryCandidates(git, target, deps.historyLimit ?? 200)).filter((candidate) => !known.has(candidate.reviewId));
    record("git-history", history, `no committed package for this target in the last ${deps.historyLimit ?? 200} package commits`);
    for (const candidate of history) known.add(candidate.reviewId);

    const lookup = await (deps.github ?? defaultGithubLookup)(target).catch((error: unknown): GithubLookup => ({ status: "not-consulted", detail: error instanceof Error ? error.message : String(error) }));
    if (lookup.status === "not-consulted") {
      tried.push({ source: "github-block", result: "not-consulted", detail: lookup.detail });
      tried.push({ source: "github-comments", result: "not-consulted", detail: lookup.detail });
    } else {
      record("github-block", exclude(githubBlockCandidates(lookup.blocks)), "no keryx round block in our own comments");
      commentFindings = githubCommentFindings(lookup.comments);
      tried.push({ source: "github-comments", result: commentFindings.length > 0 ? "found" : "none", detail: commentFindings.length > 0 ? `${commentFindings.length} comment(s) from others` : "no comments from others" });
    }

    if (deps.flowDir === undefined) {
      tried.push({ source: "flow", result: "not-consulted", detail: "the package is not bound to a flow" });
    } else {
      const rounds = await (deps.flowRounds ?? readReviewRounds)(deps.cwd, deps.flowDir).catch(() => [] as ReviewRoundRecord[]);
      record("flow", exclude(flowCandidates(rounds, deps.cwd)).filter((candidate) => !known.has(candidate.reviewId)), `no reviewed round in flow ${deps.flowDir}`);
    }
  }

  const choice = await choosePrevious(git, candidates, head);
  const previous = choice.previous;
  const priorFindings = [...(previous?.findings ?? []), ...commentFindings];
  const source: RoundSource = previous?.source ?? (commentFindings.length > 0 ? "github-comments" : "none");
  const round = previous === undefined ? 1 : previous.round + 1;

  let range: RoundRecord["range"] = { base: null, head };
  let fixHunks: FixHunk[] = [];
  let newHunks: RoundHunk[] = [];
  let carried: RoundRecord["carried"] = [];
  if (head !== null && previous !== undefined && choice.mode === "delta") {
    range = { base: previous.reviewedHead, head };
    ({ fixHunks, newHunks } = await splitDelta(git, previous.reviewedHead!, head, priorFindings));
    const attached = new Set(fixHunks.flatMap((hunk) => hunk.findingIds));
    carried = (previous.findings).filter((finding) => !attached.has(finding.id)).map((finding) => ({ findingId: finding.id, disposition: finding.status }));
  } else if (head !== null) {
    range = { base: await mergeBase(git, target, head), head };
    newHunks = await allHunks(git, range.base, head);
  }
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
    },
    priorFindings,
  };
}

/** The record `--no-prior-round` writes: round 1, and every source marked as deliberately not consulted. */
export function skippedRound(head: string | null): PriorRoundResult {
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
  };
}
