// Flag-gated LIVE smoke test for the stdio MCP client (flow 182, T6; AC1).
// Mirrors the established pattern in `src/commands/harness-exec.smoke.test.ts`
// and `src/harness/process/real-process-adapter.smoke.test.ts`: EXCLUDED FROM
// CI, skipped entirely unless the explicit opt-in env flag
// `KERYX_ALLOW_REAL_SUBPROCESS=1` is set AND a real `codex` binary is on
// PATH. Under a normal `bun test` (no flag), zero real processes are spawned
// and the dynamic `import("./client")` inside the (skipped) test body never
// breaks collection — and, per this package's zero-dependency policy, never
// touches `@modelcontextprotocol/sdk` either, since `connectCodexMcpClient`
// only loads it once actually called.
//
// This proves AC1 (spawn + handshake) against the real binary. It does
// NOT exercise the elicitation exchange (AC2/AC3) — that needs a live run that
// actually requires approval, which `fixtures/mcp-client/codex/` (T13) is
// scoped to capture and replay; this test only proves the connection itself
// is real and completes.
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const REAL_SUBPROCESS_FLAG = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";

function codexAvailable(): boolean {
  try {
    const result = spawnSync("codex", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

describe.skipIf(!REAL_SUBPROCESS_FLAG || !codexAvailable())(
  "stdio MCP client smoke (flag-gated via KERYX_ALLOW_REAL_SUBPROCESS=1, excluded from CI)",
  () => {
    test("connects to a real `codex mcp-server` and completes the MCP handshake", async () => {
      const { connectCodexMcpClient, buildCodexMcpServerArgv } = await import("./client");

      const connection = await connectCodexMcpClient(buildCodexMcpServerArgv(), {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } as Record<string, string>,
      });

      try {
        expect(connection).toBeDefined();
      } finally {
        await connection.close();
      }
    });
  },
);
