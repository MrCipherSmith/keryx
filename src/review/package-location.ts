// Where a review package lives (review R3-ARCH-001, R4-ARCH-001): directly under `.metaproject/reviews/`, or
// under `.metaproject/flows/<flow>/reviews/`. The ingest's allocation, the prior-round detector (globs and disk
// scan), the "is this a real package" check, the flow review gate, the loop detector, flow spend, the arbiter log,
// the autonomous run, and ingest's lookup of verify-run records by `--review-id` ({@link packageDirById}, review
// LG5-002) take the layout from here; `resolveReviewPackagePath` (managed.ts) walks both roots with these helpers.
// Not yet routed: the TUI's flow readers (tui/jev-triage-command.ts, tui/conform-source.ts), the bot's package scan
// (bot/packages.ts) and flow-move; and the pr-comments and bot caches, which sit under the reviews root but are
// not packages.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { flowsRoot } from "../flow/store";

/** The standalone packages' root. */
export function reviewsRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "reviews");
}

/** The packages' root of one flow. */
export function flowReviewsRoot(cwd: string, flowDir: string): string {
  return path.join(flowsRoot(cwd), flowDir, "reviews");
}

/**
 * The directory of package `reviewId` (a plain directory name, never a path): the standalone one when it exists, else
 * the one under a flow's reviews root, else where a standalone package of that id is written. A flow-bound ingest
 * writes its package, and `keryx review verify-run --package` its records, under the flow (review LG5-002).
 */
export function packageDirById(cwd: string, reviewId: string): string {
  const standalone = path.join(reviewsRoot(cwd), reviewId);
  if (existsSync(standalone)) return standalone;
  return flowDirs(cwd).map((flowDir) => path.join(flowReviewsRoot(cwd, flowDir), reviewId)).find((dir) => existsSync(dir)) ?? standalone;
}

/** The flow directories of the checkout; none when there is no flows root. */
function flowDirs(cwd: string): string[] {
  try {
    return readdirSync(flowsRoot(cwd));
  } catch {
    return [];
  }
}

/** Every package's manifest, as git pathspec globs relative to the checkout. */
export const REVIEW_PACKAGE_MANIFEST_GLOBS: readonly string[] = [
  path.posix.join(".metaproject", "reviews", "*", "manifest.json"),
  path.posix.join(".metaproject", "flows", "*", "reviews", "*", "manifest.json"),
];

/**
 * Whether `dir` is a real review package of the checkout at `projectRoot` (review SEC2-001): a directory holding a
 * manifest.json whose real path sits directly under {@link reviewsRoot} or a {@link flowReviewsRoot}. A directory
 * nested inside a package, or a symlink into one, is not: an agent can write such a directory (apply_patch into the
 * bound package is approved), and `--prior` accepts any directory with a manifest.
 */
export function isReviewPackageDir(dir: string, projectRoot: string): boolean {
  let real: string;
  let root: string;
  try {
    real = realpathSync(dir);
    root = realpathSync(projectRoot);
  } catch {
    return false;
  }
  if (!existsSync(path.join(real, "manifest.json"))) return false;
  const parent = path.dirname(real);
  if (parent === reviewsRoot(root)) return true;
  return parent === flowReviewsRoot(root, path.basename(path.dirname(parent))) && path.dirname(path.dirname(parent)) === flowsRoot(root);
}
