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

// AFC-10 (flow 234, phase 2, frozen AC3): "an unknown target differs from
// indexed/no edges." Before this, `affected()` for a target the graph never
// heard of resolved (via `target.ts`'s `resolveGraphTarget`, by contract:
// "Returns the normalized target unchanged when nothing matches") to the
// exact same `{dependencies: [], dependents: [], ranked: []}` shape as a
// target the graph DID index but legitimately has no edges for — a failure
// rendered as an empty success, the same defect class phase 1 closed at
// eight other sites. `target.ts`/`affected.ts` are owned by a concurrent
// agent this task must not edit, so the distinguishing check lives here: the
// facade already loads the graph, so it can cheaply confirm the RESOLVED
// target is a real node before handing back a result callers would
// otherwise read as a legitimate (if boring) answer.
export class UnknownGraphTargetError extends Error {
  constructor(public readonly target: string) {
    super(
      `gdgraph: "${target}" is not a node in the built graph (never indexed, or the ` +
        `path/symbol does not exist) — this is not the same as an indexed target with ` +
        `zero edges. Run \`keryx gdgraph build\` if the file is new, or double-check the path.`,
    );
    this.name = "UnknownGraphTargetError";
  }
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
      const result = computeAffected(graph, target, { ...options, depth });
      // `result.target` is the RESOLVED target (exact/suffix match), or —
      // per target.ts's own contract — the normalized input unchanged when
      // nothing matched. Membership in the loaded node set is exactly the
      // signal that distinguishes the two.
      const isKnownNode = graph.nodes.some((node) => node.path === result.target);
      if (!isKnownNode) {
        throw new UnknownGraphTargetError(target);
      }
      return result;
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
