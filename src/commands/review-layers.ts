import { existsSync, statSync } from "node:fs";
import { optionValue } from "../lib/args";
import { shellWord } from "../lib/shell-quote";
import { resolveProjectRoot } from "../lib/contained-path";
import { placeReviewPath } from "../lib/review-path-flags";
import { computeCoverage, coverageLine } from "../review/coverage-complete";
import { type LayersFile, layersCurrent, manifestHead, readLayers, refreshLayers, resolveCommit, waitForLayersRefresh } from "../review/layers";
import { buildLayersBlock, layersBlockLines } from "../review/layers-payload";
import { layersDetailLines } from "../review/layers-view";

export type LayersDeps = {
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void;
};

export const LAYERS_REFRESH_FLAGS = ["--package", "--head", "--base", "--write-wiki", "--force", "--json", "--help", "-h"] as const;
export const LAYERS_STATUS_FLAGS = ["--package", "--json", "--help", "-h"] as const;

export const LAYERS_BLOCK_FLAGS = ["--package", "--files", "--max-bytes", "--force", "--json", "--help", "-h"] as const;

export function printLayersHelp(): void {
  console.log(`keryx review layers — usage:

  keryx review layers refresh --package <dir> [--head <sha>] [--base <ref>] [--write-wiki] [--force] [--json]
  keryx review layers status  --package <dir> [--json]
  keryx review layers block   --package <dir> --files <a,b,...> [--max-bytes <n>] [--force] [--json]

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
dry run unless --write-wiki is given. A graph that is already built at this head and intact is
kept (the wiki and the memory are still refreshed); --force rebuilds it. A graph that failed at
this head is not rebuilt for 5 minutes after the failure; --force or a new head rebuilds it.`);
}

export function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** The confined `--package` directory of a `review <command>` call (layers, chunks, coverage). */
export function resolvePackageDir(args: readonly string[], cwd: string = process.cwd(), command: string = "layers"): string {
  const raw = optionValue([...args], "--package");
  if (raw === undefined) throw new Error(`Missing --package <dir>. See \`keryx review ${command} --help\`.`);
  const placed = placeReviewPath(command, "--package", raw, { projectRoot: resolveProjectRoot(cwd), cwd });
  if (!placed.ok) throw new Error(placed.message);
  const dir = placed.path;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`--package ${raw} is not a directory.`);
  return dir;
}

/**
 * The package's layers, refreshing them first when `layers.json` is absent, was
 * built for another PR head, or holds a failed or missing graph. The head is the caller's, else the package manifest's
 * `target.head`, so a checkout that moved on since the package was made does not
 * pick the head. A refresh already running for the package is waited for.
 */
export async function ensurePackageLayers(
  packageDir: string,
  options: { projectRoot?: string; prHead?: string; base?: string; waitMs?: number; force?: boolean } = {},
): Promise<LayersFile> {
  if (!(await waitForLayersRefresh(packageDir, options.waitMs))) {
    throw new Error(`the layers of ${packageDir} are still being refreshed; try again when it finishes`);
  }
  const projectRoot = options.projectRoot ?? resolveProjectRoot(process.cwd());
  const wanted = options.prHead ?? (await manifestHead(packageDir)) ?? undefined;
  const head = wanted === undefined ? undefined : ((await resolveCommit(projectRoot, wanted)) ?? wanted);
  const existing = await readLayers(packageDir);
  if (existing !== null && (await layersCurrent(packageDir, existing, head))) return existing;
  return refreshLayers({
    projectRoot,
    packageDir,
    ...(head === undefined ? {} : { prHead: head }),
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.force === true ? { force: true } : {}),
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
      force: rest.includes("--force"),
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
      console.log(`no layers.json in ${packageDir}; run \`keryx review layers refresh --package ${shellWord(packageDir)}\``);
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
    if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 256)) throw new Error("--max-bytes must be an integer of at least 256; a block with every list empty needs more than that, and the refusal names how much.");
    const projectRoot = resolveProjectRoot(process.cwd());
    await ensurePackageLayers(packageDir, { projectRoot, force: rest.includes("--force") });
    const block = await buildLayersBlock({ projectRoot, packageDir, files, ...(maxBytes === undefined ? {} : { maxBytes }) });
    console.log(rest.includes("--json") ? JSON.stringify(block, null, 2) : layersBlockLines(block).join("\n"));
    return;
  }
  throw new Error(`Unknown layers command "${sub}". Use refresh, status or block.`);
}
