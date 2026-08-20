// Static AC7 evidence: "No credential of any kind is read, stored, or
// forwarded by this module (D-01 unchanged)" — verified the same way
// `keryx-external-agent-runtime`'s own D-01 compliance is verified (flow
// 182, T13).
//
// The original package's D-01 evidence (`src/harness/external/env.test.ts`,
// `src/harness/external/runtime.test.ts`) proves `buildExternalChildEnv`
// strips every credential-shaped variable (`ANTHROPIC_API_KEY` etc.) from a
// spawned child's environment. This module (`src/mcp-client/`,
// `src/harness/external/supervise-mcp.ts`) does NOT build its own child
// environment — it receives one via `McpSpawnOptions.env`
// (`SuperviseCodexMcpInput.env`), supplied by whatever future caller wires
// `gatedSuperviseCodexMcpRun` in, exactly like `superviseExternalRun`'s own
// `env` field already works for the existing line-stream path. So AC7's
// evidence for THIS module is: (1) it never reads `process.env` itself —
// checked statically below — and (2) the env it is given is forwarded to
// `client.connect` verbatim, never augmented or read from a global,
// verified by `supervise-mcp.test.ts`'s existing
// "connects with the given argv/cwd/env" assertion
// (`expect(harness.connectCalls).toEqual([{argv, options: {cwd, env}}])`).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const MCP_CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISE_MCP_FILE = path.join(MCP_CLIENT_DIR, "..", "harness", "external", "supervise-mcp.ts");

async function productionTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

describe("AC7: no file in src/mcp-client/ (production code) reads process.env", () => {
  test("no `process.env` reference in any non-test file under src/mcp-client/", async () => {
    const files = await productionTsFiles(MCP_CLIENT_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (/process\.env/.test(content)) {
        violations.push(path.basename(file));
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("AC7: supervise-mcp.ts does not read process.env or build its own child environment", () => {
  test("no `process.env` reference in supervise-mcp.ts — env is only ever received via SuperviseCodexMcpInput.env", async () => {
    const content = await readFile(SUPERVISE_MCP_FILE, "utf8");
    expect(/process\.env/.test(content)).toBe(false);
  });

  test("supervise-mcp.ts never IMPORTS buildExternalChildEnv itself — env hygiene is the caller's responsibility, this module only forwards `input.env` verbatim (it may still mention the function in a doc comment, explaining why it doesn't need it)", async () => {
    const content = await readFile(SUPERVISE_MCP_FILE, "utf8");
    expect(/\bimport\b[^;]*\bbuildExternalChildEnv\b/.test(content)).toBe(false);
  });
});

describe("AC7: no credential-shaped identifier is read by name in this module", () => {
  const CREDENTIAL_IDENTIFIERS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_HOME"];

  test("none of the known credential env-var names appear in src/mcp-client/ production code", async () => {
    const files = await productionTsFiles(MCP_CLIENT_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const id of CREDENTIAL_IDENTIFIERS) {
        if (content.includes(id)) violations.push(`${path.basename(file)}: ${id}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("none of the known credential env-var names appear in supervise-mcp.ts", async () => {
    const content = await readFile(SUPERVISE_MCP_FILE, "utf8");
    const violations = CREDENTIAL_IDENTIFIERS.filter((id) => content.includes(id));
    expect(violations).toEqual([]);
  });
});
