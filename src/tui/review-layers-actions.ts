// The `/reviews` menu's two actions (flow 431, AC12): refresh a review's layers, and get its missing chunks ready to run.
// Neither calls a model. Chunk reviewers are dispatched by the review orchestrator through `keryx review chunks next`.

import { resolveProjectRoot } from "../lib/contained-path";
import { chunkModeOf, chunkRunBlocker, estimateChunkRun, recordChunkEstimate, renderChunkEstimate } from "../review/chunks-estimate";
import { refreshLayers } from "../review/layers";
import { layersSummaryLine } from "../review/layers-view";
import type { ReviewDepthRow } from "./review-panel";

export type ReviewLayersActions = {
  refreshLayers(row: ReviewDepthRow): Promise<string>;
  runMissingChunks(row: ReviewDepthRow): Promise<string>;
};

export function createReviewLayersActions(cwd: string): ReviewLayersActions {
  const root = resolveProjectRoot(cwd);
  return {
    async refreshLayers(row) {
      const dir = row.layersView?.dir;
      if (dir === undefined) return "No package to refresh.";
      try {
        const layers = await refreshLayers({ projectRoot: root, packageDir: dir });
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
        const next = blocked ?? `Next: keryx review chunks next --package ${dir}`;
        return [...renderChunkEstimate(record), next].join("\n");
      } catch (error) {
        return `Chunk estimate failed for ${row.reviewId}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
