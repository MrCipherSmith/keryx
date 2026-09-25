export type JsonSchema = Record<string, unknown>;

export interface ToolEntry {
  name: string; // e.g. "gdgraph.affected"
  module: string; // "gdgraph" — filtered by the manifest (M-11)
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  // When true, the tool calls a gate-preserving service method (M-10). Block A
  // exposes only read-only or report-writing tools; no mutating flow transition.
  mutating: boolean;
  invoke(cwd: string, params: Record<string, unknown>, context?: McpInvocationContext): Promise<unknown>;
}

/**
 * Server-owned invocation context; never supplied through tool parameters.
 *
 * `harnessIdentity` (flow 313, W4-AC6) is the cross-harness memory identity
 * bound ONCE at `keryx serve-mcp` launch (`--harness` / `KERYX_HARNESS`),
 * never per call — a connected client cannot claim a different harness
 * identity per tool call than the process it is actually talking through.
 * `null` when the server was launched unbound.
 */
export type McpInvocationContext = Readonly<{
  transport: "stdio" | "http" | "in-process";
  // Optional so every pre-existing call site that builds this context
  // without naming it keeps type-checking unchanged; absent has the same
  // meaning as `null` (unbound) everywhere it is read.
  harnessIdentity?: string | null;
}>;
