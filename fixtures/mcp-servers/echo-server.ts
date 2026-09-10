#!/usr/bin/env bun
// A minimal, real MCP server over stdio. Test fixture — never shipped.
//
// AC5 asks that `search_tool` and `use_tool` be driven "against a fixture MCP
// server over stdio, no network". A fake `McpServerConnection` object cannot
// satisfy that: it proves the code around the transport, and the transport is
// exactly the part that has never run.
//
// Hand-rolled JSON-RPC rather than the SDK's server half, deliberately. The
// client under test loads the SDK; if the fixture did too, a bug in the SDK's
// own framing would cancel out on both sides and the test would pass over a
// wire that no real server speaks.
//
// Behaviour is fixed and small:
//   echo        — returns whatever `text` it was given (annotated read-only)
//   write_note  — returns a confirmation (unannotated: destructive by default)
//   big         — returns more bytes than the truncation cap, for AC6
//   boom        — returns an MCP error, so the error path has a real source

type Request = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      annotations: { readOnlyHint: true },
    },
  },
  {
    name: "write_note",
    description: "Store a note",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
  },
  {
    name: "big",
    description: "Return a very large payload",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "boom",
    description: "Always fails",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "echo") {
    return { content: [{ type: "text", text: String(args.text ?? "") }], isError: false };
  }
  if (name === "write_note") {
    return { content: [{ type: "text", text: `stored: ${String(args.body ?? "")}` }], isError: false };
  }
  if (name === "big") {
    return { content: [{ type: "text", text: "x".repeat(40_000) }], isError: false };
  }
  return { content: [{ type: "text", text: "the tool exploded" }], isError: true };
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  // Newline-delimited JSON, which is what the stdio transport writes.
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;

    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      continue;
    }

    // Notifications carry no id and are never answered.
    if (request.id === undefined) continue;

    if (request.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "keryx-fixture-echo", version: "1.0.0" },
        },
      });
      continue;
    }

    if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
      continue;
    }

    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: callTool(params.name ?? "", params.arguments ?? {}),
      });
      continue;
    }

    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `no method ${request.method}` } });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
