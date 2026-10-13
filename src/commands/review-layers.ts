import { existsSync, statSync } from "node:fs";
import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { placeReviewPath } from "../lib/review-path-flags";
import { computeCoverage, coverageLine } from "../review/coverage-complete";
import { type LayersFile, readLayers, refreshLayers } from "../review/layers";
import { buildLayersBlock, layersBlockLines } from "../review/layers-payload";
import { layersDetailLines } from "../review/layers-view";

export type LayersDeps = {
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void;
};

export const LAYERS_REFRESH_FLAGS = ["--package", "--head", "--base", "--write-wiki", "--json", "--help", "-h"] as const;
export const LAYERS_STATUS_FLAGS = ["--package", "--json", "--help", "-h"] as const;

export const LAYERS_BLOCK_FLAGS = ["--package", "--files", "--max-bytes", "--json", "--help", "-h"] as const;

export function printLayersHelp(): void {
  console.log(`keryx review layers — usage:

  keryx review layers refresh --package <dir> [--head <sha>] [--base <ref>] [--write-wiki] [--json]
  keryx review layers status  --package <dir> [--json]
  keryx review layers block   --package <dir> --files <a,b,...> [--max-bytes <n>] [--json]

\`block\` prints the bounded \`layers\` block a reviewer payload carries for those files: files
the graph says are affected (depth 1, then 2 while under the cap), symbol neighbours, related
tests, wiki pages that describe the files and memory entries for their module. Anything cut
is listed with the command that fetches the rest.

Brings the graph, the wiki and the memory index up to date for one review and writes
<dir>/layers.json. No model is called: it runs the graph build, \`wiki refresh\` and
\`memory index\` (without --embeddings). \`wiki enrich\` is the only model step in the wiki
and is never run from here.

The graph is built at the PR head into <dir>/layers/graph; the tracked graph artifacts of
the working tree are not touched. The wiki and the memory are read from the project's
working copy, and layers.json marks how far that is from the PR head. The wiki refresh is a
dry run unless --write-wiki is given.`);
}

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function resolvePackageDir(args: readonly string[], cwd: string = process.cwd()): string {
  const raw = optionValue([...args], "--package");
  if (raw === undefined) throw new Error("Missing --package <dir>. See `keryx review layers --help`.");
  const placed = placeReviewPath("layers", "--package", raw, { projectRoot: resolveProjectRoot(cwd), cwd });
  if (!placed.ok) throw new Error(placed.message);
  const dir = placed.path;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`--package ${raw} is not a directory.`);
  return dir;
}

/**
 * The package's layers, refreshing them first when `layers.json` is absent or was
 * built for another PR head. Review commands call this so no operator step stands
 * between a review and fresh layers.
 */
export async function ensurePackageLayers(
  packageDir: string,
  options: { projectRoot?: string; prHead?: string; base?: string } = {},
): Promise<LayersFile> {
  const existing = await readLayers(packageDir);
  if (existing !== null && (options.prHead === undefined || existing.prHead === options.prHead)) return existing;
  return refreshLayers({
    projectRoot: options.projectRoot ?? resolveProjectRoot(process.cwd()),
    packageDir,
    ...(options.prHead === undefined ? {} : { prHead: options.prHead }),
    ...(options.base === undefined ? {} : { base: options.base }),
  });
}

function print(layers: LayersFile, json: boolean): void {
  console.log(json ? JSON.stringify(layers, null, 2) : layersDetailLines(layers).join("\n"));
}

export async function runLayers(args: string[], deps: LayersDeps): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || wantsHelp(args)) {
    printLayersHelp();
    return;
  }
  if (sub === "refresh") {
    deps.rejectUnknownFlags(rest, LAYERS_REFRESH_FLAGS, "layers refresh");
    const packageDir = resolvePackageDir(rest);
    const head = optionValue(rest, "--head");
    const base = optionValue(rest, "--base");
    const layers = await refreshLayers({
      projectRoot: resolveProjectRoot(process.cwd()),
      packageDir,
      ...(head === undefined ? {} : { prHead: head }),
      ...(base === undefined ? {} : { base }),
      writeWiki: rest.includes("--write-wiki"),
    });
    print(layers, rest.includes("--json"));
    if (layers.graph.status !== "ok") process.exitCode = 1;
    return;
  }
  if (sub === "status") {
    deps.rejectUnknownFlags(rest, LAYERS_STATUS_FLAGS, "layers status");
    const packageDir = resolvePackageDir(rest);
    const layers = await readLayers(packageDir);
    if (layers === null) {
      console.log(`no layers.json in ${packageDir}; run \`keryx review layers refresh --package ${packageDir}\``);
      process.exitCode = 1;
      return;
    }
    const coverage = await computeCoverage(packageDir);
    if (rest.includes("--json")) console.log(JSON.stringify({ ...layers, coverage }, null, 2));
    else console.log([...layersDetailLines(layers), coverageLine(coverage)].join("\n"));
    return;
  }
  if (sub === "block") {
    deps.rejectUnknownFlags(rest, LAYERS_BLOCK_FLAGS, "layers block");
    const packageDir = resolvePackageDir(rest);
    const files = (optionValue(rest, "--files") ?? "").split(",").map((file) => file.trim()).filter(Boolean);
    if (files.length === 0) throw new Error("Missing --files <a,b,...>. See `keryx review layers --help`.");
    const rawMax = optionValue(rest, "--max-bytes");
    const maxBytes = rawMax === undefined ? undefined : Number(rawMax);
    if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 256)) throw new Error("--max-bytes must be an integer of at least 256.");
    const projectRoot = resolveProjectRoot(process.cwd());
    await ensurePackageLayers(packageDir, { projectRoot });
    const block = await buildLayersBlock({ projectRoot, packageDir, files, ...(maxBytes === undefined ? {} : { maxBytes }) });
    console.log(rest.includes("--json") ? JSON.stringify(block, null, 2) : layersBlockLines(block).join("\n"));
    return;
  }
  throw new Error(`Unknown layers command "${sub}". Use refresh, status or block.`);
}
