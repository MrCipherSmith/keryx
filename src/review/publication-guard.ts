// What the two review publish paths share (flow 521 T7, divergence-map.md rows 1–4): the hidden duplicate marker, the
// publication receipt, and the first line of a review published as is after the pull request's head moved (D1).
// Desktop (`desk-publication.ts`) and the session (`publish.ts`) both write and read these through this module.

import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { PUBLICATION_RECEIPT } from "./desk-publication-types";

/**
 * The hidden marker at the end of a posted review body. A lost response is resolved by finding it among the PR's
 * reviews. The text keeps Desktop's original prefix so reviews posted before the paths were shared are still found.
 */
export function publicationMarker(id: string): string {
  return `<!-- keryx-desktop-review ${id} -->`;
}

/**
 * The first body line of a review published as is for the reviewed commit after the head moved. It names the reviewed
 * commit and says the pull request moved, which is also what `keryx review complete`'s head gate asks of a report.
 */
export function headMovedLine(moved: { reviewedHead: string; currentHead: string }): string {
  return `Reviewed commit \`${moved.reviewedHead}\`. The pull request has moved to \`${moved.currentHead}\` since; ` +
    "this review does not cover the newer commits.";
}

/** `{}`: a POST was started and its result is unknown. `url` or `posted`: GitHub accepted it. */
export type PublicationReceipt = { url?: string; posted?: true };

export const receiptPath = (directory: string): string => path.join(directory, PUBLICATION_RECEIPT);

/** The receipt in `directory`, or undefined when there is none. An unreadable receipt counts as an unknown result. */
export async function readPublicationReceipt(directory: string): Promise<PublicationReceipt | undefined> {
  let raw: string;
  try {
    raw = await readFile(receiptPath(directory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return {};
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.url === "string" && record.url !== "" ? { url: record.url } : {}),
      ...(record.posted === true ? { posted: true as const } : {}),
    };
  } catch {
    return {};
  }
}

export const receiptPublished = (receipt: PublicationReceipt | undefined): boolean =>
  receipt !== undefined && (receipt.url !== undefined || receipt.posted === true);

/** Persist the intent before the network call, so a lost response never leads to a second review. */
export const beginPublicationReceipt = (directory: string): Promise<void> =>
  writeFileAtomic(receiptPath(directory), "{}", { mode: 0o600 });

/** GitHub accepted the review; `url` when it said where. */
export const confirmPublicationReceipt = (directory: string, url: string | undefined): Promise<void> =>
  writeFileAtomic(receiptPath(directory), JSON.stringify(url === undefined ? { posted: true } : { url }), { mode: 0o600 });

/** GitHub certainly did not take the review: the receipt goes, so a retry is allowed. */
export async function dropPublicationReceipt(directory: string): Promise<void> {
  await unlink(receiptPath(directory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
