// The only keryx path to GitHub for a review: it runs the readiness checklist, shows the body, and posts nothing a
// failing checklist has not been allowed to post as a "Partial review".

import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { isPrBound } from "./complete-head-gate";
import { readRunProfile } from "./run-profile";
import { computeVerdict, type VerdictFinding } from "./verdict";
import { computeReadiness, failingItems, readinessRefusal, type ReadinessOptions, type ReadinessReport } from "./readiness";
import type { ConfirmedVia, ManagedReviewManifest } from "./types";

export const REVIEW_EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export type PostResult = { ok: boolean; detail: string };

export type PublishOptions = {
  event?: ReviewEvent | undefined;
  partial?: boolean | undefined;
  readiness?: ReadinessOptions | undefined;
  /** Posts the review to the pull request. */
  post: (ref: string, event: ReviewEvent, body: string) => Promise<PostResult>;
  /** Shows the body to the operator and answers whether to post it. */
  confirm: (body: string, ref: string, event: ReviewEvent) => Promise<boolean>;
  now?: (() => Date) | undefined;
  /** Set when the operator's yes came from a card instead of the terminal prompt; recorded in published.json. */
  confirmedVia?: ConfirmedVia | undefined;
};

export type PublishResult = { readiness: ReadinessReport; body: string; event: ReviewEvent; partial: boolean; posted: boolean };

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

export async function publishReview(packageDir: string, options: PublishOptions): Promise<PublishResult> {
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(packageDir, "manifest.json"), undefined);
  if (manifest === undefined) throw new Error(`Managed review package has no readable manifest.json: ${packageDir}`);
  if (!isPrBound(manifest.target)) {
    throw new Error(`Review ${manifest.reviewId} is not bound to a pull request (target ${manifest.target.kind} ${manifest.target.ref}); there is nothing to publish to.`);
  }
  const event = options.event ?? "COMMENT";
  const readiness = await computeReadiness(packageDir, options.readiness ?? {});
  const failing = failingItems(readiness);
  const partial = failing.length > 0;
  if (partial && options.partial !== true) throw new Error(readinessRefusal(readiness, "publish"));
  if (partial && event === "APPROVE") {
    throw new Error(`A partial review cannot approve: ${failing.length} readiness item(s) are failing (${failing.map((item) => item.id).join(", ")}). Use --event COMMENT or REQUEST_CHANGES, or repair the items.`);
  }
  const report = (await readFile(path.join(packageDir, "report.md"), "utf8").catch(() => "")).trim();
  if (report === "") throw new Error(`Review ${manifest.reviewId} has no report.md body to publish.`);
  const head = `${partial ? `${partialPublishHeader(readiness).join("\n")}\n` : ""}${runModeHeader(packageDir)}${report}\n`;
  const foot = runModeFooter(packageDir);
  const minors = minorSection((await computeVerdict(packageDir)).minors, report, PUBLISHED_BODY_LIMIT - head.length - foot.length);
  const body = `${head}${minors}${foot}`;
  if (!(await options.confirm(body, manifest.target.ref, event))) return { readiness, body, event, partial, posted: false };
  const result = await options.post(manifest.target.ref, event, body);
  if (!result.ok) throw new Error(`GitHub refused the review: ${result.detail}`);
  await writeFileAtomic(
    path.join(packageDir, "published.json"),
    `${JSON.stringify({ pr: manifest.target.ref, event, partial, failing: failing.map((item) => item.id), time: (options.now?.() ?? new Date()).toISOString(), ...(options.confirmedVia === undefined ? {} : { confirmedVia: options.confirmedVia }) }, null, 2)}\n`,
  );
  return { readiness, body, event, partial, posted: true };
}
