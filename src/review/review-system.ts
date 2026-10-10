import type { ApprovalMeta } from "../commands/agent";

export type ReviewSystem = "inherit" | "review-auto";

export const ENV_REVIEW_SYSTEM = "KERYX_REVIEW_SYSTEM";

let current: ReviewSystem = "inherit";

export function parseReviewSystem(value: string | undefined): ReviewSystem | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "review-auto") return "review-auto";
  if (v === "inherit" || v === "default") return "inherit";
  return undefined;
}

export function setReviewSystem(value: ReviewSystem): void {
  current = value;
}

export function getReviewSystem(env: Record<string, string | undefined> = process.env): ReviewSystem {
  if (current === "review-auto") return "review-auto";
  return parseReviewSystem(env[ENV_REVIEW_SYSTEM]) ?? "inherit";
}

export function reviewAutoActive(env: Record<string, string | undefined> = process.env): boolean {
  return getReviewSystem(env) === "review-auto";
}

const REVIEW_AUTO_PHRASE =
  /review-auto|автоматическ[а-яё]*\s+(?:код-?\s*)?ревью|ревью\s+автоматическ[а-яё]*|автоматическ[а-яё]*\s+review|automatic(?:ally)?\s+(?:code\s+)?review|auto[- ]review/i;

/** True when the operator's own line asks for an automatic review. Only ever fed the operator's text, never tool output. */
export function asksForReviewAuto(userLine: string): boolean {
  return REVIEW_AUTO_PHRASE.test(userLine);
}

/**
 * Whether review-auto answers an approval question itself. A bounded reviewer child is granted even after
 * untrusted content (it has no shell); any other tool only when no floor applies: destructive, credential,
 * publish-lease, hook-tightened and untrusted-origin calls still reach a human.
 */
export function reviewAutoGrants(tool: string, meta: ApprovalMeta | undefined): boolean {
  if (meta === undefined) return false;
  if (meta.destructive || meta.credentials === true || meta.publishLease === true || meta.hookAsk === true) return false;
  if (meta.alwaysAsk === true) return false;
  if (tool === "spawn_subagent") return true;
  return meta.untrustedOrigin !== true;
}
