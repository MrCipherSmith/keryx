// Default stdio transport (specification.md §9; M-1).
//
// No listening socket is opened on this path — the server speaks JSON-RPC over
// stdin/stdout only. The SDK's `StdioServerTransport` is loaded lazily so this
// module carries no top-level SDK import. Kept separate from `http-sse.ts` so
// the two transports are fully isolated (M-12).

// The SDK `Server` accepts any object implementing the transport contract; we
// keep the type structural to avoid a top-level SDK import.
interface ConnectableServer {
  connect(transport: unknown): Promise<void>;
}

export async function startStdioTransport(server: ConnectableServer): Promise<void> {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
