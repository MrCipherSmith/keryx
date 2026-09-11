// Closing the runtime: a connected server is torn down, and nothing lingers.
//
// Review of flow 251 (K-012):
//
// - F-002: the shell-level K-012 test aborts its dial before the server spawns, so
//   its "no server left" check cannot fail. Whether `close()` really tears down a
//   server that HAS connected is proved here, against the repository's stdio
//   fixture, at the runtime level.
// - F-001: `close()` bounded its waits with timers it never cleared, and the CLI
//   exits by letting the event loop drain, so every close held the process for its
//   full grace — ~4.5 s after every refused start and every `keryx shell -p` run.
//   Proved in a child process, because an armed timer is only visible as a process
//   that does not exit.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMcpRuntime } from "./runtime";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const ECHO_SERVER = path.join(REPO_ROOT, "fixtures", "mcp-servers", "echo-server.ts");
const RUNTIME = path.join(import.meta.dir, "runtime.ts");
const MARKER = `rtclose-${process.pid}-${Date.now()}`;

afterAll(() => {
  Bun.spawnSync(["pkill", "-f", MARKER]);
});

function workspace(servers: Record<string, unknown>): { configDir: string; projectRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-rt-close-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(configDir, "mcp-servers.json"), JSON.stringify({ schemaVersion: 1, servers }));
  return { configDir, projectRoot };
}

const running = (): boolean => Bun.spawnSync(["pgrep", "-f", MARKER]).stdout.toString().trim().length > 0;

test("close() tears down a server that has connected, and a second close() is the first one", async () => {
  const { configDir, projectRoot } = workspace({
    echo: { command: process.execPath, args: [ECHO_SERVER, MARKER] },
  });
  const runtime = createMcpRuntime({ cwd: projectRoot, gitRoot: projectRoot, configDir });
  await runtime.ready();
  expect(runtime.servers().map((server) => server.status)).toEqual(["connected"]);
  expect(running()).toBe(true);

  const first = runtime.close();
  const second = runtime.close();
  // Idempotent: the shell closes the readline runtime twice on its normal path.
  expect(second).toBe(first);
  await first;

  // The child's exit trails its pipe closing by a moment; give it one.
  for (let i = 0; i < 30 && running(); i++) await Bun.sleep(100);
  expect(running()).toBe(false);
}, 30_000);

test("a process that closes its runtime exits at once — no timer left armed", () => {
  const { configDir, projectRoot } = workspace({});
  const script =
    `const { createMcpRuntime } = await import(${JSON.stringify(RUNTIME)});` +
    `const runtime = createMcpRuntime({ cwd: ${JSON.stringify(projectRoot)}, gitRoot: ${JSON.stringify(projectRoot)}, configDir: ${JSON.stringify(configDir)} });` +
    "await runtime.close();";
  const started = Date.now();
  const proc = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const elapsed = Date.now() - started;
  expect(proc.exitCode).toBe(0);
  // With the losing timers armed this process lived ~4.5 s (KILL_GRACE_MS) past a
  // close() that had nothing to wait for.
  expect(elapsed).toBeLessThan(2_500);
}, 30_000);
