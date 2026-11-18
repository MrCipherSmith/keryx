import type { PrInfo } from "../platform/commands";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The tooltip that spells the CI rollup out ("CI: 2 failed, 14 passed"); `null` when there are no checks. */
export function ciTitle(pr: PrInfo): string | null {
  if (pr.ci === "none") return null;
  const parts = [
    pr.checksFailed > 0 ? `${pr.checksFailed} failed` : null,
    pr.checksPending > 0 ? `${pr.checksPending} running` : null,
    pr.checksPassed > 0 ? `${pr.checksPassed} passed` : null,
  ].filter(Boolean);
  return `CI: ${parts.join(", ")}`;
}

export function threadsTitle(n: number): string {
  return `${plural(n, "unresolved review thread", "unresolved review threads")}`;
}

export const CHANGES_REQUESTED_TITLE = "Changes requested by a reviewer";

export function prTitle(pr: PrInfo): string {
  return `Pull request #${pr.number}${pr.isDraft ? " (draft)" : ""} - open in the browser`;
}

/** Same git state, to decide whether a refresh changed anything worth rendering. */
export function samePr(a: PrInfo | null, b: PrInfo | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
