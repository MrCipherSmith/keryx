// Where a review package lives (review R3-ARCH-001, R4-ARCH-001): directly under `.metaproject/reviews/`, or
// under `.metaproject/flows/<flow>/reviews/`. The ingest's allocation, the prior-round detector (globs and disk
// scan), the "is this a real package" check, the flow review gate, the loop detector, flow spend, the arbiter log,
// and the autonomous run take the layout from here. A package is looked up by id in one place,
// `reviewPackagesNamed` behind `resolveReviewPackagePath` (managed.ts), which builds its paths from these roots;
// ingest binds verify-run records to the package directory it allocates, never to a lookup by id (review LG6-002).
// Not yet routed: the TUI's flow readers (tui/jev-triage-command.ts, tui/conform-source.ts), the bot's package scan
// (bot/packages.ts) and flow-move; and the pr-comments and bot caches, which sit under the reviews root but are
// not packages.

import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { flowsRoot } from "../flow/store";
import { mapBounded } from "../lib/map-bounded";

/** The standalone packages' root. */
export function reviewsRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "reviews");
}

/** The packages' root of one flow. */
export function flowReviewsRoot(cwd: string, flowDir: string): string {
  return path.join(flowsRoot(cwd), flowDir, "reviews");
}

/** The header fields of a package manifest the package scans trust: each a string when the manifest holds one. */
export type ManifestHead = { reviewId?: string | undefined; mode?: string | undefined; status?: string | undefined; flowId?: string | undefined; flowPath?: string | undefined };

/**
 * `reviewId`, `mode`, `status` and `flow.{id,path}` of the package at `packageDir`, or undefined when it has no readable
 * manifest object. The one reader of a manifest's header for the package scans (ingest allocation, the completion gate,
 * a flow's bound packages), so none of them re-declares the shape it trusts.
 */
export async function readManifestHead(packageDir: string): Promise<ManifestHead | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(packageDir, "manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
  const fields = manifest as { reviewId?: unknown; mode?: unknown; status?: unknown; flow?: unknown };
  const flow = fields.flow !== null && typeof fields.flow === "object" ? (fields.flow as { id?: unknown; path?: unknown }) : {};
  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  return { reviewId: str(fields.reviewId), mode: str(fields.mode), status: str(fields.status), flowId: str(flow.id), flowPath: str(flow.path) };
}

/** Whether a manifest's `flow` binding names the flow whose directory is `flowDir` (by its recorded path, or its id). */
function boundToFlow(head: ManifestHead, flowDir: string): boolean {
  if (head.flowPath !== undefined && path.posix.normalize(head.flowPath.split(path.sep).join("/")) === path.posix.join(".metaproject", "flows", flowDir)) return true;
  return head.flowId !== undefined && head.flowId !== "" && (flowDir === head.flowId || flowDir.startsWith(`${head.flowId}-`));
}

async function dirsUnder(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/** The standalone packages (directly under {@link reviewsRoot}) with a readable manifest, each with its head. */
export type StandalonePackages = ReadonlyArray<{ dir: string; head: ManifestHead }>;

/** At most this many standalone manifests are read at once. */
const HEAD_READ_CONCURRENCY = 16;

/**
 * Every standalone package's manifest head, read once. A pass over many flows (`keryx governance report`) reads this
 * once and hands it to each {@link flowPackageDirs} call, so it pays one read per package, not one per flow and package.
 */
export async function readStandalonePackages(cwd: string): Promise<StandalonePackages> {
  const dirs = await dirsUnder(reviewsRoot(cwd));
  const heads = await mapBounded(dirs, HEAD_READ_CONCURRENCY, readManifestHead);
  return dirs.flatMap((dir, at) => {
    const head = heads[at];
    return head === undefined ? [] : [{ dir, head }];
  });
}

/**
 * Every package directory of one flow: the directories under its {@link flowReviewsRoot}, then the packages directly
 * under {@link reviewsRoot} whose manifest is bound to the flow (`manifest.flow`). `review ingest --review-id` of a round
 * `review start` opened keeps that package where it was and binds it to the flow (flow 460 L5), so the flow's readers —
 * the loop detector (review/loop.ts), the flow review gate (flow/review-gate.ts) and flow spend (governance/spend.ts) —
 * list the flow's rounds here, all three the same way. `standalone` is {@link readStandalonePackages} read once by a
 * caller that asks about many flows; without it the heads are read for this call.
 */
export async function flowPackageDirs(cwd: string, flowDir: string, standalone?: StandalonePackages): Promise<string[]> {
  const own = await dirsUnder(flowReviewsRoot(cwd, flowDir));
  const heads = standalone ?? (await readStandalonePackages(cwd));
  return [...own, ...heads.filter(({ head }) => boundToFlow(head, flowDir)).map(({ dir }) => dir)];
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
