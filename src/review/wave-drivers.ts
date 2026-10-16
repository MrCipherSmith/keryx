import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { type DriverFile, readDrivers } from "./driver-read";
import { writeFileAtomic } from "../lib/fs";
import { packageHasBlastRadius, packageHasPrContext, packageRoundDepth, packageScopeFiles, projectRootOfPackage, requiredReviewers } from "./coverage";
import { fixSliceRoles } from "./round-split";
import { type SliceManifest, packWaves, waveBytesOf } from "./slice";
import { requiredSlices, sliceGraph } from "./waves";

/** Flow 458 AC12: the reviewers of a package and the per-wave driver files `review slice --package` writes for them. */
export const DRIVERS_DIR = "drivers";
export const RAW_DIR = "raw";

/** The reviewers of the package: the required set plus the roles of its fix slices, plus every reviewer a driver names. */
export async function packageReviewers(packageDir: string, manifest: SliceManifest | undefined): Promise<string[]> {
  const root = projectRootOfPackage(packageDir);
  const names = new Set<string>();
  try {
    const files = await packageScopeFiles(packageDir);
    const depth = (await packageRoundDepth(packageDir))?.depth;
    const required = await requiredReviewers(root, "all", files, { blastRadius: await packageHasBlastRadius(packageDir), prContext: packageHasPrContext(packageDir), depth });
    for (const reviewer of required.required) names.add(reviewer);
  } catch (error) {
    // Not swallowed: a reviewer set computed without the project's rules would silently drop the reviewers they require.
    throw new Error(`the required reviewers of ${packageDir} could not be read (${error instanceof Error ? error.message : String(error)}); fix the reviewer rules and re-run`, { cause: error });
  }
  if (manifest !== undefined) {
    for (const reviewer of fixSliceRoles(manifest)) names.add(reviewer);
    for (const entry of manifest.slices) for (const role of entry.roles ?? []) names.add(role);
  }
  for (const reviewer of (await readDrivers(packageDir, root)).replies.reviewers) names.add(reviewer);
  return [...names].sort();
}

const DEFINITION_CANDIDATES = (reviewer: string): string[] => [
  `.metaproject/skills/gdskills/review/${reviewer}/SKILL.md`,
  `src/gdskills/bundled/skills/review/${reviewer}/SKILL.md`,
];

/**
 * `drivers/<reviewer>-w<n>.json` for every reviewer x wave: the slice ids it is handed (`slices`), their ABSOLUTE paths
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
    const graph = sliceGraph(manifest, reviewer);
    const open = graph.open(requiredSlices(manifest, reviewer), new Set());
    // A dispatch carries one kind (fix, second-look, new), as the estimate counts: waves are packed per kind.
    const waves = (["fix", "second-look", "new"] as const).flatMap((kind) => packWaves(open.filter((entry) => (entry.kind === "fix" ? "fix" : entry.kind === "second-look" ? "second-look" : "new") === kind), waveBytesOf(manifest)));
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

