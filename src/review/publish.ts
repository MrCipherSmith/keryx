// Terminal publication of a managed review. It runs the readiness checklist, shows the body, and posts nothing a
// failing checklist has not been allowed to post as a "Partial review".

import { readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { firstLineSaysMoved, isPrBound, type PrSnapshot } from "./complete-head-gate";
import { beginPublicationReceipt, confirmPublicationReceipt, dropPublicationReceipt, headMovedLine, publicationMarker, readPublicationReceipt, receiptPublished } from "./publication-guard";
import { readRunProfile } from "./run-profile";
import { publicProjectReport } from "./report-overlay";
import { renderRoundBlock, ROUND_BLOCK_VERSION, type RoundBlock, type RoundBlockFinding } from "./pr-comments";
import { findingStatus, quoteSha256, readRoundNumber } from "./round-record";
import { recordFinishedRound } from "./round-registry";
import { computeVerdict, type VerdictFinding } from "./verdict";
import { computeReadiness, failingItems, readinessRefusal, type ReadinessOptions, type ReadinessReport } from "./readiness";
import { cardPressFields, type CardPress, type ConfirmedVia, type ManagedReviewManifest } from "./types";

export const REVIEW_EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** `url`: where GitHub put the review. `uncertain`: the request may have landed and its answer was lost. */
export type PostResult = { ok: boolean; detail: string; url?: string | undefined; uncertain?: boolean | undefined };

export type PublishOptions = {
  event?: ReviewEvent | undefined;
  partial?: boolean | undefined;
  readiness?: ReadinessOptions | undefined;
  /** Posts the review to the pull request, pinned to `commitId` when one is given. */
  post: (ref: string, event: ReviewEvent, body: string, commitId?: string) => Promise<PostResult>;
  /**
   * After an earlier publish of this package ended with an unknown result: the URL of the review carrying `marker`,
   * undefined when there is none, null when it cannot be told. Without it such a package stays refused.
   */
  findPublished?: ((ref: string, marker: string) => Promise<string | undefined | null>) | undefined;
  /**
   * The Desktop Attempt this package is registered as (./session-attempt.ts): its directory holds the receipt and the
   * lock Desktop's `desk-publish` also uses, and its id is the marker, so either path refuses what the other posted.
   */
  publication?: { directory: string; id: string } | undefined;
  /**
   * The round of the same Review that follows this package's Attempt, if any. Desktop refuses to publish an Attempt a
   * later round superseded (that round may already cover the new head), and so does the session path.
   */
  laterRound?: (() => Promise<number | undefined>) | undefined;
  /**
   * Whether the reviewed commit is still in the pull request's history (GitHub reports the current head ahead of it).
   * A review of a moved head is published as is only then, as Desktop does; without the seam GitHub's own refusal of an
   * unknown `commit_id` is the check.
   */
  reviewedHeadInPull?: ((ref: string, reviewed: string, current: string) => Promise<HeadInPull>) | undefined;
  /** Shows the body to the operator and answers whether to post it. */
  confirm: (body: string, ref: string, event: ReviewEvent) => Promise<boolean>;
  now?: (() => Date) | undefined;
  /** Set when the operator's yes came from a card instead of the terminal prompt; recorded in published.json. */
  confirmedVia?: ConfirmedVia | undefined;
} & CardPress;

/** Whether the reviewed commit is still in the pull request: `skip` when the ref cannot be compared (then GitHub's own
 * check of `commit_id` decides), `unknown` when GitHub did not answer. */
export type HeadInPull = "yes" | "no" | "unknown" | "skip";

export type PublishResult = { readiness: ReadinessReport; body: string; event: ReviewEvent; partial: boolean; posted: boolean; url?: string | undefined; registryWarning?: string | undefined };

const FULL_SHA = /^[0-9a-f]{40}$/i;
const sameCommit = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The pull request as the tracker reports it; undefined when no tracker was given or it could not say. */
async function readPullRequest(options: PublishOptions, ref: string): Promise<PrSnapshot | undefined> {
  const lookup = options.readiness?.prLookup;
  if (lookup === undefined) return undefined;
  const pr = await lookup(ref).catch(() => null);
  return pr === null || !pr.exists ? undefined : pr;
}

/** A merged or closed pull request takes no review. */
function refuseClosed(pr: PrSnapshot | undefined, ref: string): void {
  const state = typeof pr?.state === "string" ? pr.state.toUpperCase() : "";
  if (state === "MERGED" || state === "CLOSED") throw new Error(`The pull request ${ref} is ${state.toLowerCase()}; a review cannot be published to it. Save the report locally instead.`);
}

/** The PR's current head when it moved away from the reviewed one; both must be full commit SHAs to tell. */
function movedHead(reviewed: string | null, pr: PrSnapshot | undefined): string | undefined {
  const current = typeof pr?.headSha === "string" ? pr.headSha : "";
  return reviewed !== null && FULL_SHA.test(reviewed) && FULL_SHA.test(current) && !sameCommit(reviewed, current) ? current : undefined;
}

/** The marker key of a session package: its review id and round, reduced to characters a comment cannot break out of. */
export function sessionPublicationId(reviewId: string, round: number): string {
  return `${reviewId}#r${round}`.replace(/[^\w.#:-]/g, "_");
}

export function reviewEvent(value: string | undefined): ReviewEvent {
  const wanted = (value ?? "COMMENT").trim().toUpperCase();
  const found = REVIEW_EVENTS.find((event) => event === wanted);
  if (found === undefined) throw new Error(`--event must be one of ${REVIEW_EVENTS.join(", ")}, got "${value}".`);
  return found;
}

/** What the posted page says about itself when the checklist did not pass: each failing item and what it leaves uncovered. */
export function partialPublishHeader(readiness: ReadinessReport): string[] {
  const failing = failingItems(readiness);
  return [
    `**Partial review.** This review did not pass its readiness checklist (${failing.length} item(s) failing); what follows does not cover the whole change.`,
    ...failing.map((item) => `- ${item.id}: ${item.evidence}`),
    "",
  ];
}

/** Security review M1: an unattended round says so at the top of what it posts, before anything else is read. */
function runModeHeader(packageDir: string): string {
  const profile = readRunProfile(packageDir);
  if (profile?.mode !== "unattended") return "";
  return `**Unattended review** (${profile.declaredVia}): nobody was at the keyboard; a mutation pass may be recorded as Not run.\n\n`;
}

/** The most a posted body may hold. GitHub refuses a review body over 65536 characters; this leaves room for headers. */
export const PUBLISHED_BODY_LIMIT = 60_000;

const ID_CHAR = "[A-Za-z0-9_-]";

/** Whether the report names this id as a whole id: `F-1` is not named by `F-12` or `XF-1`. */
export function mentionsFindingId(report: string, id: string): boolean {
  if (id === "") return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${ID_CHAR})${escaped}(?!${ID_CHAR})`).test(report);
}

function minorsLeftOut(count: number): string {
  return `- … ${count} more minor finding(s) — see verdict-interim.md / \`keryx review verdict\``;
}

/**
 * Owner decision (2026-10-16): minor findings are listed one by one in what is posted, not only counted. Each open minor
 * the report does not already name by id is appended under "Minor findings to address" (id, file:line, problem).
 * The section fits in `budget` characters: the list is cut where it would not, and the rest is counted on one line.
 */
export function minorSection(minors: readonly VerdictFinding[], report: string, budget: number = PUBLISHED_BODY_LIMIT): string {
  const missing = minors.filter((finding) => !mentionsFindingId(report, finding.id));
  if (missing.length === 0) return "";
  const lines = missing.map((finding) => `- ${finding.id}${finding.location === undefined ? "" : ` \`${finding.location}\``} (${finding.reviewer}): ${finding.problem}`);
  const render = (kept: readonly string[]): string => {
    const rest = lines.length - kept.length;
    return `\n## Minor findings to address\n\n${[...kept, ...(rest > 0 ? [minorsLeftOut(rest)] : [])].join("\n")}\n`;
  };
  const full = render(lines);
  if (full.length <= budget) return full;
  // render(kept) is the heading, each kept line plus "\n", the count line plus "\n", and the leading "\n".
  const fixed = render([]).length - minorsLeftOut(lines.length).length;
  let used = 0;
  let kept = 0;
  while (kept < lines.length && fixed + used + lines[kept]!.length + 1 + minorsLeftOut(lines.length - kept - 1).length <= budget) {
    used += lines[kept]!.length + 1;
    kept += 1;
  }
  const cut = render(lines.slice(0, kept));
  return cut.length <= budget ? cut : "";
}

/** Every package with a run profile names its run mode at the foot of the posted body. */
function runModeFooter(packageDir: string): string {
  const profile = readRunProfile(packageDir);
  return profile === undefined ? "" : `\n_run mode: ${profile.mode} (${profile.declaredVia})_\n`;
}

/** The most the round block may add to a posted body; findings past it are counted in `truncated`. */
export const ROUND_BLOCK_LIMIT = 4_000;

/**
 * Flow 458 AC2: the hidden machine-readable round block for a posted body. It holds only what the body already says —
 * a finding is listed only when the body names its id, its file only when the body prints it, its line only when the
 * body prints `file:line`, a symbol only when the body names it, and a quote only as its sha256 — so the block tells a
 * reader of the pull request nothing the review did not.
 */
export function buildRoundBlock(input: { body: string; round: number; reviewId: string; reviewedHead: string | null; findings: readonly unknown[] }): RoundBlock {
  const listed: RoundBlockFinding[] = [];
  for (const entry of input.findings) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !mentionsFindingId(input.body, raw.id)) continue;
    const file = typeof raw.file === "string" && raw.file !== "" && input.body.includes(raw.file) ? raw.file : undefined;
    const line = file !== undefined && typeof raw.line === "number" && (input.body.includes(`${file}:${raw.line}`) || input.body.includes(`${file}#L${raw.line}`)) ? raw.line : undefined;
    const quote = typeof raw.quote === "string" && raw.quote.trim() !== "" ? raw.quote : undefined;
    const symbol = quote === undefined && typeof raw.symbol === "string" && raw.symbol !== "" && input.body.includes(raw.symbol) ? raw.symbol : undefined;
    const severity = typeof raw.severity === "string" && ["blocker", "major", "minor", "info"].includes(raw.severity) ? (raw.severity as RoundBlockFinding["severity"]) : "info";
    listed.push({
      id: raw.id,
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      ...(quote === undefined ? {} : { quoteSha256: quoteSha256(quote) }),
      ...(symbol === undefined ? {} : { symbol }),
      severity,
      status: findingStatus(raw),
    });
  }
  const base = { v: ROUND_BLOCK_VERSION, round: input.round, reviewId: input.reviewId, reviewedHead: input.reviewedHead } as const;
  let kept = listed;
  while (kept.length > 0 && renderRoundBlock({ ...base, findings: kept, truncated: listed.length - kept.length }).length > ROUND_BLOCK_LIMIT) kept = kept.slice(0, -1);
  return { ...base, findings: kept, ...(kept.length < listed.length ? { truncated: listed.length - kept.length } : {}) };
}

