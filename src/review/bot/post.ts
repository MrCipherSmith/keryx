// `keryx review bot post`: turn one managed review into ONE pull request review. The default is
// a dry run that prints the payload; only `send` writes to GitHub, and only after the pull
// request is confirmed open, in this repository, and still at the commit that was reviewed.

import { callGitHub, shaMatchesHead, type GitHubPort } from "../pr-comments";
import type { StructuredReviewFinding } from "../types";
import { checkPullOpen, checkSameRepo, readPullFacts } from "./fork-guard";
import { loadReviewPackage } from "./packages";
import { screenCommentBody, screenComments } from "./redaction";
import { gitDiff, readBotState, writeBotState, type BotDiffFacts } from "./run";

export type DiffHunks = Map<string, Set<number>>;

export function parseDiffHunks(diff: string): DiffHunks {
  return scanDiff(diff).hunks;
}

export function parseDiffFiles(diff: string): Set<string> {
  return scanDiff(diff).files;
}

function scanDiff(diff: string): { hunks: DiffHunks; files: Set<string> } {
  const hunks: DiffHunks = new Map();
  const files = new Set<string>();
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
    if (line.startsWith("--- ")) {
      const source = line.slice(4).split("\t")[0] ?? "";
      if (source !== "/dev/null") files.add(source.replace(/^a\//, ""));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).split("\t")[0] ?? "";
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (file !== null) files.add(file);
      continue;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLine = Number(header[2]);
      newLeft = header[3] === undefined ? 1 : Number(header[3]);
    }
  }
  return { hunks, files };
}

export type ReviewItem = { id: string; file: string | null; line: number | null; body: string };
export type ReviewComment = { path: string; line: number; side: "RIGHT"; body: string };
export type ReviewPayload = { commit_id: string; event: "COMMENT"; body: string; comments: ReviewComment[] };

function isInline(item: ReviewItem, hunks: DiffHunks): boolean {
  return item.file !== null && item.line !== null && hunks.get(item.file)?.has(item.line) === true;
}

function bodySection(item: ReviewItem): string {
  const where = item.file === null ? "" : item.line === null ? `${item.file}\n\n` : `${item.file}:${item.line}\n\n`;
  return `${where}${item.body}`;
}

export function botMarker(headSha: string): string {
  return `<!-- keryx-review-bot commit_id=${headSha} -->`;
}

export function coverageLine(diff: BotDiffFacts): string {
  const grouped = (value: number): string => value.toLocaleString("en-US");
  return `Only the first ${grouped(diff.bytes)} of ${grouped(diff.totalBytes)} bytes of the diff were reviewed (cap ${grouped(diff.capBytes)}); files after the cut were not reviewed.`;
}

export function buildReviewPayload(input: {
  headSha: string;
  hunks: DiffHunks;
  items: readonly ReviewItem[];
  withheld: number;
  diff?: BotDiffFacts | null | undefined;
}): ReviewPayload {
  const comments: ReviewComment[] = [];
  const inBody: ReviewItem[] = [];
  for (const item of input.items) {
    if (isInline(item, input.hunks) && item.file !== null && item.line !== null) {
      comments.push({ path: item.file, line: item.line, side: "RIGHT", body: item.body });
    } else {
      inBody.push(item);
    }
  }
  const sections = [`Automated review of ${input.headSha.slice(0, 12)}: ${input.items.length} finding(s), ${comments.length} inline.`];
  for (const item of inBody) sections.push(bodySection(item));
  if (input.diff?.truncated === true) sections.push(coverageLine(input.diff));
  if (input.withheld > 0) {
    sections.push(`${input.withheld} finding(s) withheld by the security output check and not posted.`);
  }
  return {
    commit_id: input.headSha,
    event: "COMMENT",
    body: `${sections.join("\n\n---\n\n")}\n\n${botMarker(input.headSha)}`,
    comments,
  };
}

type Withheld = { id: string; categories: string[]; reason: string };

/**
 * The payload is what becomes public, so the screen runs on the payload as assembled: each inline
 * comment and each body section (header included). A hit withholds that finding; nothing is masked.
 * Returns null when the body still fails with no finding to blame, so the caller posts nothing.
 */
async function assemblePayload(
  cwd: string,
  input: { headSha: string; hunks: DiffHunks; items: readonly ReviewItem[]; withheld: Withheld[]; diff: BotDiffFacts | null },
): Promise<{ payload: ReviewPayload; items: ReviewItem[]; withheld: Withheld[] } | null> {
  let items = [...input.items];
  const withheld = [...input.withheld];
  for (let pass = 0; pass < 2; pass += 1) {
    const payload = buildReviewPayload({ headSha: input.headSha, hunks: input.hunks, items, withheld: withheld.length, diff: input.diff });
    const bad = new Map<string, Withheld>();
    for (const item of items) {
      const verdict = await screenCommentBody(cwd, isInline(item, input.hunks) ? item.body : bodySection(item));
      if (!verdict.ok) bad.set(item.id, { id: item.id, categories: verdict.categories, reason: verdict.reason });
    }
    if (bad.size === 0) {
      const bodyVerdict = await screenCommentBody(cwd, payload.body);
      const commentVerdicts = await Promise.all(payload.comments.map((comment) => screenCommentBody(cwd, comment.body)));
      if (bodyVerdict.ok && commentVerdicts.every((verdict) => verdict.ok)) return { payload, items, withheld };
      return null;
    }
    items = items.filter((item) => !bad.has(item.id));
    withheld.push(...bad.values());
  }
  return null;
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
      notes?: string[] | undefined;
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
  const coverage = record.diff?.truncated === true ? record.diff : null;
  if (own.length === 0 && coverage === null) {
    return { ok: true, mode: "nothing-to-post", reviewId: record.reviewId, inline: 0, inBody: 0, withheld: [] };
  }

  let diffText: string;
  try {
    diffText = await (input.getDiff ?? gitDiff)({ cwd: input.cwd, baseSha: facts.baseSha });
  } catch (error) {
    return fail("diff", error instanceof Error ? error.message : String(error));
  }
  const hunks = parseDiffHunks(diffText);
  const diffFiles = parseDiffFiles(diffText);

  // `file` is a free-form model string; only a path the diff actually contains may become a header.
  const candidates = own.map((finding) => {
    const file = finding.file ?? null;
    const known = file !== null && diffFiles.has(file);
    const derived = known && finding.locator?.state === "derived";
    return {
      id: finding.id,
      file: known ? file : null,
      line: derived ? (finding.line ?? null) : null,
      body: findingCommentBody(finding, finding.global_id ?? `${record.reviewId}#${finding.id}`),
    };
  });
  const { kept, withheld } = await screenComments(input.cwd, candidates);
  const firstPass = withheld.map((entry) => ({ id: entry.item.id, categories: entry.categories, reason: entry.reason }));
  const assembled = await assemblePayload(input.cwd, { headSha: facts.headSha, hunks, items: kept, withheld: firstPass, diff: coverage });
  if (assembled === null) return fail("post", "The assembled review failed the security output check with no single finding to withhold; nothing was posted.");
  const { payload, items, withheld: withheldOut } = assembled;
  if (items.length === 0 && coverage === null) {
    return { ok: true, mode: "nothing-to-post", reviewId: record.reviewId, inline: 0, inBody: 0, withheld: withheldOut };
  }

  const inline = payload.comments.length;
  const summary = { reviewId: record.reviewId, payload, inline, inBody: items.length - inline, withheld: withheldOut };
  if (input.send !== true) return { ok: true, mode: "dry-run", ...summary };

  const notes: string[] = [];
  const marker = botMarker(facts.headSha);
  try {
    const existing = await callGitHub(input.port, { method: "GET", path: `repos/${input.repo}/pulls/${input.number}/reviews` });
    const carried = (Array.isArray(existing) ? existing : []).some((entry) => {
      const body = (entry as { body?: unknown } | null)?.body;
      return typeof body === "string" && body.includes(marker);
    });
    if (carried) {
      return fail("already-posted", `A review carrying this bot's marker for ${facts.headSha.slice(0, 12)} is already on ${input.repo}#${input.number}; not posting a second one.`);
    }
  } catch {
    notes.push("The existing reviews could not be read, so the duplicate check was skipped.");
  }

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
  try {
    await writeBotState(input.cwd, state);
  } catch (error) {
    notes.push(`Posted, record not saved (${error instanceof Error ? error.message : String(error)}); do not post this review again.`);
  }
  return { ok: true, mode: "posted", ...summary, ...(reviewUrl !== undefined ? { reviewUrl } : {}), ...(notes.length > 0 ? { notes } : {}) };
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
  for (const note of result.notes ?? []) lines.push(note);
  if (result.mode === "dry-run" && result.payload !== undefined) lines.push("", JSON.stringify(result.payload, null, 2));
  return `${lines.join("\n")}\n`;
}
