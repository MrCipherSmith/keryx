import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { type DriverFile, readDrivers } from "./driver-read";
import { writeFileAtomic } from "../lib/fs";
import { packageHasBlastRadius, packageHasPrContext, packageRoundDepth, packageScopeFiles, projectRootOfPackage, requiredReviewers } from "./coverage";
import { manifestRosterRoles } from "./round-split";
import { packageEnabledRoles } from "./role-switches";
import type { SliceManifest } from "./slice";
import { roleDispatchWaves } from "./estimate";

/** Flow 458 AC12: the reviewers of a package and the per-wave driver files `review slice --package` writes for them. */
export const DRIVERS_DIR = "drivers";
export const RAW_DIR = "raw";

/**
 * The roster of the package: the required set plus {@link manifestRosterRoles} (the roles of its fix and second-look
 * slices, and review-security-code wherever slice routing gave it a slice, in a light round too) — the roles the estimate
 * (and so plan.json) counts. Any other role slice routing gave a slice but the roster does not run (review-backend or
 * review-frontend on a project that never selects them) is not a reviewer of the round. With `withDrivers`, every
 * reviewer a driver already on disk names joins too (`review next` collects what was dispatched by hand).
 */
export async function packageReviewers(packageDir: string, manifest: SliceManifest | undefined, options: { withDrivers?: boolean } = {}): Promise<string[]> {
  const root = projectRootOfPackage(packageDir);
  const names = new Set<string>();
  try {
    const files = await packageScopeFiles(packageDir);
    const depth = (await packageRoundDepth(packageDir))?.depth;
    const required = await requiredReviewers(root, "all", files, { blastRadius: await packageHasBlastRadius(packageDir), prContext: packageHasPrContext(packageDir), depth, enabledRoles: await packageEnabledRoles(packageDir) });
    for (const reviewer of required.required) names.add(reviewer);
  } catch (error) {
    // Not swallowed: a reviewer set computed without the project's rules would silently drop the reviewers they require.
    throw new Error(`the required reviewers of ${packageDir} could not be read (${error instanceof Error ? error.message : String(error)}); fix the reviewer rules and re-run`, { cause: error });
  }
  if (manifest !== undefined) for (const reviewer of manifestRosterRoles(manifest)) names.add(reviewer);
  if (options.withDrivers === true) for (const reviewer of (await readDrivers(packageDir, root)).replies.reviewers) names.add(reviewer);
  return [...names].sort();
}

const DEFINITION_CANDIDATES = (reviewer: string): string[] => [
  `.metaproject/skills/gdskills/review/${reviewer}/SKILL.md`,
  `src/gdskills/bundled/skills/review/${reviewer}/SKILL.md`,
];

/**
 * `drivers/<reviewer>-w<n>.json` for every reviewer x wave ({@link roleDispatchWaves}): the slice ids it is handed (`slices`), their ABSOLUTE paths
 * (`slicePaths`), the file its reply goes to (`result`) and its rule file (`definition`) when one exists. `model` is left to the
 * dispatcher, which passes it; a model or tool log an earlier driver of the same name already recorded is kept. Drivers
 * of an earlier cut (`*-w<n>.json`) that no wave of this one replaces are removed. Returns the files written.
 */
export async function writeWaveDrivers(input: { packageDir: string; manifest: SliceManifest; sliceDir: string; reviewers: readonly string[] }): Promise<string[]> {
  const { packageDir, manifest, sliceDir } = input;
  const root = projectRootOfPackage(packageDir);
  const dir = path.join(packageDir, DRIVERS_DIR);
  await mkdir(dir, { recursive: true });
  const kept = new Map<string, DriverFile>();
  for (const name of existsSync(dir) ? await readdir(dir) : []) {
    if (!/-w\d+\.json$/.test(name)) continue;
    try { kept.set(name, JSON.parse(await readFile(path.join(dir, name), "utf8")) as DriverFile); } catch { /* an unreadable stale driver is replaced */ }
    await rm(path.join(dir, name), { force: true });
  }
  const written: string[] = [];
  for (const reviewer of [...input.reviewers].sort()) {
    // The estimate's own count (one kind per dispatch; a role that runs without slices gets one empty wave; a routed-out
    // role none), so plan.json's dispatches equal the drivers written here.
    const waves = roleDispatchWaves(manifest, reviewer);
    const definition = DEFINITION_CANDIDATES(reviewer).find((candidate) => existsSync(path.resolve(root, candidate)));
    for (const [at, wave] of waves.entries()) {
      const number = at + 1;
      const name = `${reviewer}-w${number}.json`;
      const prior = kept.get(name);
      const driver: Record<string, unknown> = {
        reviewer,
        wave: number,
        waves: waves.length,
        slices: wave.map((entry) => entry.id),
        slicePaths: wave.map((entry) => ({ id: entry.id, path: path.resolve(sliceDir, entry.path), bytes: entry.bytes })),
        result: `${RAW_DIR}/${reviewer}-w${number}.txt`,
        ...(definition === undefined ? {} : { definition }),
        ...(typeof prior?.model === "string" && prior.model.trim() !== "" ? { model: prior.model } : {}),
        ...(typeof prior?.toolLog === "string" && prior.toolLog.trim() !== "" ? { toolLog: prior.toolLog } : {}),
      };
      await writeFileAtomic(path.join(dir, name), `${JSON.stringify(driver, null, 2)}\n`);
      written.push(path.join(dir, name));
    }
  }
  return written;
}