export async function publishReview(packageDir: string, options: PublishOptions): Promise<PublishResult> {
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(packageDir, "manifest.json"), undefined);
  if (manifest === undefined) throw new Error(`Managed review package has no readable manifest.json: ${packageDir}`);
  if (!isPrBound(manifest.target)) {
    throw new Error(`Review ${manifest.reviewId} is not bound to a pull request (target ${manifest.target.kind} ${manifest.target.ref}); there is nothing to publish to.`);
  }
  const event = options.event ?? "COMMENT";
  const reviewedHead = manifest.target.head ?? null;
  const pr = await readPullRequest(options, manifest.target.ref);
  refuseClosed(pr, manifest.target.ref);
  // Owner decision D1: a review of a commit the pull request has moved past is published only as a Comment.
  const moved = movedHead(reviewedHead, pr);
  if (moved !== undefined && event !== "COMMENT") {
    throw new Error(`The pull request has moved from the reviewed commit ${reviewedHead!.slice(0, 7)} to ${moved.slice(0, 7)}. Run the update round on the new head, or publish this review as is with --event COMMENT.`);
  }
  // The same acceptance as Desktop's publish (desk-publication.ts) for the as-is variant: an Attempt a later round of its
  // Review superseded, or a commit the PR no longer contains, is never published as is for a moved head.
  if (moved !== undefined) {
    const later = await options.laterRound?.();
    if (later !== undefined) {
      throw new Error(`Round ${later} of this Review already follows this one, so it is not published as is. Publish that round, or open its update round with keryx review advance.`);
    }
    const inPull = await options.reviewedHeadInPull?.(manifest.target.ref, reviewedHead!, moved);
    if (inPull === "no") {
      throw new Error(`The reviewed commit ${reviewedHead!.slice(0, 7)} is no longer in the pull request's history (force-push or rebase). Run the update round on the new head; this review can only be saved locally.`);
    }
    if (inPull === "unknown") {
      throw new Error(`GitHub could not say whether the reviewed commit ${reviewedHead!.slice(0, 7)} is still in the pull request, so nothing was posted. Publish again when GitHub answers.`);
    }
  }
  const readiness = await computeReadiness(packageDir, options.readiness ?? {});
  const failing = failingItems(readiness);
  const partial = failing.length > 0;
  if (partial && options.partial !== true) throw new Error(readinessRefusal(readiness, "publish"));
  if (partial && event === "APPROVE") {
    throw new Error(`A partial review cannot approve: ${failing.length} readiness item(s) are failing (${failing.map((item) => item.id).join(", ")}). Use --event COMMENT or REQUEST_CHANGES, or repair the items.`);
  }
  const report = publicProjectReport(await readFile(path.join(packageDir, "report.md"), "utf8").catch(() => ""));
  if (report === "") throw new Error(`Review ${manifest.reviewId} has no report.md body to publish.`);
  // The first line names the reviewed commit; a report whose first line already passes `review complete`'s head gate keeps it.
  const movedLine = moved === undefined || firstLineSaysMoved(report, reviewedHead)
    ? "" : `${headMovedLine({ reviewedHead: reviewedHead!, currentHead: moved })}\n\n`;
  const head = `${movedLine}${partial ? `${partialPublishHeader(readiness).join("\n")}\n` : ""}${runModeHeader(packageDir)}${report}\n`;
  const foot = runModeFooter(packageDir);
  const minors = minorSection((await computeVerdict(packageDir)).minors, report, PUBLISHED_BODY_LIMIT - head.length - foot.length - ROUND_BLOCK_LIMIT);
  const visible = `${head}${minors}${foot}`;
  const findings = await readJsonFileOr<unknown>(path.join(packageDir, "findings.json"), []);
  const roundBlock = buildRoundBlock({ body: visible, round: readRoundNumber(packageDir) ?? 1, reviewId: manifest.reviewId, reviewedHead, findings: Array.isArray(findings) ? findings : [] });
  const record = options.publication;
  const receiptDir = record?.directory ?? packageDir;
  const marker = publicationMarker(record?.id ?? sessionPublicationId(manifest.reviewId, roundBlock.round));
  const body = `${visible}\n${renderRoundBlock(roundBlock)}\n\n${marker}\n`;
  const ref = manifest.target.ref;
  // Every receipt write goes to the Attempt's directory (Desktop's) and to the package's own, so neither a deleted Attempt
  // nor a later registration loses a publication.
  const receiptDirs = [...new Set([receiptDir, packageDir])];
  const each = (write: (dir: string) => Promise<void>) => Promise.all(receiptDirs.map(write));
  // Shared with Desktop (./publication-guard.ts): one publication per package, guarded by a receipt and the marker. The
  // package's lock is always taken first, so two session publishers serialize whichever Attempt each one resolved.
  const locked = <T>(fn: () => Promise<T>): Promise<T> => withFileLock(path.join(packageDir, "publication.lock"),
    () => receiptDir === packageDir ? fn() : withFileLock(path.join(receiptDir, "publication.lock"), fn));
  const url = await locked(async () => {
    // A package published before it was registered keeps its receipt beside it: both places are read.
    const receipts = await Promise.all(receiptDirs.map((dir) => readPublicationReceipt(dir)));
    const receipt = receipts.find(receiptPublished) ?? receipts.find((item) => item !== undefined);
    if (receiptPublished(receipt)) throw new Error(`Review ${manifest.reviewId} round ${roundBlock.round} has already been published${receipt!.url === undefined ? "" : `: ${receipt!.url}`}.`);
    if (receipt !== undefined) {
      const found = await options.findPublished?.(ref, marker);
      if (typeof found === "string") {
        await each((dir) => confirmPublicationReceipt(dir, found));
        throw new Error(`Review ${manifest.reviewId} round ${roundBlock.round} has already been published: ${found}.`);
      }
      throw new Error(`A previous publish of review ${manifest.reviewId} round ${roundBlock.round} has an unknown result. Check the pull request before sending another review; if it is not there, remove ${receiptDirs.map((dir) => path.join(dir, "publication-receipt.json")).join(" and ")} and publish again.`);
    }
    if (!(await options.confirm(body, ref, event))) return null;
    // The operator read the body for the head shown; a push while they read makes it stale.
    if (options.readiness?.prLookup !== undefined) {
      const now = await readPullRequest(options, ref);
      // Only a pull request that was read before the yes can be missed after it; a tracker that never answers is no check.
      if (pr !== undefined && now === undefined) {
        throw new Error("The pull request could not be read again after the review was confirmed, so nothing was posted. Publish again when GitHub answers.");
      }
      refuseClosed(now, ref);
      const before = pr?.headSha ?? null;
      const after = now?.headSha ?? null;
      if (before !== null && (after === null || !sameCommit(before, after))) {
        throw new Error(`stale: The pull request head changed while the review was being confirmed (${before.slice(0, 7)} → ${(after ?? "unknown").slice(0, 7)}). Publish again to see the review for the current head.`);
      }
    }
    const commitId = reviewedHead !== null && FULL_SHA.test(reviewedHead) ? reviewedHead : undefined;
    await each(beginPublicationReceipt);
    const result = await options.post(ref, event, body, commitId);
    if (!result.ok) {
      if (result.uncertain === true) {
        throw new Error(`The review could not be confirmed (${result.detail}). Check the pull request before publishing again.`);
      }
      await each(dropPublicationReceipt);
      throw new Error(`GitHub refused the review: ${result.detail}`);
    }
    // Desktop counts a receipt as published only with a URL: without GitHub's, the pull request's own stands in.
    const posted = result.url ?? (/^https:\/\/github\.com\//.test(ref) ? ref : undefined);
    await each((dir) => confirmPublicationReceipt(dir, posted));
    return posted ?? "";
  });
  if (url === null) return { readiness, body, event, partial, posted: false };
  await writeFileAtomic(
    path.join(packageDir, "published.json"),
    `${JSON.stringify({ pr: ref, reviewId: manifest.reviewId, head: reviewedHead, round: roundBlock.round, event, partial, failing: failing.map((item) => item.id), time: (options.now?.() ?? new Date()).toISOString(), ...(url === "" ? {} : { url }), ...(moved === undefined ? {} : { prHead: moved }), ...(options.confirmedVia === undefined ? {} : { confirmedVia: options.confirmedVia }), ...cardPressFields(options) }, null, 2)}\n`,
  );
  // Flow 458: keryx's own record that it finished (and posted) this round, outside the repository (./round-registry.ts).
  const registered = recordFinishedRound(packageDir, "publish");
  return { readiness, body, event, partial, posted: true, ...(url === "" ? {} : { url }), ...(registered.error === undefined ? {} : { registryWarning: `round not recorded in the local round registry: ${registered.error}` }) };
}
