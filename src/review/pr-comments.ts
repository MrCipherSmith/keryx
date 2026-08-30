/**
 * External PR comments: collect every round, answer once at the end.
 *
 * ## What was there before
 *
 * Nothing. A human or a bot reviewed our pull request and no part of the
 * orchestrator read it, converted it, fixed it, or answered it. Silence was the
 * behaviour for every comment, and silence is indistinguishable from disagreement
 * to the person who wrote it.
 *
 * ## The three rules this module exists to make mechanical
 *
 * 1. **Collection is exhaustive and identity-blind.** Three GitHub endpoints
 *    carry reviewer comments and all three are read. A bot reviewer is a
 *    reviewer: CodeRabbit, Greptile and Copilot go through the same path as a
 *    human, and the `authorIsBot` flag is RECORDED so a report can say who spoke
 *    — it is never consulted by a filter. The only identity excluded is our own.
 *
 * 2. **Severity is classified, never invented.** A comment attached to a review
 *    whose state is `CHANGES_REQUESTED` starts at `major`; everything else starts
 *    at `minor`. There is no third rule and no model call. When the classifying
 *    fact is missing — an inline comment whose parent review we could not fetch —
 *    the comment is NOT dropped and the severity is NOT guessed: it takes the
 *    floor and carries `basis: "unclassified"` naming what was missing, so a
 *    reader can tell a derived `minor` from a defaulted one.
 *
 * 3. **Speaking happens once.** Comments are collected on every round; replies
 *    are posted after the FINAL round and before the completion gate.
 *    {@link postReplyPass} refuses a non-final round rather than trusting the
 *    caller to remember, because a bot that replies every round turns one thread
 *    into six and the reviewer reads the noise before the answer.
 *
 * ## Why nothing here can resolve a thread
 *
 * There is no code path to it. {@link guardGitHubRequest} holds an allow-list of
 * five endpoint shapes — three reads and two writes — and everything else,
 * including the GraphQL endpoint through which `resolveReviewThread` and
 * `minimizeComment` are reached, is refused by the port itself. AC12 is therefore
 * a property of the module's shape rather than a rule someone has to follow:
 * replying is ours, resolving is the reviewer's call, and auto-resolving is how a
 * bot silences a human.
 *
 * ## Why every GitHub call is a port
 *
 * The port is an argument, always. {@link createFixturePort} answers reads from
 * JSON on disk and records writes in memory, so the whole pipeline — collection,
 * classification, conversion, brevity, threading, idempotency across a restart —
 * is exercised offline with no network, no token and no pull request. The live
 * adapter ({@link createGhPort}) is the only thing the fixtures do not cover, and
 * it contains no logic: it shells to `gh api` and parses the result.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import type { VerificationMergeResult } from "./verification";
import {
  EXTERNAL_TERMINAL_DISPOSITIONS,
  type ExternalCommentRef,
  type FindingDispositionState,
  type ReviewFindingSeverity,
  type StructuredReviewFinding,
} from "./types";

// ---------------------------------------------------------------------------
// Defaults (in code, so a caller that says nothing still gets a bound)
// ---------------------------------------------------------------------------

/** `pr_comments.max_replies_total`. Beyond it: one summary comment and a reported backlog. */
export const DEFAULT_MAX_REPLIES_TOTAL = 30;

/** `pr_comments.max_sentences_per_reply`. Enforced by {@link enforceReplyBrevity}, not advised. */
export const DEFAULT_MAX_SENTENCES_PER_REPLY = 2;

/**
 * `pr_comments.max_chars_per_reply`. The second half of the budget, and the half
 * that was missing.
 *
 * A sentence budget bounds sentences, not bytes: one 4,000-character sentence is
 * one sentence, and the sentence budget passed it through verbatim while the
 * documentation said the over-long version "is not reachable". Literally true,
 * untrue in effect. 600 characters is roughly two dense sentences plus a link —
 * about what a reviewer reads without scrolling — and, like the sentence budget,
 * it CUTS rather than warns.
 */
export const DEFAULT_MAX_REPLY_CHARS = 600;

/** The disposition an AC10 reclaim stamps. Not a `dismissed-*` state — a reply is still owed. */
export const EXTERNAL_REFUTATION_DISPOSITION: FindingDispositionState = "answered-disagree";

// ---------------------------------------------------------------------------
// The GitHub port, and the allow-list that is AC12
// ---------------------------------------------------------------------------

export type GitHubMethod = "GET" | "POST";

export type GitHubRequest = {
  method: GitHubMethod;
  /** API path with no leading slash, e.g. `repos/o/r/pulls/7/comments`. */
  path: string;
  body?: unknown;
};

export type GitHubPort = {
  request(request: GitHubRequest): Promise<unknown>;
};

/**
 * The only three things this module may read.
 *
 * Written as anchored patterns rather than as a prefix check: `repos/o/r/pulls/7/comments`
 * and `repos/o/r/pulls/7/comments/12/replies` differ by a suffix, and a prefix
 * allow-list that accepted the first would accept every write built on it.
 */
export const ALLOWED_GITHUB_READS: readonly RegExp[] = [
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments(\?[^\s]*)?$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews(\?[^\s]*)?$/,
  /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments(\?[^\s]*)?$/,
];

/**
 * The only two things this module may write.
 *
 * A threaded reply, and — for the two comment kinds GitHub gives no thread to —
 * one PR-level comment. Nothing that resolves, hides, minimises, edits, deletes,
 * dismisses a review, or reaches GraphQL, because those are the operations that
 * would let this module silence the person it is answering.
 */
export const ALLOWED_GITHUB_WRITES: readonly RegExp[] = [
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/\d+\/replies$/,
  /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
];

/**
 * Refuse anything outside the allow-list, by name.
 *
 * This is where AC12 is enforced. It is a function rather than a convention
 * because a convention is a thing a later edit can be unaware of: any new call
 * added to this module goes through {@link callGitHub} and therefore through
 * here, and a request to resolve a thread fails at the port with a message that
 * says why rather than succeeding quietly on a live pull request.
 */
export function guardGitHubRequest(request: GitHubRequest): void {
  const allowed = request.method === "GET" ? ALLOWED_GITHUB_READS : ALLOWED_GITHUB_WRITES;
  if (allowed.some((pattern) => pattern.test(request.path))) {
    return;
  }
  throw new Error(
    `Refusing a GitHub ${request.method} to \`${request.path}\`: it is not one of the five endpoints this module may touch. ` +
      `Reads: pulls/{n}/comments, pulls/{n}/reviews, issues/{n}/comments. Writes: pulls/{n}/comments/{id}/replies, issues/{n}/comments. ` +
      `Resolving, hiding, minimising, editing and dismissing are deliberately unreachable — replying is ours, resolving is the reviewer's call, and a bot that auto-resolves is a bot that silences a human.`,
  );
}

async function callGitHub(port: GitHubPort, request: GitHubRequest): Promise<unknown> {
  guardGitHubRequest(request);
  return port.request(request);
}

/**
 * The live adapter: `gh api`, and no logic beyond parsing.
 *
 * `--paginate` is on for reads because a review round on a busy pull request is
 * exactly the case where page two exists, and a collector that silently reads the
 * first thirty comments reports "no new comments" about a thread it never saw.
 */
