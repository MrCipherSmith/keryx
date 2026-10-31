// `keryx serve` is up (listening, signal handlers installed) before any Hub bridge has finished connecting.
//
// A Hub that accepts the connection and never answers holds the bridge handshake for its full timeout. serve used to wait
// for that before it printed `listening on`, started its services, or answered Ctrl-C. Here the listening line must arrive
// while the handshake is still pending, and a signal during the handshake must still drain to a clean exit.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { hubIdentity, saveEnrollment } from "../lib/hub-machine/config";
import { writeMachinePolicy } from "../lib/hub-machine/policy";
import { defaultServeConfig, saveServeConfig } from "../lib/serve-config";
import { issueServeToken } from "../lib/serve-credential";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
let xdgRoot = "";

beforeEach(() => {
  xdgRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-serve-bridges-xdg-")));
  mkdirSync(path.join(xdgRoot, "keryx"), { recursive: true, mode: 0o700 });
});
afterEach(() => { rmSync(xdgRoot, { recursive: true, force: true }); });

/** Reads until `pattern` shows in the output. One read stays pending across timer ticks, so no chunk is dropped between calls. */
function lineReader(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader(); const decoder = new TextDecoder(); let buffer = ""; let pending: ReturnType<typeof reader.read> | undefined;
  return async (pattern: RegExp, ms: number): Promise<string> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pattern.test(buffer)) return buffer;
      pending ??= reader.read();
      const next = await Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(resolve, 250))]);
      if (next === undefined) continue;
      pending = undefined;
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
    }
    if (pattern.test(buffer)) return buffer;
    throw new Error(`never saw ${String(pattern)}; output was:\n${buffer}`);
  };
}

test("serve lists on its port and drains on a signal while a Hub bridge handshake is still pending", async () => {
  const silentHub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  const configDir = path.join(xdgRoot, "keryx");
  const hubUrl = silentHub.url.origin;
  saveEnrollment(configDir, { hubUrl, machineId: "m", secret: "s".repeat(43) });
  writeMachinePolicy(configDir, { version: 2, hubId: hubIdentity(hubUrl), enabled: true, maxConcurrentRuns: 1, checkouts: [], allowAdHocSessions: false, allowedCandidateIds: [], profiles: [] });
  const issued = issueServeToken(configDir);
  if (!issued.ok) throw new Error("fixture credential could not be issued");
  saveServeConfig(defaultServeConfig(issued.record.id), configDir);
  const proc = Bun.spawn(["bun", "run", CLI, "serve", "--port", "0"], {
    cwd: xdgRoot, env: { ...process.env, XDG_DATA_HOME: xdgRoot, APPDATA: xdgRoot } as Record<string, string>, stdout: "pipe", stderr: "pipe",
  });
  try {
    const readUntil = lineReader(proc.stdout);
    const started = Date.now();
    const seen = await readUntil(/listening on http:\/\//, 8_000);
    // The bridge handshake takes 10 s against a Hub that never answers: nothing about it can have been reported yet.
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(seen).not.toMatch(/Hub machine:|machine bridges started/);
    proc.kill("SIGTERM");
    const rest = await readUntil(/stopped/, 40_000);
    expect(rest).toContain("draining");
    expect(await proc.exited).toBe(0);
  } finally { if (proc.exitCode === null) proc.kill("SIGKILL"); silentHub.stop(true); }
}, 90_000);
