export type JsonSchema = Record<string, unknown>;

export interface ToolEntry {
  name: string; // e.g. "gdgraph.affected"
  module: string; // "gdgraph" — filtered by the manifest (M-11)
  description: string;
  inputSchema: JsonSchema;
  // When true, the tool calls a gate-preserving service method (M-10). Block A
  // exposes only read-only or report-writing tools; no mutating flow transition.
  mutating: boolean;
  invoke(cwd: string, params: Record<string, unknown>): Promise<unknown>;
}
