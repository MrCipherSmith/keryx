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

export async function fetchReviewBoard(cwd: string, state: ReviewBoardState, repo?: string): Promise<ReviewBoardSnapshot> {
  const result = await boards.read(JSON.stringify([cwd, state, repo]),
    () => invoke("review_board", { cwd, prState: state, repo }));
  assertProtocol(result);
  return result;
}

export async function fetchReviewDetail(cwd: string, repo: string, number: number): Promise<ReviewDetailSnapshot> {
  const result = await details.read(JSON.stringify([cwd, repo, number]),
    () => invoke("review_board", { cwd, repo, number }));
  assertProtocol(result);
  return result;
}
