import { invoke } from "./backend";
import type { ReviewBoardSnapshot, ReviewBoardState } from "../review/types";
import type { ReviewDetailSnapshot } from "../../../../src/review/board-detail-types";

export function fetchReviewRepositories(cwd: string): Promise<string[]> {
  return invoke("review_board", { cwd, repositoriesOnly: true });
}

function assertProtocol(response: { version: number } | null) {
  if (response?.version !== 1) {
    throw new Error("configuration: This Keryx CLI returned an incompatible Review response. Check the CLI version in Settings.");
  }
}

export async function fetchReviewBoard(cwd: string, state: ReviewBoardState, repo?: string): Promise<ReviewBoardSnapshot> {
  const result = await invoke<ReviewBoardSnapshot>("review_board", { cwd, prState: state, repo });
  assertProtocol(result);
  return result;
}

export async function fetchReviewDetail(cwd: string, repo: string, number: number): Promise<ReviewDetailSnapshot> {
  const result = await invoke<ReviewDetailSnapshot>("review_board", { cwd, repo, number });
  assertProtocol(result);
  return result;
}
