// The only keryx path to GitHub for a review: it runs the readiness checklist, shows the body, and posts nothing a
// failing checklist has not been allowed to post as a "Partial review".

import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { isPrBound } from "./complete-head-gate";
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
  const body = `${partial ? `${partialPublishHeader(readiness).join("\n")}\n` : ""}${report}\n`;
  if (!(await options.confirm(body, manifest.target.ref, event))) return { readiness, body, event, partial, posted: false };
  const result = await options.post(manifest.target.ref, event, body);
  if (!result.ok) throw new Error(`GitHub refused the review: ${result.detail}`);
  await writeFileAtomic(
    path.join(packageDir, "published.json"),
    `${JSON.stringify({ pr: manifest.target.ref, event, partial, failing: failing.map((item) => item.id), time: (options.now?.() ?? new Date()).toISOString(), ...(options.confirmedVia === undefined ? {} : { confirmedVia: options.confirmedVia }) }, null, 2)}\n`,
  );
  return { readiness, body, event, partial, posted: true };
}
