// A third-party MCP server must not be able to write to the operator's
// terminal.
//
// Found in the review of PR #522: `StdioClientTransport` defaults `stderr`
// to `inherit`, so the child got a direct writer to the terminal keryx is
// drawing on. It could emit cursor-positioning and colour escapes and paint
// a convincing `✓ auto-approved shell: git status` into the running TUI
// transcript — the literal string the real approval path prints — or simply
// flood the screen. Neither needs the model's cooperation, and neither is
// attributable to the server that did it.
//
// This is asserted the only way it can be: a REAL keryx process is spawned,
// it connects to a fixture server that writes exactly such a forgery to
// stderr, and the parent's own stderr is captured and checked. A unit test
// cannot see an inherited file descriptor.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "..", "fixtures", "mcp-servers", "echo-server.ts");

/** The forgery the fixture writes to stderr on every start. */
const FORGED = "auto-approved shell: git status";

describe("the child's stderr does not reach the parent's terminal", () => {
  test("a server that writes an ANSI forgery to stderr produces none of it here", async () => {
    // A child keryx process, so the file descriptors are real ones.
    const driver = `
      const { connectStdioMcpServer } = await import(${JSON.stringify(path.join(HERE, "..", "mcp-client", "client.ts"))});
      const c = await connectStdioMcpServer(["bun", ${JSON.stringify(FIXTURE)}], {
        cwd: process.cwd(),
        env: process.env,
      });
      await c.listTools();
      await c.close();
      console.log("DONE");
    `;

    const result = Bun.spawnSync({
      cmd: ["bun", "-e", driver],
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.join(HERE, "..", ".."),
    });

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    // The run really happened — otherwise "no forgery" is trivially true.
    expect(stdout).toContain("DONE");

    expect(stderr).not.toContain(FORGED);
    // And no raw escape sequence either: the forged text is only the
    // legible half of the problem.
    expect(stderr).not.toContain("[2J");
  }, 60_000);

  test("the fixture really does write it — so the test above is not vacuous", () => {
    // Run the fixture with stderr inherited-equivalent (piped and read) and
    // confirm the bytes exist. If the fixture ever stops writing them, the
    // assertion above would pass while proving nothing.
    const result = Bun.spawnSync({
      cmd: ["bun", FIXTURE],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toContain(FORGED);
  }, 30_000);
});
