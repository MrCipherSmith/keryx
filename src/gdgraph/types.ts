export type GraphNode = {
  id: string;
  kind: "file" | "asset";
  path: string;
  language: "typescript" | "javascript" | "asset";
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "imports" | "asset" | "unresolved";
  specifier: string;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};
