import { createHash } from "node:crypto";
import type { ReviewBoardSnapshot } from "./board-types";

// A GitHub cursor is opaque. Our exceptional one-card continuation additionally pins the actual card
// content, so a revision or account change between short-lived CLI readers cannot splice two results.
const prefix = "!keryx-card!";
const frameSize = 2 * 1024 * 1024; // UTF-16 code units. Even escaped into an outer JSON string, a frame fits the pipe.
export function decodeBoardCursor(value?: string): { cursor: string | null; part?: { index: number; digest: string } } {
  if (!value?.startsWith(prefix)) return { cursor: value ?? null };
  const match = /^!keryx-card!(\d+)!([0-9a-f]{64})!([\s\S]*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) throw new Error("configuration: Invalid PR continuation.");
  return { cursor: match[3] || null, part: {index: Number(match[1]), digest: match[2]!} };
}

export function splitBoardCard(page: ReviewBoardSnapshot, continuation: ReturnType<typeof decodeBoardCursor>, size = frameSize): ReviewBoardSnapshot {
  const card = page.cards[0];
  if (!card || page.cards.length !== 1) throw new Error("unavailable: The PR changed during pagination. Refresh to retry.");
  // The first part carries optional live enrichment. Subsequent reads verify the stable GitHub
  // card, without restarting notifications or rejecting a board when only a local badge advances.
  const { localReview, addressedReplyIds, ...github } = card;
  const text = JSON.stringify(github);
  const digest = createHash("sha256").update(text).digest("hex");
  const index = continuation.part?.index ?? 0;
  if ((continuation.part && continuation.part.digest !== digest) || index * size >= text.length)
    throw new Error("unavailable: The PR changed during pagination. Refresh to retry.");
  const end = Math.min((index+1)*size, text.length);
  const last = end === text.length;
  const part = { digest, index, last, text: text.slice(index*size, end),
    ...(index === 0 && localReview ? {localReview} : {}), ...(index === 0 && addressedReplyIds ? {addressedReplyIds} : {}) };
  return { ...page, cards: [], cardPart: part, nextCursor: last ? page.nextCursor ?? null : prefix+(index+1)+"!"+digest+"!"+(continuation.cursor ?? "") };
}
