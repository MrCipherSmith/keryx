// `keryx review bot post`: turn one managed review into ONE pull request review. The default is
// a dry run that prints the payload; only `send` writes to GitHub, and only after the pull
// request is confirmed open, in this repository, and still at the commit that was reviewed.

import { callGitHub, shaMatchesHead, type GitHubPort } from "../pr-comments";
import type { StructuredReviewFinding } from "../types";
import { checkPullOpen, checkSameRepo, readPullFacts } from "./fork-guard";
import { loadReviewPackage } from "./packages";
import { screenComments } from "./redaction";
import { gitDiff, readBotState, writeBotState } from "./run";

export type DiffHunks = Map<string, Set<number>>;

export function parseDiffHunks(diff: string): DiffHunks {
  const hunks: DiffHunks = new Map();
  let file: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line[0];
      if (marker === "\\") continue;
      if (marker === "+") {
        newLeft -= 1;
        if (file !== null) {
          const lines = hunks.get(file) ?? new Set<number>();
          lines.add(newLine);
          hunks.set(file, lines);
        }
        newLine += 1;
        continue;
      }
      if (marker === "-") {
        oldLeft -= 1;
        continue;
      }
      if (marker === " ") {
        oldLeft -= 1;
        newLeft -= 1;
        if (file !== null) {
          const lines = hunks.get(file) ?? new Set<number>();
          lines.add(newLine);
          hunks.set(file, lines);
        }
        newLine += 1;
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).split("\t")[0] ?? "";
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLine = Number(header[2]);
      newLeft = header[3] === undefined ? 1 : Number(header[3]);
    }
  }
  return hunks;
}

export type ReviewItem = { id: string; file: string | null; line: number | null; body: string };
export type ReviewComment = { path: string; line: number; side: "RIGHT"; body: string };
export type ReviewPayload = { commit_id: string; event: "COMMENT"; body: string; comments: ReviewComment[] };

export function buildReviewPayload(input: {
  headSha: string;
  hunks: DiffHunks;
  items: readonly ReviewItem[];
  withheld: number;
}): ReviewPayload {
  const comments: ReviewComment[] = [];
  const inBody: ReviewItem[] = [];
  for (const item of input.items) {
    if (item.file !== null && item.line !== null && input.hunks.get(item.file)?.has(item.line) === true) {
      comments.push({ path: item.file, line: item.line, side: "RIGHT", body: item.body });
    } else {
      inBody.push(item);
    }
  }
  const sections = [`Automated review of ${input.headSha.slice(0, 12)}: ${input.items.length} finding(s), ${comments.length} inline.`];
  for (const item of inBody) {
    const where = item.file === null ? "" : item.line === null ? `${item.file}\n\n` : `${item.file}:${item.line}\n\n`;
    sections.push(`${where}${item.body}`);
  }
  if (input.withheld > 0) {
    sections.push(`${input.withheld} finding(s) withheld by the security output check and not posted.`);
  }
  return { commit_id: input.headSha, event: "COMMENT", body: sections.join("\n\n---\n\n"), comments };
}

export function findingCommentBody(finding: StructuredReviewFinding, key: string): string {
  return [
    `**${finding.severity}**: ${finding.problem}`,
    `Impact: ${finding.impact}`,
    `Suggested fix: ${finding.suggested_fix}`,
    `<!-- keryx:finding ${key} -->`,
  ].join("\n\n");
}

export type PostStage =
  | "input"
  | "pull-read"
  | "fork-guard"
  | "pull-state"
  | "review"
  | "already-posted"
  | "stale-review"
  | "sha"
  | "diff"
  | "post";

export type PostBotReviewInput = {
  cwd: string;
  repo: string;
  number: number;
  port: GitHubPort;
  send?: boolean | undefined;
  sha?: string | undefined;
  review?: string | undefined;
  getDiff?: ((input: { cwd: string; baseSha: string }) => Promise<string>) | undefined;
  now?: Date | undefined;
};

export type PostBotReviewResult =
  | {
      ok: true;
      mode: "dry-run" | "posted" | "nothing-to-post";
      reviewId: string;
      payload?: ReviewPayload | undefined;
      inline: number;
      inBody: number;
      withheld: Array<{ id: string; categories: string[]; reason: string }>;
      reviewUrl?: string | undefined;
    }
  | { ok: false; stage: PostStage; reason: string };

function fail(stage: PostStage, reason: string): PostBotReviewResult {
  return { ok: false, stage, reason };
}

