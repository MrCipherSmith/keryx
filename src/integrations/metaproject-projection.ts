import {
  METAPROJECT_EDGE_LIMIT,
  METAPROJECT_NODE_LIMIT,
  type MetaprojectEdge,
  type MetaprojectNeighbors,
  type MetaprojectNode,
  type MetaprojectRequest,
} from "./metaproject-explorer-contract";

export function indexMetaprojectGraph(nodes: readonly MetaprojectNode[], edges: readonly MetaprojectEdge[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const adjacency = new Map<string, MetaprojectEdge[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    for (const id of new Set([edge.from, edge.to])) {
      const adjacent = adjacency.get(id);
      if (adjacent) adjacent.push(edge);
      else adjacency.set(id, [edge]);
    }
  }
  return { byId, adjacency };
}

export function projectMetaprojectGraph<Version extends 1 | 2>(
  index: ReturnType<typeof indexMetaprojectGraph>,
  snapshot: { schemaVersion: Version; snapshotId: string },
  request: Extract<MetaprojectRequest, { action: "neighbors" }>,
): (Omit<MetaprojectNeighbors, "schemaVersion"> & { schemaVersion: Version }) | null {
  const root = index.byId.get(request.id);
  if (!root) return null;
  const kinds = new Set(request.kinds);
  const nodes = new Map([[root.id, root]]);
  const edges = new Map<string, MetaprojectEdge>();
  let frontier = [root];
  let truncated = false;

  for (let step = 0; step < request.depth && frontier.length; step++) {
    const next: MetaprojectNode[] = [];
    for (const node of frontier) {
      for (const edge of index.adjacency.get(node.id) ?? []) {
        if (!kinds.has(edge.kind)
          || (request.direction === "incoming" && edge.to !== node.id)
          || (request.direction === "outgoing" && edge.from !== node.id)) continue;

        const target = index.byId.get(edge.from === node.id ? edge.to : edge.from);
        if (!target) continue;
        if (!nodes.has(target.id)) {
          if (nodes.size === METAPROJECT_NODE_LIMIT) {
            truncated = true;
            continue;
          }
          nodes.set(target.id, target);
          next.push(target);
        }
        const key = JSON.stringify(edge);
        if (edges.has(key)) continue;
        if (edges.size === METAPROJECT_EDGE_LIMIT) truncated = true;
        else edges.set(key, edge);
      }
    }
    frontier = next;
  }
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    root: root.id,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated,
  };
}