export function createGhPort(
  spawn: (argv: string[], stdin?: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> = ghSpawn,
): GitHubPort {
  return {
    async request(request: GitHubRequest): Promise<unknown> {
      guardGitHubRequest(request);
      const argv =
        request.method === "GET"
          ? ["gh", "api", "--paginate", request.path]
          : ["gh", "api", "--method", "POST", request.path, "--input", "-"];
      const result = await spawn(argv, request.method === "POST" ? JSON.stringify(request.body ?? {}) : undefined);
      if (result.exitCode !== 0) {
        throw new Error(
          `gh api ${request.method} ${request.path} exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
        );
      }
      return parseGhJson(result.stdout);
    },
  };
}

async function ghSpawn(
  argv: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * `gh api --paginate` concatenates one JSON document per page: `[...][...]`.
 *
 * `JSON.parse` rejects that outright, so a naive parser turns a two-page thread
 * into a hard error — or, worse, into a caught-and-ignored empty list. Arrays are
 * concatenated; a single document is returned as-is.
 */
export function parseGhJson(raw: string): unknown {
  const text = raw.trim();
  if (text === "") {
    return [];
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Fall through to the concatenated-document reader.
  }
  const documents: unknown[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = text.indexOf("][", cursor);
    const end = next === -1 ? text.length : next + 1;
    documents.push(JSON.parse(text.slice(cursor, end)) as unknown);
    cursor = end;
  }
  const merged: unknown[] = [];
  for (const document of documents) {
    if (Array.isArray(document)) {
      merged.push(...document);
    } else {
      merged.push(document);
    }
  }
  return merged;
}

/** One request a port received, in order. What a test asserts against. */
export type RecordedGitHubCall = GitHubRequest;

export type FixturePort = GitHubPort & {
  /** Every request the port was asked for, guarded ones included. */
  readonly calls: readonly RecordedGitHubCall[];
  /** Every write, in order. */
  readonly posts: readonly RecordedGitHubCall[];
};

/**
 * The offline adapter: reads answered from JSON on disk, writes recorded in memory.
 *
 * This is not a test double bolted on afterwards — it is how every GitHub
 * interaction in this module is exercised. The instruction for this work was that
 * nothing may be posted to a live pull request, and a mechanism that can only be
 * validated against a live pull request is a mechanism that ships unvalidated.
 *
 * `files` maps a fixture key to its parsed JSON. The keys are the three read
 * shapes: `pull-comments`, `pull-reviews`, `issue-comments`. A read with no
 * fixture answers `[]` — which is a real state (a pull request with no reviews),
 * not an error.
 */
export function createFixturePort(files: Record<string, unknown>, options: { postUrlPrefix?: string } = {}): FixturePort {
  const calls: RecordedGitHubCall[] = [];
  const posts: RecordedGitHubCall[] = [];
  const prefix = options.postUrlPrefix ?? "https://github.com/fixture/pull/1#issuecomment-";
  let posted = 0;
  return {
    get calls() {
      return calls;
    },
    get posts() {
      return posts;
    },
    async request(request: GitHubRequest): Promise<unknown> {
      calls.push(request);
      guardGitHubRequest(request);
      if (request.method === "POST") {
        posts.push(request);
        posted += 1;
        return { id: posted, html_url: `${prefix}${posted}` };
      }
      return files[fixtureKey(request.path)] ?? [];
    },
  };
}

/** The fixture key a read path maps to. Exported so a fixture directory is nameable. */
export function fixtureKey(apiPath: string): string {
  const withoutQuery = apiPath.split("?")[0] ?? apiPath;
  if (/\/pulls\/\d+\/comments$/.test(withoutQuery)) return "pull-comments";
  if (/\/pulls\/\d+\/reviews$/.test(withoutQuery)) return "pull-reviews";
  if (/\/issues\/\d+\/comments$/.test(withoutQuery)) return "issue-comments";
  return withoutQuery;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export const COMMENT_SOURCES = ["review-comment", "review", "issue-comment"] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];

/** How a severity was reached. `unclassified` is the honest third answer. */
export const SEVERITY_BASES = ["changes-requested", "default-minor", "unclassified"] as const;
export type SeverityBasis = (typeof SEVERITY_BASES)[number];

export type CollectedComment = {
  /** Namespaced: the three endpoints number independently and a bare id collides. */
  id: string;
  source: CommentSource;
  author: string;
  /** Recorded so a report can say who spoke. Never read by a filter — a bot reviewer is a reviewer. */
  authorIsBot: boolean;
  url: string;
  body: string;
  path: string | null;
  line: number | null;
  /** The root comment of the review thread, or null when GitHub gives the comment no thread. */
  threadId: string | null;
  submittedAt: string;
  /** The state of the review this comment belongs to, when there is one. */
  reviewState: string | null;
  severity: ReviewFindingSeverity;
  severityBasis: SeverityBasis;
  severityDetail: string;
  /** True when a newer non-us reply reopened a comment we had already answered. */
  reopened: boolean;
};

export const COMMENT_SKIP_REASONS = ["self-authored", "already-handled", "empty-body"] as const;
export type CommentSkipReason = (typeof COMMENT_SKIP_REASONS)[number];

export type CommentSkip = {
  id: string;
  author: string;
  reason: CommentSkipReason;
  detail: string;
};

export type CollectPrCommentsResult = {
  comments: CollectedComment[];
  /** Everything the filter removed, with the reason. A silent filter reads as "nobody commented". */
  skipped: CommentSkip[];
  counts: {
    reviewComments: number;
    reviews: number;
    issueComments: number;
    collected: number;
    reopened: number;
    bots: number;
    unclassified: number;
  };
};

export type CollectPrCommentsInput = {
  port: GitHubPort;
  /** `owner/repo`. */
  repo: string;
  number: number;
  /** The login the orchestrator is acting as. Required — see the throw below. */
  self: string;
  handled?: readonly HandledComment[] | undefined;
};

/**
 * Read all three sources, drop only what must be dropped, and say what was dropped.
 *
 * `self` is required and empty is refused. The alternative — collecting with no
 * identity and filtering nothing — produces a set containing our own replies, and
 * the reply pass would then answer itself on every round. Refusing to collect is
 * the smaller failure, and it is a loud one.
 */
export async function collectPrComments(input: CollectPrCommentsInput): Promise<CollectPrCommentsResult> {
  if (input.self.trim() === "") {
    throw new Error(
      "Refusing to collect PR comments with no `self` identity: without it our own replies are indistinguishable from a reviewer's, and the reply pass answers itself every round. Resolve the acting login (`gh api user --jq .login`) and pass it.",
    );
  }
  const base = `repos/${input.repo}`;
  const [rawReviewComments, rawReviews, rawIssueComments] = await Promise.all([
    callGitHub(input.port, { method: "GET", path: `${base}/pulls/${input.number}/comments` }),
    callGitHub(input.port, { method: "GET", path: `${base}/pulls/${input.number}/reviews` }),
    callGitHub(input.port, { method: "GET", path: `${base}/issues/${input.number}/comments` }),
  ]);

  const reviews = asArray(rawReviews);
  const reviewStates = new Map<string, string>();
  for (const review of reviews) {
    const id = numberProperty(review, "id");
    if (id !== null) {
      reviewStates.set(String(id), stringProperty(review, "state") ?? "");
    }
  }

  const skipped: CommentSkip[] = [];
  const all: CollectedComment[] = [];

  for (const raw of asArray(rawReviewComments)) {
    const built = buildReviewComment(raw, reviewStates);
    if (built === null) continue;
    all.push(built);
  }
  for (const raw of reviews) {
    const built = buildReviewSubmission(raw, skipped);
    if (built === null) continue;
    all.push(built);
  }
  for (const raw of asArray(rawIssueComments)) {
    const built = buildIssueComment(raw, skipped);
    if (built === null) continue;
    all.push(built);
  }

  const self = normaliseLogin(input.self);
  const others = all.filter((comment) => {
    if (normaliseLogin(comment.author) !== self) {
      return true;
    }
    skipped.push({
      id: comment.id,
      author: comment.author,
      reason: "self-authored",
      detail: `authored by the identity the orchestrator is acting as (${input.self})`,
    });
    return false;
  });

  // Reopening. A handled comment becomes new again when its thread carries a
  // reply from somebody else that is newer than the moment we answered — which is
  // the only way a reviewer can say "that did not address it" and be heard.
  const handled = input.handled ?? [];
  const handledById = new Map(handled.map((entry) => [entry.id, entry]));
  const newestByThread = new Map<string, string>();
  for (const comment of others) {
    const thread = comment.threadId;
    if (thread === null) continue;
    const current = newestByThread.get(thread);
    if (current === undefined || comment.submittedAt > current) {
      newestByThread.set(thread, comment.submittedAt);
    }
  }

  const comments: CollectedComment[] = [];
  for (const comment of others) {
    const prior = handledById.get(comment.id);
    // A record with no `reply_url` is a comment nobody actually answered — an
    // in-flight marker, or a summary that never posted. {@link unansweredComments}
    // reads it as unanswered, so collection must re-offer it: the two functions
    // disagreeing is a comment that can never be answered and never be cleared.
    if (prior === undefined || prior.reply_url === null) {
      comments.push(comment);
      continue;
    }
    const newest = comment.threadId === null ? undefined : newestByThread.get(comment.threadId);
    if (newest !== undefined && newest > prior.handled_at) {
      comments.push({ ...comment, reopened: true });
      continue;
    }
    skipped.push({
      id: comment.id,
      author: comment.author,
      reason: "already-handled",
      detail: `answered at ${prior.handled_at}${
        prior.reply_url === null ? "" : ` (${prior.reply_url})`
      }; no newer reply from anyone else in this thread`,
    });
  }

  return {
    comments,
    skipped,
    counts: {
      reviewComments: asArray(rawReviewComments).length,
      reviews: reviews.length,
      issueComments: asArray(rawIssueComments).length,
      collected: comments.length,
      reopened: comments.filter((comment) => comment.reopened).length,
      bots: comments.filter((comment) => comment.authorIsBot).length,
      unclassified: comments.filter((comment) => comment.severityBasis === "unclassified").length,
    },
  };
}

function buildReviewComment(raw: unknown, reviewStates: Map<string, string>): CollectedComment | null {
  const id = numberProperty(raw, "id");
  if (id === null) return null;
  const reviewId = numberProperty(raw, "pull_request_review_id");
  const state = reviewId === null ? undefined : reviewStates.get(String(reviewId));
  const classified = classifySeverity({
    source: "review-comment",
    state: state ?? null,
    stateKnown: state !== undefined,
    reviewId: reviewId === null ? null : String(reviewId),
  });
  const inReplyTo = numberProperty(raw, "in_reply_to_id");
  return {
    id: `review-comment:${id}`,
    source: "review-comment",
    author: authorLogin(raw),
    authorIsBot: authorIsBot(raw),
    url: stringProperty(raw, "html_url") ?? "",
    body: stringProperty(raw, "body") ?? "",
    path: stringProperty(raw, "path") ?? null,
    line: numberProperty(raw, "line") ?? numberProperty(raw, "original_line"),
    threadId: String(inReplyTo ?? id),
    submittedAt: stringProperty(raw, "created_at") ?? stringProperty(raw, "submitted_at") ?? "",
    reviewState: state ?? null,
    severity: classified.severity,
    severityBasis: classified.basis,
    severityDetail: classified.detail,
    reopened: false,
  };
}

function buildReviewSubmission(raw: unknown, skipped: CommentSkip[]): CollectedComment | null {
  const id = numberProperty(raw, "id");
  if (id === null) return null;
  const body = stringProperty(raw, "body") ?? "";
  const state = stringProperty(raw, "state");
  if (body.trim() === "") {
    // A review submission with no body carries no comment. Recorded rather than
    // dropped in silence: "the reviewer said nothing" and "we did not look" are
    // different facts, and only one of them is true here.
    skipped.push({
      id: `review:${id}`,
      author: authorLogin(raw),
      reason: "empty-body",
      detail: `review submission with state ${state ?? "unknown"} and an empty body — nothing was said to answer`,
    });
    return null;
  }
  const classified = classifySeverity({
    source: "review",
    state: state ?? null,
    stateKnown: state !== null && state !== undefined,
    reviewId: String(id),
  });
  return {
    id: `review:${id}`,
    source: "review",
    author: authorLogin(raw),
    authorIsBot: authorIsBot(raw),
    url: stringProperty(raw, "html_url") ?? "",
    body,
    path: null,
    line: null,
    // A review submission body is not in a thread. Saying so is what makes the
    // reply pass open a PR-level comment instead of pretending to thread.
    threadId: null,
    submittedAt: stringProperty(raw, "submitted_at") ?? stringProperty(raw, "created_at") ?? "",
    reviewState: state ?? null,
    severity: classified.severity,
    severityBasis: classified.basis,
    severityDetail: classified.detail,
    reopened: false,
  };
}

function buildIssueComment(raw: unknown, skipped: CommentSkip[]): CollectedComment | null {
  const id = numberProperty(raw, "id");
  if (id === null) return null;
  const body = stringProperty(raw, "body") ?? "";
  if (body.trim() === "") {
    skipped.push({
      id: `issue-comment:${id}`,
      author: authorLogin(raw),
      reason: "empty-body",
      detail: "PR-level comment with an empty body",
    });
    return null;
  }
  const classified = classifySeverity({ source: "issue-comment", state: null, stateKnown: true, reviewId: null });
  return {
    id: `issue-comment:${id}`,
    source: "issue-comment",
    author: authorLogin(raw),
    authorIsBot: authorIsBot(raw),
    url: stringProperty(raw, "html_url") ?? "",
    body,
    path: null,
    line: null,
    threadId: null,
    submittedAt: stringProperty(raw, "created_at") ?? "",
    reviewState: null,
    severity: classified.severity,
    severityBasis: classified.basis,
    severityDetail: classified.detail,
    reopened: false,
  };
}

/** The review states GitHub documents. Anything else is a fact we do not recognise. */
const KNOWN_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

export type SeverityClassification = {
  severity: ReviewFindingSeverity;
  basis: SeverityBasis;
  detail: string;
};

/**
 * The whole severity rule, and there is no fourth branch.
 *
 * `CHANGES_REQUESTED` → `major`. Everything else → `minor`. The third outcome is
 * not a third severity — it is the same `minor` with `basis: "unclassified"`,
 * which exists because the alternative to admitting a missing fact is inventing
 * one. A `minor` that was DERIVED from an `APPROVED` review and a `minor` that
 * was DEFAULTED because we never saw the parent review are different claims, and
 * a record that cannot tell them apart is the `dismissed-out-of-scope: 0` failure
 * in a new field.
 *
 * Nothing is ever dropped for being unclassifiable. The floor is `minor`, never
 * absent.
 */
export function classifySeverity(input: {
  source: CommentSource;
  state: string | null;
  stateKnown: boolean;
  reviewId: string | null;
}): SeverityClassification {
  if (input.state === "CHANGES_REQUESTED") {
    return {
      severity: "major",
      basis: "changes-requested",
      detail: "attached to a review whose state is CHANGES_REQUESTED",
    };
  }
  if (input.source === "issue-comment") {
    return {
      severity: "minor",
      basis: "default-minor",
      detail: "PR-level discussion, which is attached to no review — the rule's `everything else` branch",
    };
  }
  if (!input.stateKnown) {
    return {
      severity: "minor",
      basis: "unclassified",
      detail: `the parent review${
        input.reviewId === null ? "" : ` (${input.reviewId})`
      } was not among the reviews returned, so the state that decides major-vs-minor was never seen; classified at the floor and NOT dropped`,
    };
  }
  if (input.state === null || !KNOWN_REVIEW_STATES.has(input.state)) {
    return {
      severity: "minor",
      basis: "unclassified",
      detail: `review state ${
        input.state === null ? "absent" : `\`${input.state}\``
      } is not one GitHub documents; classified at the floor and NOT dropped`,
    };
  }
  return {
    severity: "minor",
    basis: "default-minor",
    detail: `attached to a review whose state is ${input.state}`,
  };
}

// ---------------------------------------------------------------------------
// Conversion to findings
// ---------------------------------------------------------------------------

/** How much of a comment body reaches `problem`. Long enough to read; the URL carries the rest. */
const PROBLEM_BUDGET = 800;

export type ExternalFindingOptions = {
  /** Where the ids start, so a second collection in one package does not collide. */
  startIndex?: number | undefined;
};

/**
 * One finding per unhandled comment, in the shape `review-finding.schema.json` accepts.
 *
 * Two choices here are worth naming because both look like they could have gone
 * the other way.
 *
 * **`reviewer` is the comment's author, not `review-orchestrator`.** It is the
 * truthful answer, and it also makes AC9 of flow 202 work for free: the verifier
 * refuses a claim whose verifier equals the finding's reviewer, so we cannot
 * verify a comment by impersonating the person who left it.
 *
 * **A `major` carries a single-site `class_scope`.** The contract requires
 * `class_scope` for `blocker` and `major`, and an external comment supplies one
 * site — the one the reviewer anchored to. Rather than suppress the severity the
 * rule assigns, or fabricate sibling sites, the `enumeration_method` states
 * exactly what was and was not done: the reviewer named this site and we
 * enumerated no class. A reader can then see that the single-entry list is a
 * limitation of the source, not a claim that the class has one member.
 */
export function externalFindingsFromComments(
  comments: readonly CollectedComment[],
  options: ExternalFindingOptions = {},
): StructuredReviewFinding[] {
  const start = options.startIndex ?? 1;
  return comments.map((comment, index) => {
    const ref: ExternalCommentRef = {
      id: comment.id,
      author: comment.author,
      url: comment.url,
      path: comment.path,
      line: comment.line,
      thread_id: comment.threadId,
      submitted_at: comment.submittedAt,
    };
    const finding: StructuredReviewFinding = {
      id: `EXT-${String(start + index).padStart(3, "0")}`,
      reviewer: comment.author,
      severity: comment.severity,
      problem: truncateForRecord(comment.body, PROBLEM_BUDGET),
      impact: `Raised on the pull request by ${comment.author}${
        comment.authorIsBot ? " (bot reviewer, handled identically to a human)" : ""
      }. Severity ${comment.severity}: ${comment.severityDetail}.`,
      suggested_fix:
        "not recorded: an external comment states a problem, not a fix. Anything here would be ours rather than theirs, and inventing it is how a severity gets invented too.",
      evidence: `${comment.source} ${comment.id} by ${comment.author} at ${comment.submittedAt}${
        comment.url === "" ? "" : ` — ${comment.url}`
      }`,
      confidence: "high",
      source: "external",
      external_ref: ref,
      // Stable across rounds, so the same comment collected twice is one finding.
      dedupe_key: `external:${comment.id}`,
    };
    if (comment.path !== null) {
      finding.file = comment.path;
    }
    if (comment.line !== null) {
      finding.line = comment.line;
    }
    if (comment.severity === "major" || comment.severity === "blocker") {
      finding.class_scope = {
        sites: [externalSite(comment)],
        enumeration_method:
          "external review comment: the site is the one the reviewer anchored to, and no class enumeration was performed on our side. A single-entry list here is a limitation of the source, not a claim that the class has one member.",
      };
    }
    return finding;
  });
}

function externalSite(comment: CollectedComment): string {
  if (comment.path !== null) {
    return comment.line === null ? comment.path : `${comment.path}:${comment.line}`;
  }
  return comment.url === "" ? comment.id : comment.url;
}

function truncateForRecord(body: string, budget: number): string {
  const text = body.trim();
  if (text.length <= budget) {
    return text;
  }
  return `${text.slice(0, budget).trimEnd()}… [truncated at ${budget} characters; the full comment is at its url]`;
}

// ---------------------------------------------------------------------------
// AC10 — the verifier cannot refute an external finding
// ---------------------------------------------------------------------------

export type ExternalReclaim = {
  finding: string;
  /** Whether the finding had actually been removed (filter mode) or only annotated. */
  removed: boolean;
  detail: string;
};

export type ExternalVerdictResult<T extends StructuredReviewFinding> = {
  result: VerificationMergeResult<T>;
  reclaimed: ExternalReclaim[];
};

/**
 * A `refuted` verdict on an external finding becomes `answered-disagree`, and the
 * finding stays.
 *
 * A human asked a question; a machine deciding the question was invalid is not an
 * answer. So the verdict is kept — it is a real observation and the reply will
 * cite it — and the CONSEQUENCE is changed: the finding is put back into the
 * retained set (in `filter` mode it had been removed) and stamped with a
 * disposition that still requires somebody to speak.
 *
 * The rule is deliberately mode-independent. In `annotate` nothing was removed,
 * but a `refuted` external finding would otherwise reach the completion gate with
 * no disposition at all, and "the verifier disagreed" is not a state anyone can
 * act on. In `filter` the finding was removed, which is the outcome AC10 names
 * outright.
 */
export function applyExternalVerdictRule<T extends StructuredReviewFinding>(
  merge: VerificationMergeResult<T>,
): ExternalVerdictResult<T> {
  const reclaimed: ExternalReclaim[] = [];
  const retained: T[] = merge.retained.map((finding) => {
    if (finding.source !== "external" || finding.verification?.verdict !== "refuted") {
      return finding;
    }
    reclaimed.push({
      finding: finding.global_id ?? finding.id,
      removed: false,
      detail: "verifier refuted an external comment; recorded as answered-disagree, which still owes a reply",
    });
    return stampAnsweredDisagree(finding);
  });

  const stillRefuted: T[] = [];
  for (const finding of merge.refuted) {
    if (finding.source !== "external") {
      stillRefuted.push(finding);
      continue;
    }
    reclaimed.push({
      finding: finding.global_id ?? finding.id,
      removed: true,
      detail:
        "verifier refuted an external comment in filter mode; the finding was put back and recorded as answered-disagree — a machine deciding a human's question was invalid is not an answer",
    });
    retained.push(stampAnsweredDisagree(finding));
  }

  const removedBack = merge.refuted.length - stillRefuted.length;
  return {
    reclaimed,
    result: {
      ...merge,
      retained,
      refuted: stillRefuted,
      counts: {
        ...merge.counts,
        findingsRefuted: merge.counts.findingsRefuted - removedBack,
        findingsRetained: merge.counts.findingsRetained + removedBack,
      },
    },
  };
}

function stampAnsweredDisagree<T extends StructuredReviewFinding>(finding: T): T {
  return {
    ...finding,
    disposition: {
      state: EXTERNAL_REFUTATION_DISPOSITION,
      evidence: `verifier ${finding.verification?.verifier ?? "(unnamed)"} refuted this by ${
        finding.verification?.method ?? "an unrecorded method"
      }: ${
        finding.verification?.evidence ?? "no evidence recorded"
      }. Recorded as answered-disagree rather than dismissed: the reply explaining why is still owed to ${
        finding.external_ref?.author ?? "the commenter"
      }.`,
    },
  };
}

/**
 * Split the retained set so the per-reviewer findings cap never truncates an
 * external comment.
 *
 * AC9 says an external comment may never be silently dropped. The findings cap
 * drops silently by design — it is a READING cap over what one reviewer reported
 * — and `reviewer` on an external finding is the commenter's login, so thirty
 * comments from CodeRabbit would truncate to ten and twenty people would go
 * unanswered with the truncation recorded under a heading nobody opens. The cap
 * runs over internal findings; externals bypass it and are bounded instead by
 * `max_replies_total`, which reports its backlog out loud.
 */
export function partitionExternalFindings<T extends StructuredReviewFinding>(
  findings: readonly T[],
): { internal: T[]; external: T[] } {
  const internal: T[] = [];
  const external: T[] = [];
  for (const finding of findings) {
    (finding.source === "external" ? external : internal).push(finding);
  }
  return { internal, external };
}

// ---------------------------------------------------------------------------
// Brevity — enforced, not advised
// ---------------------------------------------------------------------------

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = ["e.g.", "i.e.", "etc.", "cf.", "vs.", "approx.", "no.", "fig.", "al."];

/**
 * Sentences, counted the way a reader counts them.
 *
 * URLs, inline code and markdown link targets are masked before splitting: a link
 * is the thing the brevity rule TELLS you to use, and a counter that read
 * `https://x/y.md` as two sentences would punish the compliant reply. Fenced code
 * is refused outright by {@link enforceReplyBrevity} rather than counted — a code
 * block in a PR reply is a paste, and §5 says link, do not paste.
 */
export function splitSentences(text: string): string[] {
  const spans: string[] = [];
  // A sentinel rather than a bare index. An index delimited by spaces collides
  // with ordinary text — "fixed in 2 files" would restore as "fixed in files" —
  // and a mask that edits the thing it protects is worse than no mask, because
  // the damage is invisible in the output that gets counted.
  const stash = (match: string): string => {
    spans.push(match);
    return `%%KERYX-SPAN-${spans.length - 1}%%`;
  };
  let masked = text
    .replace(/`[^`]*`/g, stash)
    .replace(/\[[^\]]*\]\([^)]*\)/g, stash)
    .replace(/<https?:\/\/[^>\s]+>/g, stash)
    .replace(/https?:\/\/\S+/g, stash);
  for (const abbreviation of ABBREVIATIONS) {
    // `\b` so `no.` does not match the end of "casino." — an abbreviation that
    // swallows a real full stop UNDER-counts sentences, which is the direction
    // that lets a long reply through the budget.
    masked = masked.replace(new RegExp(`\\b${escapeRegExp(abbreviation)}`, "gi"), stash);
  }
  const restore = (value: string): string =>
    value.replace(/%%KERYX-SPAN-(\d+)%%/g, (_, index: string) => spans[Number(index)] ?? "");
  return masked
    .split(/(?<=[.!?])["')\]]*(?:\s+|$)/)
    .map((part) => restore(part).trim())
    .filter((part) => part.length > 0)
    .filter((part) => !isBareLink(part));
}

/**
 * A bare link is not a sentence.
 *
 * Without this the counter is not idempotent: {@link enforceReplyBrevity} cuts to
 * two sentences and appends the link, and re-measuring its own output returns
 * three. A budget whose output fails its own check is a budget that cannot be
 * asserted anywhere downstream — and downstream is where the posting happens.
 */
function isBareLink(part: string): boolean {
  return /^<?https?:\/\/\S+>?$/.test(part) || /^\[[^\]]*\]\([^)]*\)$/.test(part);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type BrevityResult = {
  body: string;
  sentences: number;
  truncated: boolean;
  /** The sentences that did not fit. They live in the flow package, which the link points at. */
  dropped: string[];
  /** True when the character ceiling, rather than the sentence budget, did the cutting. */
  truncatedByChars: boolean;
};

/**
 * The two-sentence budget, applied rather than requested — and a character
 * ceiling beside it, because sentences are not bytes.
 *
 * "Keep it short" in a skill file is a request, and a model under pressure to be
 * helpful writes five sentences and an apology. This function is the difference:
 * a reply longer than the budget is CUT to the budget and the remainder is
 * replaced by a link. Nothing downstream can post the long version, because the
 * long version is not what this returns.
 *
 * **Two bounds, because one of them was gameable.** A 4,000-character reply with
 * a single full stop is one sentence, and the sentence budget passed it through
 * verbatim while the reference said the over-long version was not reachable —
 * literally true, untrue in effect. So the budget is now sentences AND
 * characters: whole sentences are dropped first, because a cut at a sentence
 * boundary still reads as a reply, and only a lone sentence that breaks the
 * ceiling by itself is cut mid-way — at a word boundary, with an ellipsis and the
 * link.
 *
 * The one hard refusal is a truncation with nowhere to point. Dropping three
 * sentences of explanation and offering the reviewer no way to read them is worse
 * than either posting the long reply or posting nothing, so it throws — and that
 * holds for the ceiling exactly as it holds for the sentence budget.
 *
 * The `Re <url>:` anchor {@link renderReplyBody} prefixes onto a top-level reply
 * sits outside both bounds on purpose: it is an address rather than an
 * explanation, and it is the thing that makes the reply readable at all.
 */
export function enforceReplyBrevity(
  text: string,
  options: {
    maxSentences?: number | undefined;
    maxChars?: number | undefined;
    link?: string | null | undefined;
    what?: string | undefined;
  } = {},
): BrevityResult {
  const max = options.maxSentences ?? DEFAULT_MAX_SENTENCES_PER_REPLY;
  const maxChars = options.maxChars ?? DEFAULT_MAX_REPLY_CHARS;
  const what = options.what ?? "reply";
  if (max < 1) {
    throw new Error(`Refusing a ${what} budget of ${max} sentences: a reply of zero sentences is silence with extra steps.`);
  }
  if (maxChars < 1) {
    throw new Error(
      `Refusing a ${what} ceiling of ${maxChars} characters: a reply of zero characters is silence with extra steps.`,
    );
  }
  if (text.includes("```")) {
    throw new Error(
      `Refusing a ${what} containing a fenced code block: link, do not paste. The patch, the log and the reasoning belong in the flow package, which is durable and costs the reviewer nothing to skip.`,
    );
  }
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    throw new Error(`Refusing an empty ${what}: silence is not an acceptable outcome for a comment.`);
  }

  const link = options.link ?? null;
  const hasLink = link !== null && link !== "";
  // A truncated body always carries the link; an untruncated one carries it only
  // when the text does not already contain it.
  const render = (candidate: string, cut: boolean): string =>
    hasLink && (cut || !candidate.includes(link)) ? `${candidate} ${link}` : candidate;

  const kept = sentences.slice(0, max);
  const dropped = sentences.slice(max);
  let truncated = dropped.length > 0;
  if (truncated && !hasLink) {
    throw new Error(
      `Refusing to truncate a ${what} of ${sentences.length} sentences to ${max} with no link: the conclusion would be posted and the explanation would exist nowhere the reviewer can reach. Record the detail in the flow package and pass its link.`,
    );
  }
  let body = truncated ? kept.join(" ") : text.trim();
  let truncatedByChars = false;

  if (render(body, truncated).length > maxChars && !hasLink) {
    throw new Error(
      `Refusing to cut a ${what} of ${render(body, truncated).length} characters down to ${maxChars} with no link: it is inside the ${max}-sentence budget, so the ceiling is the only thing between the reviewer and a wall of text. Record the detail in the flow package and pass its link.`,
    );
  }

  // Whole sentences first: a cut at a sentence boundary still reads as a reply.
  while (render(body, truncated).length > maxChars && kept.length > 1) {
    dropped.unshift(kept.pop() as string);
    truncated = true;
    truncatedByChars = true;
    body = kept.join(" ");
  }

  // One sentence, still over the ceiling. This is the case a sentence budget can
  // never see, and the reason the ceiling exists.
  if (render(body, truncated).length > maxChars) {
    const target = link as string;
    const room = maxChars - target.length - 2;
    if (room < 1) {
      throw new Error(
        `Refusing a ${what} ceiling of ${maxChars} characters with a ${target.length}-character link: nothing is left to say anything in. Raise the ceiling or shorten the link.`,
      );
    }
    const whole = body;
    const cut = whole.slice(0, room);
    const boundary = cut.lastIndexOf(" ");
    // A word boundary is honoured only in the back half: one at character 3 of
    // 500 would post three words and call it an answer.
    body = `${(boundary > room / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
    truncated = true;
    truncatedByChars = true;
    // The whole sentence is what the link now has to be able to show.
    dropped.unshift(whole);
  }

  return { body: render(body, truncated), sentences: kept.length, truncated, dropped, truncatedByChars };
}

/**
 * AC18, for every outward-facing GitHub artifact that is not a threaded reply.
 *
 * PR bodies, issue comments and the overflow summary go through here. The rule is
 * the weaker of the two on purpose: a PR body may run long, but only if it links
 * to the artifact holding the detail. Length without a link is the failure —
 * that is the artifact that made someone read our reasoning instead of our
 * conclusion.
 */
export function assertOutwardBrevity(
  text: string,
  options: { maxSentences?: number | undefined; what?: string | undefined } = {},
): void {
  const max = options.maxSentences ?? DEFAULT_MAX_SENTENCES_PER_REPLY;
  const what = options.what ?? "GitHub comment";
  const sentences = splitSentences(text);
  if (sentences.length <= max) {
    return;
  }
  if (/https?:\/\/\S+|\]\([^)]+\)/.test(text)) {
    return;
  }
  throw new Error(
    `Refusing to post a ${what} of ${sentences.length} sentences with no link: past ${max} sentences an outward artifact must carry a link to the flow artifact holding the detail. Verbose in the flow, terse on GitHub — the flow is written for whoever resumes the work, GitHub is read by someone who did not ask for our reasoning.`,
  );
}

// ---------------------------------------------------------------------------
// The reply pass
// ---------------------------------------------------------------------------

export const REPLY_MODES = ["thread-reply", "issue-comment", "overflow-summary"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

/** What the orchestrator decided about one comment. The judgement stays with the model. */
export type CommentOutcome = {
  comment: string;
  disposition: FindingDispositionState;
  /** The reply text, before the budget is applied. */
  text: string;
  /** The flow artifact carrying the detail. Required when the text does not fit. */
  link?: string | null | undefined;
  /**
   * Set when the comment BLOCKS progress rather than reporting a problem.
   *
   * Escalated to the operator immediately instead of being queued for the end.
   * This is the one branch the collector cannot decide: whether a question stops
   * the work is a judgement, and the mechanical part is only that an escalated
   * comment leaves the reply queue and is reported.
   */
  escalate?: boolean | undefined;
};

export type PlannedReply = {
  comment: CollectedComment;
  disposition: FindingDispositionState;
  mode: ReplyMode;
  endpoint: string;
  body: string;
  truncated: boolean;
  /** Why this is a top-level comment rather than a threaded one, when it is. */
  modeReason: string;
};

/**
 * A comment answered by the overflow summary rather than individually.
 *
 * The disposition travels WITH the comment. It used to be dropped here and
 * re-invented as `dismissed-deprioritised` when the record was written, which
 * overwrote the outcome the orchestrator actually reached — a dismissal on the
 * orchestrator's own authority, which AC6 forbids outright. Being past the reply
 * cap changes how a comment is answered, never what was decided about it.
 */
export type BackloggedComment = {
  comment: CollectedComment;
  disposition: FindingDispositionState;
};

export type ReplyPass = {
  replies: PlannedReply[];
  /** Comments beyond `max_replies_total`. Answered collectively by `summary`. */
  backlog: BackloggedComment[];
  /** The one overflow comment, or null when nothing overflowed. */
  summary: PlannedReply | null;
  /** Comments the orchestrator flagged as blocking. Never queued; reported to the operator. */
  escalations: CollectedComment[];
};

export type BuildReplyPassInput = {
  repo: string;
  number: number;
  comments: readonly CollectedComment[];
  outcomes: readonly CommentOutcome[];
  maxReplies?: number | undefined;
  maxSentences?: number | undefined;
  maxChars?: number | undefined;
  /** The flow package link the overflow summary points at. */
  flowLink?: string | undefined;
};

/**
 * One reply per comment, each inside the budget, with the ones that overflow
 * named rather than forgotten.
 *
 * A comment with no outcome is a hard error. It is tempting to emit a neutral
 * "no change" reply instead and keep the pass moving, and that is precisely the
 * shape this programme keeps removing: a mechanism that produces something
 * plausible when its input is missing produces a record nobody can read
 * afterwards. A comment nobody decided about is a comment nobody read.
 */
export function buildReplyPass(input: BuildReplyPassInput): ReplyPass {
  const maxReplies = input.maxReplies ?? DEFAULT_MAX_REPLIES_TOTAL;
  const maxSentences = input.maxSentences ?? DEFAULT_MAX_SENTENCES_PER_REPLY;
  const byId = new Map(input.outcomes.map((outcome) => [outcome.comment, outcome]));

  const missing = input.comments.filter((comment) => !byId.has(comment.id)).map((comment) => comment.id);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run the reply pass with ${missing.length} comment(s) nobody decided about: ${missing.join(
        ", ",
      )}. Every collected comment gets exactly one disposition and one reply — silence is not an acceptable outcome, and a neutral auto-reply would record a decision that was never made.`,
    );
  }

  const duplicated = input.outcomes
    .map((outcome) => outcome.comment)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicated.length > 0) {
    throw new Error(
      `Refusing two outcomes for one comment: ${[...new Set(duplicated)].join(
        ", ",
      )}. One reply per comment; a second reply saying the same thing is the noise this pass exists to avoid.`,
    );
  }

  const escalations: CollectedComment[] = [];
  const answerable: Array<{ comment: CollectedComment; outcome: CommentOutcome }> = [];
  for (const comment of input.comments) {
    const outcome = byId.get(comment.id) as CommentOutcome;
    if (outcome.escalate === true) {
      escalations.push(comment);
      continue;
    }
    assertTerminalDisposition(outcome);
    answerable.push({ comment, outcome });
  }

  const within = answerable.slice(0, maxReplies);
  const overflow = answerable.slice(maxReplies);

  const replies = within.map(({ comment, outcome }) => {
    const brevity = enforceReplyBrevity(outcome.text, {
      maxSentences,
      maxChars: input.maxChars,
      link: outcome.link ?? null,
      what: `reply to ${comment.id}`,
    });
    const routed = routeReply(input.repo, input.number, comment);
    return {
      comment,
      disposition: outcome.disposition,
      mode: routed.mode,
      endpoint: routed.endpoint,
      body: brevity.body,
      truncated: brevity.truncated,
      modeReason: routed.reason,
    };
  });

  const backlog: BackloggedComment[] = overflow.map(({ comment, outcome }) => ({
    comment,
    disposition: outcome.disposition,
  }));
  const summary = backlog.length === 0 ? null : buildOverflowSummary(input, backlog, maxReplies, maxSentences);

  return { replies, backlog, summary, escalations };
}

function assertTerminalDisposition(outcome: CommentOutcome): void {
  if (!(EXTERNAL_TERMINAL_DISPOSITIONS as readonly string[]).includes(outcome.disposition)) {
    throw new Error(
      `Refusing to reply to ${outcome.comment} with disposition \`${outcome.disposition}\`: an external comment ends in one of ${EXTERNAL_TERMINAL_DISPOSITIONS.join(
        ", ",
      )}. \`unknown\` is what an unanswered comment already reads as, so recording it would say a decision was made when none was.`,
    );
  }
}

/**
 * Where the reply goes, and why.
 *
 * A review comment has a thread and gets `POST .../comments/{id}/replies`. A
 * review submission body and a PR-level comment have no thread — GitHub offers no
 * reply endpoint for either — so those get one PR-level comment, and the reason is
 * recorded on the plan rather than left for a reader to infer from the endpoint.
 */
export function routeReply(
  repo: string,
  number: number,
  comment: CollectedComment,
): { mode: ReplyMode; endpoint: string; reason: string } {
  if (comment.source === "review-comment" && comment.threadId !== null) {
    return {
      mode: "thread-reply",
      endpoint: `repos/${repo}/pulls/${number}/comments/${comment.threadId}/replies`,
      reason: "inline review comment: answered inside its own thread",
    };
  }
  return {
    mode: "issue-comment",
    endpoint: `repos/${repo}/issues/${number}/comments`,
    reason:
      comment.source === "review"
        ? "review submission body: GitHub exposes no reply endpoint for a review, so the answer is one PR-level comment quoting its link"
        : "PR-level comment: GitHub exposes no threaded reply for issue comments",
  };
}

function buildOverflowSummary(
  input: BuildReplyPassInput,
  backlog: readonly BackloggedComment[],
  maxReplies: number,
  maxSentences: number,
): PlannedReply {
  const link = input.flowLink ?? null;
  const text = `${backlog.length} further comment${
    backlog.length === 1 ? "" : "s"
  } were handled but not replied to individually, because the reply cap of ${maxReplies} was reached. Each one's outcome is recorded in the flow package.`;
  const brevity = enforceReplyBrevity(text, {
    maxSentences,
    maxChars: input.maxChars,
    link,
    what: "overflow summary",
  });
  assertOutwardBrevity(brevity.body, { maxSentences, what: "overflow summary" });
  const first = backlog[0] as BackloggedComment;
  return {
    comment: first.comment,
    // The summary's own record, under the `overflow-summary:` key — not any
    // comment's disposition. Each backlogged comment keeps the outcome the
    // orchestrator reached for it; see {@link BackloggedComment}.
    disposition: "dismissed-deprioritised",
    mode: "overflow-summary",
    endpoint: `repos/${input.repo}/issues/${input.number}/comments`,
    body: brevity.body,
    truncated: brevity.truncated,
    modeReason: `reply cap ${maxReplies} reached; one summary comment stands for ${backlog.length} backlogged comment(s)`,
  };
}

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

export const PR_COMMENT_STATE_VERSION = 1;

export type HandledComment = {
  id: string;
  thread_id: string | null;
  author: string;
  url: string;
  first_seen_round: number;
  handled_at: string;
  /** The head commit the answer was true of. */
  sha: string;
  disposition: FindingDispositionState;
  reply_url: string | null;
  via: ReplyMode;
  /**
   * Written BEFORE the POST and removed after it, so a process killed in that
   * window leaves a record saying which reply was in the air.
   *
   * Absent on every settled entry — an entry carrying it is a question, not an
   * answer, and {@link postReplyPass} resolves it against GitHub rather than
   * guessing. See the doc comment there for why the after-every-post write alone
   * was not enough.
   */
  in_flight?: true;
};

export type SeenComment = {
  id: string;
  thread_id: string | null;
  author: string;
  url: string;
  first_seen_round: number;
  last_seen_round: number;
  submitted_at: string;
};

export type PrCommentState = {
  schemaVersion: typeof PR_COMMENT_STATE_VERSION;
  repo: string;
  number: number;
  self: string | null;
  rounds_collected: number;
  replies_posted_at: string | null;
  seen: SeenComment[];
  handled_comments: HandledComment[];
  /** Comment ids answered by the overflow summary rather than individually. */
  backlog: string[];
  /** Comment ids escalated to the operator instead of replied to. */
  escalated: string[];
};

/**
 * Where the record lives, and why it is not in the flow.
 *
 * Keyed by pull request rather than by flow or by review package, because that is
 * the thing whose identity does not change: a flow can be resumed under a new
 * session, a review package is per round, and a comment answered in round 3 must
 * still read as answered in round 6 and after a restart. Task Manager state stays
 * owned by `keryx flow`; nothing here writes into `flow.json`.
 */
export function prCommentsStatePath(cwd: string, repo: string, number: number): string {
  return path.join(cwd, ".metaproject", "reviews", "pr-comments", `${repo.replace(/\//g, "__")}__${number}.json`);
}

export function emptyPrCommentState(repo: string, number: number): PrCommentState {
  return {
    schemaVersion: PR_COMMENT_STATE_VERSION,
    repo,
    number,
    self: null,
    rounds_collected: 0,
    replies_posted_at: null,
    seen: [],
    handled_comments: [],
    backlog: [],
    escalated: [],
  };
}

export async function readPrCommentState(cwd: string, repo: string, number: number): Promise<PrCommentState> {
  const file = prCommentsStatePath(cwd, repo, number);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PrCommentState>;
    return {
      ...emptyPrCommentState(repo, number),
      ...parsed,
      seen: parsed.seen ?? [],
      handled_comments: parsed.handled_comments ?? [],
      backlog: parsed.backlog ?? [],
      escalated: parsed.escalated ?? [],
    };
  } catch {
    // A missing file is a pull request nobody has commented on yet. An unreadable
    // one is NOT treated as empty by accident — `JSON.parse` throwing here would
    // mean a corrupt record, and answering twice is the cost. That trade is taken
    // deliberately: the alternative is refusing to reply at all because a cache
    // file is damaged, which turns a recoverable duplicate into silence.
    return emptyPrCommentState(repo, number);
  }
}

export async function writePrCommentState(cwd: string, state: PrCommentState): Promise<void> {
  await writeFileAtomic(
    prCommentsStatePath(cwd, state.repo, state.number),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/**
 * Record what this round saw, so `first_seen_round` survives the session that saw it.
 *
 * A comment's first round is the number the reply cites and the number the flow
 * package reports. Recomputing it from the current round would say every comment
 * arrived in the last one.
 */
export function recordSeenComments(
  state: PrCommentState,
  comments: readonly CollectedComment[],
  round: number,
  self?: string | undefined,
): PrCommentState {
  const seen = [...state.seen];
  for (const comment of comments) {
    const existing = seen.findIndex((entry) => entry.id === comment.id);
    if (existing === -1) {
      seen.push({
        id: comment.id,
        thread_id: comment.threadId,
        author: comment.author,
        url: comment.url,
        first_seen_round: round,
        last_seen_round: round,
        submitted_at: comment.submittedAt,
      });
      continue;
    }
    const prior = seen[existing] as SeenComment;
    seen[existing] = { ...prior, last_seen_round: round };
  }
  return {
    ...state,
    self: self ?? state.self,
    rounds_collected: Math.max(state.rounds_collected, round),
    seen,
  };
}

/**
 * Comments this pull request has seen and not answered.
 *
 * The completion gate's question, answered from the durable record rather than
 * from the session — a resumed session starts with an empty memory and the real
 * backlog does not.
 *
 * **Answered means a reply exists**, not that a row exists. Membership alone was
 * the test, and it let two shapes through the gate: an in-flight marker written
 * before a POST that never landed, and a backlogged comment whose overflow
 * summary failed to post. Both are rows with `reply_url: null` — the record's own
 * way of saying nobody spoke — and both used to read as answered. A comment
 * nobody replied to is unanswered whatever else is written beside it.
 */
export function unansweredComments(state: PrCommentState): SeenComment[] {
  const answered = new Set(
    state.handled_comments.filter((entry) => entry.reply_url !== null).map((entry) => entry.id),
  );
  return state.seen.filter((entry) => !answered.has(entry.id));
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export type PostReplyPassInput = {
  port: GitHubPort;
  cwd: string;
  repo: string;
  number: number;
  pass: ReplyPass;
  /** The head commit the answers are true of, recorded on every handled comment. */
  sha: string;
  round: { index: number; isFinal: boolean };
  state: PrCommentState;
  now?: Date | undefined;
  /** Plan only: nothing is posted and nothing is written. */
  dryRun?: boolean | undefined;
};

export type PostReplyPassResult = {
  posted: PlannedReply[];
  /** Already answered in an earlier pass; skipped rather than repeated. */
  skipped: Array<{ id: string; reply_url: string | null }>;
  backlog: string[];
  escalated: string[];
  state: PrCommentState;
  /** In a dry run, exactly the requests that would have been sent. */
  requests: GitHubRequest[];
};

/**
 * Post the pass, once, after the final round.
 *
 * Two refusals and one persistence rule, all three of them load-bearing.
 *
 * **A non-final round is refused.** The operator's instruction was explicit: the
 * work happens continuously, the speaking happens once. Leaving that to the
 * caller means the first orchestrator that forgets turns one review thread into
 * six, and the reviewer reads the noise before the answer.
 *
 * **An already-answered comment is skipped, not repeated.** The check is against
 * the file on disk, so it holds across a session restart — which is the case that
 * actually happens, because a long flow gets resumed.
 *
 * **The write brackets the POST; it does not follow it.** Writing after every
 * post bounds the loss to one comment, which is not the same as closing the
 * window, and the difference was reproducible: kill the process after the second
 * POST returns and the second run posts that reply again, because the record only
 * ever learns about a reply that was survived. So a marker is written BEFORE the
 * request goes out and replaced by the settled record after it, and a marker
 * found on the next run is resolved against the pull request itself — the reply
 * is either visible in the thread, in which case GitHub is the record and the
 * entry is completed from it, or it is not, in which case the POST never landed
 * and it is sent. Neither branch guesses, and neither branch can produce a second
 * reply saying the same thing.
 */
export async function postReplyPass(input: PostReplyPassInput): Promise<PostReplyPassResult> {
  if (!input.round.isFinal) {
    throw new Error(
      `Refusing to post replies during round ${input.round.index}: comments are collected every round and answered ONCE, after the final round and before the completion gate. Replying per round turns one review thread into six, and every reply would state an intention rather than a settled outcome.`,
    );
  }

  const now = (input.now ?? new Date()).toISOString();
  const alreadyAnswered = new Map(input.state.handled_comments.map((entry) => [entry.id, entry]));
  const posted: PlannedReply[] = [];
  const skipped: Array<{ id: string; reply_url: string | null }> = [];
  const requests: GitHubRequest[] = [];
  let state = input.state;

  const queue: PlannedReply[] = [...input.pass.replies];
  if (input.pass.summary !== null) {
    queue.push(input.pass.summary);
  }
  const summaryKey = `overflow-summary:${input.repo}#${input.number}`;
  let summaryReplyUrl: string | null =
    input.state.handled_comments.find((entry) => entry.id === summaryKey)?.reply_url ?? null;

  for (const reply of queue) {
    const isSummary = reply.mode === "overflow-summary";
    const key = isSummary ? summaryKey : reply.comment.id;
    const prior = alreadyAnswered.get(key);
    if (prior !== undefined && prior.in_flight !== true) {
      skipped.push({ id: key, reply_url: prior.reply_url });
      continue;
    }
    const body = renderReplyBody(reply);
    const request: GitHubRequest = { method: "POST", path: reply.endpoint, body: { body } };
    guardGitHubRequest(request);
    requests.push(request);
    if (input.dryRun === true) {
      continue;
    }

    const settled: HandledComment = {
      id: key,
      // The summary is not in any thread; saying it is would put a reader on
      // a conversation it never touched.
      thread_id: isSummary ? null : reply.comment.threadId,
      author: isSummary ? "" : reply.comment.author,
      url: isSummary ? "" : reply.comment.url,
      first_seen_round: firstSeenRound(state, reply.comment.id, input.round.index),
      handled_at: now,
      sha: input.sha,
      disposition: reply.disposition,
      reply_url: null,
      via: reply.mode,
    };

    if (prior?.in_flight === true) {
      // A previous run died with this request in the air. Ask the pull request
      // what actually happened rather than choosing between answering twice and
      // never answering.
      const found = await findPostedReply(input.port, input.repo, input.number, reply, body);
      if (found !== null) {
        state = upsertHandled(state, { ...settled, handled_at: prior.handled_at, reply_url: found.url });
        await writePrCommentState(input.cwd, state);
        alreadyAnswered.set(key, { ...settled, reply_url: found.url });
        if (isSummary) {
          summaryReplyUrl = found.url;
        }
        skipped.push({ id: key, reply_url: found.url });
        continue;
      }
    } else {
      // Before the POST, not after it. This is the whole fix.
      state = upsertHandled(state, { ...settled, in_flight: true });
      await writePrCommentState(input.cwd, state);
    }

    const response = await input.port.request(request);
    const replyUrl = stringProperty(response, "html_url");
    posted.push(reply);
    if (isSummary) {
      summaryReplyUrl = replyUrl;
    }
    state = upsertHandled(state, { ...settled, reply_url: replyUrl ?? null });
    await writePrCommentState(input.cwd, state);
  }

  const backlog = input.pass.backlog.map((entry) => entry.comment.id);
  const escalated = input.pass.escalations.map((comment) => comment.id);
  if (input.dryRun !== true) {
    // The backlog is recorded whether or not the summary posted: a comment
    // answered collectively is still answered, and one that is not recorded reads
    // as never collected.
    state = {
      ...state,
      replies_posted_at: now,
      backlog: [...new Set([...state.backlog, ...backlog])],
      escalated: [...new Set([...state.escalated, ...escalated])],
      handled_comments: [
        ...state.handled_comments,
        ...input.pass.backlog
          .filter((entry) => !state.handled_comments.some((handled) => handled.id === entry.comment.id))
          .map((entry) => ({
            id: entry.comment.id,
            thread_id: entry.comment.threadId,
            author: entry.comment.author,
            url: entry.comment.url,
            first_seen_round: firstSeenRound(state, entry.comment.id, input.round.index),
            handled_at: now,
            sha: input.sha,
            // The outcome the orchestrator reached, carried through the cap.
            // Overwriting it with `dismissed-deprioritised` invented a dismissal
            // on the orchestrator's own authority — which AC6 forbids — and threw
            // away the decision somebody actually made.
            disposition: entry.disposition,
            // The summary comment IS the reply for a backlogged comment, so the
            // record points at it. Null only when the summary itself did not
            // post — and then the comment reads as collected and unanswered,
            // which is what the completion gate must see.
            reply_url: summaryReplyUrl,
            via: "overflow-summary" as ReplyMode,
          })),
      ],
    };
    await writePrCommentState(input.cwd, state);
  }

  return { posted, skipped, backlog, escalated, state, requests };
}

/** Replace the entry with this id, or append it. One row per key, always. */
function upsertHandled(state: PrCommentState, entry: HandledComment): PrCommentState {
  const index = state.handled_comments.findIndex((existing) => existing.id === entry.id);
  if (index === -1) {
    return { ...state, handled_comments: [...state.handled_comments, entry] };
  }
  const handled = [...state.handled_comments];
  handled[index] = entry;
  return { ...state, handled_comments: handled };
}

/**
 * Is this exact reply already on the pull request?
 *
 * Matched on the rendered body — the bytes {@link renderReplyBody} produces are
 * deterministic — and, for a threaded reply, on the thread it sits in. Identity
 * deliberately plays no part: `self` can be absent from a resumed state, and a
 * recovery path that refuses to run without it would fail in exactly the case it
 * exists for. Body plus thread is the stronger signal anyway, because it answers
 * "did THIS reply land", not "have we ever spoken here".
 *
 * Both reads are on the allow-list, so the recovery cannot reach anything the
 * rest of the module cannot.
 *
 * The assumption it rests on, stated: the retry renders the same bytes. That is
 * true of this pipeline — the reply text comes from the recorded outcome and
 * {@link enforceReplyBrevity} is a pure function of it — and a retry that
 * rewrote the reply would post a second, different one. Which is the honest
 * outcome for a different answer, but it is worth knowing that is the seam.
 */
async function findPostedReply(
  port: GitHubPort,
  repo: string,
  number: number,
  reply: PlannedReply,
  body: string,
): Promise<{ url: string | null } | null> {
  const wanted = body.trim();
  if (reply.mode === "thread-reply") {
    const raw = await callGitHub(port, { method: "GET", path: `repos/${repo}/pulls/${number}/comments` });
    for (const candidate of asArray(raw)) {
      const inReplyTo = numberProperty(candidate, "in_reply_to_id");
      if (inReplyTo === null || String(inReplyTo) !== reply.comment.threadId) continue;
      if ((stringProperty(candidate, "body") ?? "").trim() !== wanted) continue;
      return { url: stringProperty(candidate, "html_url") };
    }
    return null;
  }
  const raw = await callGitHub(port, { method: "GET", path: `repos/${repo}/issues/${number}/comments` });
  for (const candidate of asArray(raw)) {
    if ((stringProperty(candidate, "body") ?? "").trim() !== wanted) continue;
    return { url: stringProperty(candidate, "html_url") };
  }
  return null;
}

function firstSeenRound(state: PrCommentState, id: string, fallback: number): number {
  return state.seen.find((entry) => entry.id === id)?.first_seen_round ?? fallback;
}

/**
 * The bytes that go to GitHub.
 *
 * A top-level reply names what it is answering, because without the thread the
 * reader has no anchor — and the anchor is a link, which costs no sentence.
 */
export function renderReplyBody(reply: PlannedReply): string {
  if (reply.mode === "thread-reply") {
    return reply.body;
  }
  if (reply.mode === "overflow-summary") {
    return reply.body;
  }
  const anchor = reply.comment.url === "" ? reply.comment.id : reply.comment.url;
  return `Re ${anchor}: ${reply.body}`;
}

// ---------------------------------------------------------------------------
// Rendering (for the review package and the terminal)
// ---------------------------------------------------------------------------

/** The `## External comments` block a review package carries. Verbose here, terse on GitHub. */
export function renderPrCommentsMarkdown(input: {
  repo: string;
  number: number;
  round: number;
  result: CollectPrCommentsResult;
}): string {
  const lines: string[] = ["## External comments", ""];
  lines.push(`- pull request: ${input.repo}#${input.number}`);
  lines.push(`- round: ${input.round}`);
  const counts = input.result.counts;
  lines.push(
    `- sources read: inline=${counts.reviewComments} reviews=${counts.reviews} pr_discussion=${counts.issueComments}`,
  );
  lines.push(
    `- collected: ${counts.collected} (reopened=${counts.reopened}, bot_authors=${counts.bots}, unclassified_severity=${counts.unclassified})`,
  );
  lines.push("");
  if (input.result.comments.length === 0) {
    lines.push("No unhandled comments this round.");
  } else {
    lines.push("| id | author | severity | basis | anchored |");
    lines.push("|---|---|---|---|---|");
    for (const comment of input.result.comments) {
      lines.push(
        `| ${comment.id} | ${comment.author}${comment.authorIsBot ? " (bot)" : ""} | ${comment.severity} | ${
          comment.severityBasis
        } | ${comment.path === null ? "pull request" : `${comment.path}${comment.line === null ? "" : `:${comment.line}`}`} |`,
      );
    }
  }
  lines.push("");
  lines.push(`### Filtered (${input.result.skipped.length})`);
  lines.push("");
  if (input.result.skipped.length === 0) {
    lines.push("Nothing was filtered.");
  } else {
    for (const skip of input.result.skipped) {
      lines.push(`- ${skip.id} (${skip.author}) — ${skip.reason}: ${skip.detail}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : null;
}

function numberProperty(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function authorLogin(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const user = (value as Record<string, unknown>)["user"];
  return stringProperty(user, "login") ?? "unknown";
}

/**
 * Whether the author is a bot — recorded, never acted on.
 *
 * Both signals are read because GitHub reports them inconsistently: the App
 * identity carries `type: "Bot"`, and the login carries the `[bot]` suffix. A
 * report that said "3 comments" without saying two were CodeRabbit's is a report
 * a reader will misjudge; a FILTER on this field would be the thing the criterion
 * forbids.
 */
function authorIsBot(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const user = (value as Record<string, unknown>)["user"];
  if (stringProperty(user, "type") === "Bot") return true;
  return (stringProperty(user, "login") ?? "").endsWith("[bot]");
}

/** Logins compare case-insensitively, and `x[bot]` is the same actor as `x`. */
function normaliseLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}