export async function postBotReview(input: PostBotReviewInput): Promise<PostBotReviewResult> {
  const now = input.now ?? new Date();
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo) || !Number.isInteger(input.number) || input.number <= 0) {
    return fail("input", "Expected --repo <owner/repo> and --pr <positive number>.");
  }

  let raw: unknown;
  try {
    raw = await callGitHub(input.port, { method: "GET", path: `repos/${input.repo}/pulls/${input.number}` });
  } catch (error) {
    return fail("pull-read", `Could not read the pull request: ${error instanceof Error ? error.message : String(error)}`);
  }
  const facts = readPullFacts(raw);
  const sameRepo = checkSameRepo(facts);
  if (!sameRepo.ok) return fail("fork-guard", sameRepo.reason);
  const open = checkPullOpen(facts);
  if (!open.ok) return fail("pull-state", open.reason);
  if (facts.headSha === null || facts.baseSha === null) return fail("pull-read", "GitHub did not report the pull request's head and base commits.");

  const state = await readBotState(input.cwd, input.repo, input.number);
  const record =
    input.review !== undefined ? state.reviews.find((entry) => entry.reviewId === input.review) : state.reviews[state.reviews.length - 1];
  if (record === undefined) {
    return fail(
      "review",
      input.review !== undefined
        ? `Review ${input.review} was not produced by 'review bot run' for ${input.repo}#${input.number}.`
        : `No bot review exists for ${input.repo}#${input.number}; run 'keryx review bot run --pr ${input.number} --repo ${input.repo}' first.`,
    );
  }
  if (record.postedAt !== null) {
    return fail("already-posted", `Review ${record.reviewId} was already posted at ${record.postedAt}${record.reviewUrl !== null ? ` (${record.reviewUrl})` : ""}.`);
  }
  const reviewed = await loadReviewPackage(input.cwd, record.reviewId);
  if (reviewed === null) return fail("review", `The review package ${record.reviewId} is not on disk.`);

  const reviewedHead = reviewed.manifest.target.head ?? record.headSha;
  if (!shaMatchesHead(reviewedHead, facts.headSha)) {
    return fail(
      "stale-review",
      `Review ${record.reviewId} was made at ${reviewedHead.slice(0, 12)} but the pull request head is now ${facts.headSha.slice(0, 12)}. Run the review again.`,
    );
  }
  if (input.sha !== undefined && !shaMatchesHead(input.sha, facts.headSha)) {
    return fail("sha", `--sha ${input.sha.slice(0, 12)} is not the pull request head ${facts.headSha.slice(0, 12)}.`);
  }

  const own = reviewed.findings.filter((finding) => finding.source !== "external");
  if (own.length === 0) {
    return { ok: true, mode: "nothing-to-post", reviewId: record.reviewId, inline: 0, inBody: 0, withheld: [] };
  }

  let hunks: DiffHunks;
  try {
    hunks = parseDiffHunks(await (input.getDiff ?? gitDiff)({ cwd: input.cwd, baseSha: facts.baseSha }));
  } catch (error) {
    return fail("diff", error instanceof Error ? error.message : String(error));
  }

  const candidates = own.map((finding) => ({
    id: finding.id,
    file: finding.file ?? null,
    line: finding.line ?? null,
    body: findingCommentBody(finding, finding.global_id ?? `${record.reviewId}#${finding.id}`),
  }));
  const { kept, withheld } = await screenComments(input.cwd, candidates);
  const withheldOut = withheld.map((entry) => ({ id: entry.item.id, categories: entry.categories, reason: entry.reason }));
  if (kept.length === 0) {
    return { ok: true, mode: "nothing-to-post", reviewId: record.reviewId, inline: 0, inBody: 0, withheld: withheldOut };
  }

  const payload = buildReviewPayload({ headSha: facts.headSha, hunks, items: kept, withheld: withheld.length });
  const inline = payload.comments.length;
  const summary = { reviewId: record.reviewId, payload, inline, inBody: kept.length - inline, withheld: withheldOut };
  if (input.send !== true) return { ok: true, mode: "dry-run", ...summary };

  let response: unknown;
  try {
    response = await callGitHub(input.port, { method: "POST", path: `repos/${input.repo}/pulls/${input.number}/reviews`, body: payload });
  } catch (error) {
    return fail("post", `GitHub refused the review: ${error instanceof Error ? error.message : String(error)}`);
  }
  const url = (response as { html_url?: unknown } | null)?.html_url;
  const reviewUrl = typeof url === "string" ? url : undefined;
  record.postedAt = now.toISOString();
  record.reviewUrl = reviewUrl ?? null;
  await writeBotState(input.cwd, state);
  return { ok: true, mode: "posted", ...summary, ...(reviewUrl !== undefined ? { reviewUrl } : {}) };
}

export function renderPostSummary(result: Extract<PostBotReviewResult, { ok: true }>): string {
  const lines: string[] = [];
  if (result.mode === "nothing-to-post") {
    lines.push(`Nothing to post for ${result.reviewId}: no finding is left to say.`);
  } else {
    lines.push(
      `${result.mode === "posted" ? "Posted" : "Dry run (nothing sent; add --post to send)"}: review ${result.reviewId}, ${result.inline} inline comment(s), ${result.inBody} in the review body.`,
    );
  }
  if (result.withheld.length > 0) {
    lines.push(`Withheld ${result.withheld.length} finding(s) that failed the security output check: ${result.withheld.map((entry) => `${entry.id} (${entry.categories.join(", ")})`).join("; ")}.`);
  }
  if (result.reviewUrl !== undefined) lines.push(`Review: ${result.reviewUrl}`);
  if (result.mode === "dry-run" && result.payload !== undefined) lines.push("", JSON.stringify(result.payload, null, 2));
  return `${lines.join("\n")}\n`;
}
