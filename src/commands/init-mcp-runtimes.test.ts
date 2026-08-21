import { expect, test } from "bun:test";
import { MCP_INIT_RUNTIMES } from "./init";

// Review finding: `MCP_INIT_RUNTIMES` (the interactive `keryx init` MCP
// client-config runtime choice) was not updated to include "vscode" even
// though `src/mcp/client-config.ts`'s `MCP_CLIENT_RUNTIMES` (T5) already
// supports it via `VSCODE_RUNTIME`. Assert the offered runtime list includes
// it alongside the existing entries, so a future regression here is caught.

test("MCP_INIT_RUNTIMES offers 'vscode' alongside the existing interactive-init runtimes", () => {
  expect(MCP_INIT_RUNTIMES).toContain("vscode");
  expect(MCP_INIT_RUNTIMES).toEqual(["cursor", "claude", "opencode", "vscode", "generic", "skip"]);
});
