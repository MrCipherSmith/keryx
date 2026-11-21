import { errMessage } from "../lib/format";
import type { BadgeCard, BadgeSnapshot } from "../../../../src/review/board-badges";
import type { DeskRunKey } from "../../../../src/review/desk-run-types";
import { invoke } from "./backend";
import type { ReviewBoardSnapshot, ReviewBoardState } from "../review/types";
import type { ReviewDetailSnapshot } from "../../../../src/review/board-detail-types";

import { ReviewReadLane } from "./reviewReadLane";

const repositories = new ReviewReadLane<string[]>();
const boards = new ReviewReadLane<ReviewBoardSnapshot>();
const details = new ReviewReadLane<ReviewDetailSnapshot>();

export function fetchReviewRepositories(cwd: string): Promise<string[]> {
  return repositories.read(cwd, () => invoke("review_board", { cwd, repositoriesOnly: true }));
}

function assertProtocol(response: { version: number } | null) {
  if (response?.version !== 1) {
    throw new Error("configuration: This Keryx CLI returned an incompatible Review response. Check the CLI version in Settings.");
  }
}

export async function collectBoardPages(readPage: (cursor: string | null, repo?: string) => Promise<ReviewBoardSnapshot>, repo?: string, signal?: AbortSignal): Promise<ReviewBoardSnapshot> {
  let first: ReviewBoardSnapshot | undefined;
  const cards = new Map<number, ReviewBoardSnapshot["cards"][number]>();
  const warnings = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pieces: { first: NonNullable<ReviewBoardSnapshot["cardPart"]>; texts: string[] } | undefined;
  for (;;) {
    if (signal?.aborted) throw new Error("unavailable: Board read closed.");
    let page: ReviewBoardSnapshot;
    try { page = await readPage(cursor, first?.repo ?? repo); } catch (error) {
      if (!first || !/^unavailable:/i.test(errMessage(error))) throw error;
      warnings.add("Only part of the repository could be loaded. Refresh to retry.");
      break;
    }
    assertProtocol(page);
    if (!page.viewer || !page.repositoryId || (first && (first.viewer !== page.viewer || first.repositoryId !== page.repositoryId || first.repo !== page.repo))) {
      throw new Error("access: GitHub account or repository changed. Refresh the board.");
    }
    first ??= page;
    const part = page.cardPart;
    if (part) {
      if (part.index === 0 && !pieces) pieces = {first: part, texts: []};
      if (!pieces || pieces.first.digest !== part.digest || pieces.texts.length !== part.index || page.cards.length) {
        warnings.add("The pull request changed during pagination. Refresh to retry.");
        break;
      }
      pieces.texts.push(part.text);
      if (part.last) {
        const card = JSON.parse(pieces.texts.join("")) as ReviewBoardSnapshot["cards"][number];
        if (pieces.first.localReview) card.localReview = pieces.first.localReview;
        if (pieces.first.addressedReplyIds) card.addressedReplyIds = pieces.first.addressedReplyIds;
        cards.set(card.number, card);
        pieces = undefined;
      }
    } else if (pieces) {
      warnings.add("The pull request changed during pagination. Refresh to retry.");
      break;
    }
    for (const card of page.cards) cards.set(card.number, card);
    for (const warning of page.warnings) warnings.add(warning);
    cursor = page.nextCursor ?? null;
    if (!cursor) break;
    if (cursors.has(cursor)) {
      warnings.add("Only part of the repository could be loaded. Refresh to retry.");
      break;
    }
    cursors.add(cursor);
  }
  if (pieces) warnings.add("Only part of the repository could be loaded. Refresh to retry.");
  const { replyHints, activeReviewCards, cardPart: _part, ...header } = first!;
  for (const card of activeReviewCards ?? []) {
    if (!cards.has(card.number)) cards.set(card.number, card);
  }
  for (const hint of replyHints ?? []) {
    const card = cards.get(hint.number);
    if (card?.state === "open") cards.set(card.number, { ...card, addressedReplyIds: hint.ids });
  }
  return { ...header, nextCursor: null, cards: [...cards.values()], warnings: [...warnings] };
}

function verifyProjectViewer(viewer: string, expectedViewer?: string): void {
  if (expectedViewer && viewer.toLowerCase() !== expectedViewer.toLowerCase()) {
    throw new Error("access: GitHub account changed. Open Project Settings to check the connection.");
  }
}

export function fetchReviewBoard(cwd: string, state: ReviewBoardState, repo?: string, signal?: AbortSignal, expectedViewer?: string, updatedSince?: string): Promise<ReviewBoardSnapshot> {
  return collectBoardPages(async (cursor, canonicalRepo) => {
    const page = await boards.read(JSON.stringify([cwd, expectedViewer, state, canonicalRepo, cursor, updatedSince]),
      () => invoke("review_board", { cwd, prState: state, repo: canonicalRepo, paged: true, cursor, updatedSince }));
    if (page?.viewer) verifyProjectViewer(page.viewer, expectedViewer);
    return page;
  }, repo, signal);
}

export async function fetchReviewBadges(cwd: string, key: Omit<DeskRunKey, "number">, cards: BadgeCard[]): Promise<BadgeSnapshot> {
  const combined: BadgeSnapshot = { version: 1, repositoryId: key.repositoryId, viewer: key.viewer, cards: [] };
  // Keep each CLI argument well below the OS per-argument limit even on unusually large active boards.
  for (let i = 0; i < cards.length; i += 500) {
    const revisions = cards.slice(i, i + 500).map(c => [c.number, c.baseSha, c.headSha].join(":")).join(",");
    const result = await invoke<BadgeSnapshot>("review_board", { cwd, repo: key.repo, badgeTarget: { viewer: key.viewer, repositoryId: key.repositoryId, revisions } });
    assertProtocol(result);
    if (result.viewer !== key.viewer || result.repositoryId !== key.repositoryId) throw new Error("access: GitHub account or repository changed. Refresh Review.");
    combined.cards.push(...result.cards);
  }
  return combined;
}

export async function fetchReviewDetail(cwd: string, repo: string, number: number, expectedViewer?: string): Promise<ReviewDetailSnapshot> {
  const result = await details.read(JSON.stringify([cwd, expectedViewer, repo, number]),
    () => invoke("review_board", { cwd, repo, number }));
  assertProtocol(result);
  verifyProjectViewer(result.viewer, expectedViewer);
  return result;
}
