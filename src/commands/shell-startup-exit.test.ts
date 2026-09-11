// K-012: a `keryx shell` start that fails after the MCP runtime is up must exit.
//
// Found by the arena (defect log K-012, 2026-09-11): under an operator's HOME with
// MCP servers configured, `--deny-tools web_serch` printed its refusal and then the
// process never exited — killed at 90 s, against 1.3 s under an empty HOME. The
// readline path creates the session's MCP runtime before it builds the tool list,
// the refusal is thrown while the list is built, and the only `close()` sat in a
// `finally` around the REPL that the refusal never reached.
//
// The server here COMPLETES its handshake — the repository's hand-rolled stdio
// fixture — because that is the case that hangs: a connected server keeps its
// child and pipe open for as long as nobody closes it. A server that never answers
// does not reproduce it: its own dial timeout kills it after ~15 s and the shell
// then exits by itself, which is how the first version of this test passed on the
// broken code.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const ECHO_SERVER = path.join(REPO_ROOT, "fixtures", "mcp-servers", "echo-server.ts");
// An argument the fixture ignores and no other process carries, so `pgrep` finds
// exactly the server this test started.
const MARKER = `k012-${process.pid}-${Date.now()}`;

afterAll(() => {
  // A failing run must not leave its server behind for the next test to trip on.
  Bun.spawnSync(["pkill", "-f", MARKER]);
});

test("a refused start exits with its error, and leaves no MCP server behind", () => {
  const home = mkdtempSync(path.join(tmpdir(), "keryx-k012-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-k012-cwd-"));
  // `~/.claude.json` is read by the compat reader as the operator's own file, so the
  // server is launched without an approval hold — the case that hung.
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [ECHO_SERVER, MARKER] } } }),
  );
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    TMPDIR: tmpdir(),
    ...(process.env.NODE_EXTRA_CA_CERTS === undefined ? {} : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
  };

  const started = Date.now();
  const proc = Bun.spawnSync(
    ["bun", CLI, "shell", "--provider", "deepseek", "--model", "unused", "--no-tui", "--deny-tools", "web_serch", "-p", "x"],
    { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 40_000 },
  );
  const elapsed = Date.now() - started;
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;

  expect(output).toContain("unknown tool name(s) in --deny-tools");
  // Exit 1 is the refusal. 143 is this test's own timeout killing a shell that
  // printed the refusal and then never left — the defect.
  expect(proc.exitCode).toBe(1);
  // A refusal is not slow work. Before the timer fix in `runtime.ts` every close
  // held the process ~4.5 s after it had finished; the bound leaves room for a slow
  // start-up on a loaded runner without leaving room for that linger to return.
  expect(elapsed).toBeLessThan(10_000);
  // With the fix the dial is aborted before it spawns anything, so this check
  // guards against a regression that starts the server and then leaks it; it does
  // not by itself prove a connected server is torn down. That is proved at the
  // runtime level, in `src/mcp-servers/runtime-close.test.ts`.
  const survivors = Bun.spawnSync(["pgrep", "-f", MARKER]).stdout.toString().trim();
  expect(survivors).toBe("");
}, 60_000);
