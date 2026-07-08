// Canonical in-process gdgraph service facade (specification.md §7; T-B1, M-2).
//
// `createGdgraphService()` is the transport-independent contract Block A's MCP
// Tools wrap (`gdgraph.affected`, etc.) — no new logic lives in `mcp/`. Every
// method is pure over storage + config (no network, no optional dep on the
// default path) and unit-testable without any transport (T-1).

import { buildGraph } from "./build";
import { computeAffected, type AffectedOptions, type AffectedResult } from "./affected";
import { loadGdgraphConfig } from "./config";
import { getCycles, getOrphans, loadGraph } from "./query";
import { writeRepomap, type RepomapOptions, type RepomapResult } from "./repomap";
import type { GraphData } from "./types";

export interface GdgraphService {
  build(cwd: string): Promise<{ nodes: number; edges: number; summaryPath: string }>;
  loadGraph(cwd: string): Promise<GraphData>;
  affected(cwd: string, target: string, options?: AffectedOptions): Promise<AffectedResult>;
  repomap(cwd: string, options?: RepomapOptions): Promise<RepomapResult>;
  query(cwd: string, q: "cycles" | "orphans"): Promise<string[] | string[][]>;
}

export function createGdgraphService(): GdgraphService {
  return {
    async build(cwd) {
      return buildGraph(cwd);
    },

    async loadGraph(cwd) {
      return loadGraph(cwd);
    },

    async affected(cwd, target, options = {}) {
      const config = await loadGdgraphConfig(cwd);
      const graph = await loadGraph(cwd);
      const depth = options.depth ?? config.affected.defaultDepth;
      return computeAffected(graph, target, { ...options, depth });
    },

    async repomap(cwd, options = {}) {
      const config = await loadGdgraphConfig(cwd);
      const graph = await loadGraph(cwd);
      return writeRepomap(cwd, graph, config, options);
    },

    async query(cwd, q) {
      const graph = await loadGraph(cwd);
      return q === "cycles" ? getCycles(graph) : getOrphans(graph);
    },
  };
}
