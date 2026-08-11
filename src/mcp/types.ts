export type JsonSchema = Record<string, unknown>;

export interface ToolEntry {
  name: string; // e.g. "gdgraph.affected"
  module: string; // "gdgraph" — filtered by the manifest (M-11)
  description: string;
  inputSchema: JsonSchema;
  // When true, the tool calls a gate-preserving service method (M-10). Block A
  // exposes only read-only or report-writing tools; no mutating flow transition.
  mutating: boolean;
  invoke(cwd: string, params: Record<string, unknown>, context?: McpInvocationContext): Promise<unknown>;
}

/** Server-owned transport context; never supplied through tool parameters. */
export type McpInvocationContext = Readonly<{ transport: "stdio" | "http" | "in-process" }>;
