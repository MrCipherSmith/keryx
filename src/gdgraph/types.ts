export type GraphNode = {
  id: string;
  kind: "file";
  path: string;
  language: "typescript" | "javascript";
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "imports" | "unresolved";
  specifier: string;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};
