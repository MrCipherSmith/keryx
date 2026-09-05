// Task extraction for the context-retrieval measurement
// (docs/requirements/keryx-context-measurement/pre-registration.md).
//
// A task is one merged pull request: the QUERY is what the PR said it was doing,
// the GOLD SET is the source files it changed, and the tree the agent sees is the
// PARENT commit — the repository as it stood before the change landed.
//
// The parent matters more than anything else here. Run at HEAD and the agent can
// simply read the change it is being asked to locate; both arms score 100% and
// the measurement says nothing.
//
// Filters are in the pre-registration and are not tuned here. The one worth
// naming twice is the answer-leak filter: these repositories write good PR
// descriptions, and a good description names the files it touched. Measured on
// vantage-frontend, 172 of 713 candidates — nearly a quarter — would have handed
// the agent its own answer. That filter is the difference between measuring
// retrieval and measuring reading.

import { execFileSync } from "node:child_process";
import { isTestFile, SOURCE_FILE } from "./retrieval-languages";

export interface RetrievalTask {
  /** Stable id: the short sha of the merge commit. */
  readonly id: string;
  /** The commit the PR landed as. Never checked out — it contains the answer. */
  readonly sha: string;
  /** The tree the agent sees: the state before this PR. */
  readonly parent: string;
  /** Subject plus first body paragraph — what a reader knew before the fix. */
  readonly query: string;
  /** Source files the PR changed, in repository-relative form. */
  readonly gold: readonly string[];
}

export interface ExtractOptions {
  readonly repoRoot: string;
  readonly ref?: string;
  readonly limit?: number;
  /** Exclude commits at or after this date, to keep recent authorship out. */
  readonly before?: string;
  readonly minGold?: number;
  readonly maxGold?: number;
}

export interface ExtractResult {
  readonly tasks: readonly RetrievalTask[];
  /** Every candidate that was dropped, and why — a silent filter is a lie. */
  readonly dropped: {
    readonly notPullRequest: number;
    readonly choreOrDocs: number;
    readonly goldSetSize: number;
    readonly answerLeak: number;
    readonly noParent: number;
  };
}


// `%s` and `%b` cannot be joined by a NUL through execFile's argv, so a literal
// sentinel separates them. It has to be something no commit message contains.
const SEPARATOR = "@@KERYX-TASK-SEP@@";

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Words from the gold paths that must not appear in the query.
 *
 * Both the file's basename without extension and every path segment, because a
 * description naming the DIRECTORY is nearly as much of a giveaway as one naming
 * the file. Segments of three characters or fewer are ignored: `src` and `ui`
 * appear in ordinary prose and would reject almost everything.
 */
export function answerStems(gold: readonly string[]): Set<string> {
  const stems = new Set<string>();
  for (const file of gold) {
    const segments = file.toLowerCase().split("/");
    const base = (segments[segments.length - 1] ?? "").replace(/\.[^.]+$/, "");
    for (const candidate of [base, ...segments]) {
      if (candidate.length > 3) stems.add(candidate);
    }
  }
  return stems;
}

/**
 * Whether the query gives the answer away.
 *
 * Matched on WHOLE WORDS, not substrings. Substring matching rejected
 * "refunds are charged twice on retry" as naming `src/billing/charge.ts`,
 * because `charge` occurs inside `charged` — a coincidence of English
 * morphology, not a reference to a file.
 *
 * That over-rejection is not merely wasteful. It would bias the surviving
 * sample toward pull requests whose prose happens to use different vocabulary
 * from their own filenames, which is a strange population to measure retrieval
 * on: descriptions that share no words with the code they touch are exactly the
 * hardest cases, and keeping only those would understate every arm equally but
 * unpredictably.
 *
 * A word-boundary match still catches the real giveaways — `scheduler` in "the
 * scheduler retries too eagerly", `charge.ts` written out, a directory named in
 * passing — because those appear as whole words.
 */
export function leaksAnswer(query: string, gold: readonly string[]): boolean {
  const words = new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  for (const stem of answerStems(gold)) {
    if (words.has(stem)) return true;
  }
  return false;
}

export function extractRetrievalTasks(options: ExtractOptions): ExtractResult {
  const { repoRoot, ref = "HEAD", limit = 800, before, minGold = 1, maxGold = 8 } = options;

  const logArgs = ["log", "--first-parent", "--format=%H", "-n", String(limit)];
  if (before !== undefined) logArgs.push(`--before=${before}`);
  logArgs.push(ref);

  const shas = git(repoRoot, logArgs).trim().split("\n").filter(Boolean);

  const tasks: RetrievalTask[] = [];
  const dropped = { notPullRequest: 0, choreOrDocs: 0, goldSetSize: 0, answerLeak: 0, noParent: 0 };

  for (const sha of shas) {
    const raw = git(repoRoot, ["log", "-1", `--format=%s${SEPARATOR}%b`, sha]);
    const [subjectRaw = "", body = ""] = raw.split(SEPARATOR);
    const subject = subjectRaw.trim();

    if (!/\(#\d+\)\s*$/.test(subject)) {
      dropped.notPullRequest += 1;
      continue;
    }
    if (/^(chore|docs)(\(|:)/i.test(subject)) {
      dropped.choreOrDocs += 1;
      continue;
    }

    let parent: string;
    try {
      parent = git(repoRoot, ["rev-parse", `${sha}^`]).trim();
    } catch {
      // The first commit in a repository has no parent, so there is no "before"
      // state to check out. Counted rather than skipped silently.
      dropped.noParent += 1;
      continue;
    }

    const changed = git(repoRoot, ["show", "--name-only", "--format=", sha])
      .trim()
      .split("\n")
      .filter(Boolean);
    const gold = changed.filter((file) => SOURCE_FILE.test(file) && !isTestFile(file));

    if (gold.length < minGold || gold.length > maxGold) {
      dropped.goldSetSize += 1;
      continue;
    }

    const firstParagraph = body.split(/\n\s*\n/)[0] ?? "";
    const query = `${subject}\n\n${firstParagraph}`.trim();

    if (leaksAnswer(query, gold)) {
      dropped.answerLeak += 1;
      continue;
    }

    tasks.push({ id: sha.slice(0, 8), sha, parent, query, gold });
  }

  return { tasks, dropped };
}
