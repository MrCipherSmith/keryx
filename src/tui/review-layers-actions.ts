// The `/reviews` menu's two actions (flow 431, AC12): refresh a review's layers, and get its missing chunks ready to run.
// Neither calls a model. Chunk reviewers are dispatched by the review orchestrator through `keryx review chunks next`.

import { type ChildProcess, execFile } from "node:child_process";
import { resolveProjectRoot } from "../lib/contained-path";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { shellWord } from "../lib/shell-quote";
import { chunkModeOf, chunkRunBlocker, estimateChunkRun, recordChunkEstimate, renderChunkEstimate } from "../review/chunks-estimate";
import type { LayersFile } from "../review/layers";
import { layersSummaryLine } from "../review/layers-view";
import type { ReviewDepthRow } from "./review-panel";

export type ReviewLayersActions = {
  refreshLayers(row: ReviewDepthRow): Promise<string>;
  runMissingChunks(row: ReviewDepthRow): Promise<string>;
};

/** Runs `keryx review layers refresh` for a package and returns the `layers.json` it wrote. */
export type RunLayersRefresh = (projectRoot: string, packageDir: string) => Promise<LayersFile>;

const REFRESH_TIMEOUT_MS = 15 * 60_000;

/** The argument vector of the child that refreshes one package's layers. */
export function layersRefreshArgv(entry: string, packageDir: string): string[] {
  return [...SAFE_BUN_SPAWN_ARGS, entry, "review", "layers", "refresh", "--package", packageDir, "--json"];
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function killLiveChildren(): void {
  for (const child of liveChildren) child.kill("SIGTERM");
}

/** Runs the refresh in a child process of the given entry script, so a graph build never freezes the TUI. */
export function makeLayersRefreshRunner(entry: string | undefined, timeoutMs = REFRESH_TIMEOUT_MS): RunLayersRefresh {
  return (projectRoot, packageDir) =>
    new Promise((resolve, reject) => {
      if (entry === undefined || entry === "") {
        reject(new Error("cannot find the keryx entry script to run the refresh"));
        return;
      }
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once("exit", killLiveChildren);
      }
      const child = execFile(
        process.execPath,
        layersRefreshArgv(entry, packageDir),
        { cwd: projectRoot, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          liveChildren.delete(child);
          if (error?.killed === true) {
            reject(new Error(`the layers refresh did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`));
            return;
          }
          try {
            resolve(JSON.parse(stdout) as LayersFile);
          } catch {
            reject(new Error((stderr.trim() || (error?.message ?? "no layers output")).split("\n")[0]));
          }
        },
      );
      liveChildren.add(child);
    });
}

export const runLayersRefreshInChild: RunLayersRefresh = (projectRoot, packageDir) =>
  makeLayersRefreshRunner(process.argv[1])(projectRoot, packageDir);

export function createReviewLayersActions(cwd: string, runRefresh: RunLayersRefresh = runLayersRefreshInChild): ReviewLayersActions {
  const root = resolveProjectRoot(cwd);
  return {
    async refreshLayers(row) {
      const dir = row.layersView?.dir;
      if (dir === undefined) return "No package to refresh.";
      try {
        const layers = await runRefresh(root, dir);
        if (layers.graph.status !== "ok") {
          return `Layers refresh failed for ${row.reviewId}: graph ${layers.graph.status}${layers.graph.error === undefined ? "" : `: ${layers.graph.error}`}`;
        }
        return `Layers refreshed for ${row.reviewId}: ${layersSummaryLine(layers)}`;
      } catch (error) {
        return `Layers refresh failed for ${row.reviewId}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    async runMissingChunks(row) {
      const dir = row.layersView?.dir;
      if (dir === undefined) return "No package to run chunks for.";
      try {
        const estimate = await estimateChunkRun(dir, root);
        if (estimate === null) return `No missing chunks for ${row.reviewId}: no blast-radius file was dropped.`;
        const record = await recordChunkEstimate(dir, estimate, chunkModeOf(dir));
        const blocked = await chunkRunBlocker(dir, root);
        const next = blocked ?? `Next: keryx review chunks next --package ${shellWord(dir)}`;
        return [...renderChunkEstimate(record), next].join("\n");
      } catch (error) {
        return `Chunk estimate failed for ${row.reviewId}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
