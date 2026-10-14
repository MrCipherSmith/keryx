import type { ManagedReviewManifest } from "./types";

export type PrSnapshot = { exists: boolean; state?: string | null | undefined; headSha?: string | null | undefined };
export type PrLookup = (ref: string) => Promise<PrSnapshot | null>;

const SAYS_SO = /\b(merged|moved|advanced|stale|superseded|closed|force-pushed|no longer)\b/i;

const sameCommit = (a: string, b: string): boolean => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
};

/**
 * `keryx review complete` on a PR-bound package: has the PR moved on since the round?
 *
 * A merged PR or a moved head means the report describes code that is no longer
 * what the PR holds, and a reader who opens it cold cannot tell. It is not
 * refused outright, because a round on a merged PR is still worth closing — it
 * is refused until the report's first line names the SHA that was reviewed and
 * says the PR moved. A tracker that cannot be reached is a warning: the gate
 * must not make an offline close impossible.
 */
export async function completeHeadGate(input: {
  manifest: Pick<ManagedReviewManifest, "target">;
  report: string;
  lookup: PrLookup;
}): Promise<{ warnings: string[] }> {
  const { target } = input.manifest;
  if (target.kind !== "pr") return { warnings: [] };
  let pr: PrSnapshot | null;
  try { pr = await input.lookup(target.ref); }
  catch (error) { return { warnings: [`could not read the PR state for ${target.ref} (${error instanceof Error ? error.message : String(error)}); the head and merge check was skipped`] }; }
  if (pr === null || !pr.exists) return { warnings: [`could not read the PR state for ${target.ref}; the head and merge check was skipped`] };

  const reviewed = target.head ?? null;
  const merged = typeof pr.state === "string" && pr.state.toUpperCase() === "MERGED";
  const prHead = typeof pr.headSha === "string" && pr.headSha !== "" ? pr.headSha : null;
  const moved = reviewed !== null && prHead !== null && !sameCommit(reviewed, prHead);
  if (!merged && !moved) return { warnings: [] };

  const what = [merged ? "the PR is merged" : undefined, moved ? `the PR head moved (reviewed ${reviewed!.slice(0, 7)}, now ${prHead!.slice(0, 7)})` : undefined].filter(Boolean).join(" and ");
  const first = input.report.split(/\r?\n/).find((line) => line.trim() !== "" && !/^\s*<!--.*-->\s*$/.test(line)) ?? "";
  const names = reviewed === null ? /\b[0-9a-f]{7,40}\b/i.test(first) : first.toLowerCase().includes(reviewed.slice(0, 7).toLowerCase());
  if (names && SAYS_SO.test(first)) return { warnings: [] };
  throw new Error(
    `Cannot complete managed review; ${what}. The report's first line must name the reviewed SHA${reviewed === null ? "" : ` (${reviewed.slice(0, 7)})`} and say the PR moved, for example: "Reviewed ${(reviewed ?? "<sha>").slice(0, 7)} — the PR has since ${merged ? "merged" : "moved on"}."`,
  );
}
