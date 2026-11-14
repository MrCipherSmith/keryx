import type { ManagedReviewManifest } from "./types";

export type PrSnapshot = { exists: boolean; state?: string | null | undefined; headSha?: string | null | undefined };
export type PrLookup = (ref: string) => Promise<PrSnapshot | null>;

const USABLE_SHA = /^[0-9a-f]{7,40}$/i;

const PR_URL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/**
 * A package is bound to a pull request when it targets one, or when its ref IS a pull request URL under another
 * kind: `review ingest --target report --ref <PR URL>` is how a package for a PR can end up outside the `pr` kind,
 * and the head check must not depend on which kind the person typed.
 */
export const isPrBound = (target: { kind: string; ref: string }): boolean => target.kind === "pr" || PR_URL.test(target.ref);

const sameCommit = (a: string, b: string): boolean => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
};

/**
 * `keryx review complete` on a PR-bound package: has the PR moved on since the round?
 *
 * A merged PR or a moved head means the report describes code that is no longer what the PR holds, and a reader who
 * opens it cold cannot tell. The gate reports that as a `refusal`; it does not throw, because the close applies the
 * operator's readiness waivers before it refuses, and a round on a merged PR is still worth closing when the operator
 * says so (`--waive head "<operator quote>"` / the `review_waive_readiness` card). Nothing the agent writes into the
 * report lifts it. A tracker that cannot be reached is a warning: the gate must not make an offline close impossible.
 */
export type HeadGateResult = { warnings: string[]; refusal?: string | undefined };

export async function completeHeadGate(input: {
  manifest: Pick<ManagedReviewManifest, "target">;
  lookup: PrLookup;
}): Promise<HeadGateResult> {
  const { target } = input.manifest;
  if (!isPrBound(target)) return { warnings: [] };
  let pr: PrSnapshot | null;
  try { pr = await input.lookup(target.ref); }
  catch (error) { return { warnings: [`could not read the PR state for ${target.ref} (${error instanceof Error ? error.message : String(error)}); the head and merge check was skipped`] }; }
  if (pr === null || !pr.exists) return { warnings: [`could not read the PR state for ${target.ref}; the head and merge check was skipped`] };

  const recorded = target.head ?? null;
  const reviewed = recorded !== null && USABLE_SHA.test(recorded) ? recorded : null;
  const unusable = recorded !== null && reviewed === null ? [`the reviewed head recorded for ${target.ref} ("${recorded}") is not a commit SHA; the moved-head check was skipped`] : [];
  const merged = typeof pr.state === "string" && pr.state.toUpperCase() === "MERGED";
  const prHead = typeof pr.headSha === "string" && pr.headSha !== "" ? pr.headSha : null;
  const moved = reviewed !== null && prHead !== null && !sameCommit(reviewed, prHead);
  if (!merged && !moved) return { warnings: unusable };

  const what = [merged ? "the PR is merged" : undefined, moved ? `the PR head moved (reviewed ${reviewed!.slice(0, 7)}, now ${prHead!.slice(0, 7)})` : undefined].filter(Boolean).join(" and ");
  return { warnings: unusable, refusal: what };
}
