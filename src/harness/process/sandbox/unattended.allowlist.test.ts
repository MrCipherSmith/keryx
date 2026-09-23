// Flow 301 (AC6): a REAL bwrap integration test for `network: "allowlist"` — the
// full wiring end to end: `planUnattendedSandbox` builds the bwrap args and the
// forwarder-starting wrap script; `createAllowlistProxy` runs outside the sandbox on
// a unix socket; `curl` inside the sandbox (through HTTP_PROXY, exactly as
// `shell_exec` sets it up) reaches an allowed name and is refused for one that is not
// listed; and a listener on the host's REAL loopback (bypassing the proxy entirely)
// stays unreachable from inside the sandbox's private netns.
//
// Skipped wherever a real, working bwrap is not available (macOS, containers without
// user namespaces, …) — mirrors the skip condition `trigger-agent-task.test.ts` and
// `schedule-security.test.ts` already use for their own live-sandbox tests.
import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createAllowlistProxy, type AllowlistProxy } from "./proxy";
import { planUnattendedSandbox } from "./unattended";

const projectRoot = process.cwd();
const forwarderArgv = [process.execPath, path.join(projectRoot, "src", "cli.ts"), "__sandbox-net-forward"];

const realSandbox = planUnattendedSandbox({
  worktree: tmpdir(),
  scratchHome: tmpdir(),
  network: false,
  readOnly: [projectRoot],
  env: process.env,
  home: homedir(),
});

async function runInSandbox(
  proxySocketPath: string,
  domains: string[],
  script: string,
): Promise<{ stdout: string; exitCode: number }> {
  let workdir = "";
  let scratchHome = "";
  try {
    workdir = await mkdtemp(path.join(tmpdir(), "keryx-allowlist-it-work-"));
    scratchHome = await mkdtemp(path.join(tmpdir(), "keryx-allowlist-it-home-"));
    const plan = planUnattendedSandbox({
      worktree: workdir,
      scratchHome,
      network: { mode: "allowlist", proxySocketPath, forwarderArgv },
      readOnly: [projectRoot],
      env: process.env,
      home: homedir(),
    });
    if (!plan.ok) throw new Error(`sandbox plan refused: ${plan.reason}`);
    const argv = plan.wrap(["/bin/sh", "-c", script]);
    const proc = Bun.spawn(argv, { env: plan.env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true });
    if (scratchHome) await rm(scratchHome, { recursive: true, force: true });
  }
}

describe("network: allowlist — real bwrap integration (flow 301 AC6)", () => {
  let proxy: AllowlistProxy | undefined;
  let upstream: http.Server | undefined;
  let sockPath = "";

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
    proxy = undefined;
    upstream = undefined;
    if (sockPath.length > 0) rmSync(sockPath, { force: true });
    sockPath = "";
  });

  test.skipIf(!realSandbox.ok)(
    "curl reaches an allowed name through the proxy, and is refused for a name not on the list",
    async () => {
      upstream = http.createServer((_req, res) => res.end("ALLOWED-UPSTREAM-OK"));
      const upPort: number = await new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
      sockPath = path.join(tmpdir(), `keryx-allowlist-it-${randomUUID()}.sock`);
      // `refuseReservedAddresses` is OFF here on purpose, and the allowed name is
      // "localhost" (real OS resolution, no stub needed) rather than a fake TLD: this
      // test's job is the WIRING (sandbox -> forwarder -> unix socket -> proxy ->
      // upstream), which the hardening flag is orthogonal to and which is
      // exhaustively unit-tested with injected resolvers in `proxy.allowlist.test.ts`
      // (AC3/AC4). The NEXT test in this file proves the hardening is wired through
      // end to end too, exactly the way `proxy.test.ts` does for the pre-301 posture.
      proxy = await createAllowlistProxy({
        allowedDomains: ["localhost"],
        unixSocketPath: sockPath,
      });

      const allowed = await runInSandbox(
        sockPath,
        ["localhost"],
        `curl -sS --max-time 5 http://localhost:${upPort}/`,
      );
      expect(allowed.stdout).toContain("ALLOWED-UPSTREAM-OK");
      expect(allowed.exitCode).toBe(0);

      const blocked = await runInSandbox(
        sockPath,
        ["localhost"],
        `curl -sS --max-time 5 -w "EXIT:%{http_code}" http://blocked.test:${upPort}/`,
      );
      expect(blocked.stdout).toContain("blocked by keryx sandbox network allowlist");
      expect(blocked.stdout).toContain("EXIT:403");
    },
    30_000,
  );

  test.skipIf(!realSandbox.ok)(
    "with production hardening on, an allowed NAME that resolves to loopback is refused end to end (not just at the proxy unit)",
    async () => {
      upstream = http.createServer((_req, res) => res.end("SHOULD-NEVER-BE-SEEN"));
      const upPort: number = await new Promise((r) => upstream!.listen(0, "127.0.0.1", () => r((upstream!.address() as net.AddressInfo).port)));
      sockPath = path.join(tmpdir(), `keryx-allowlist-it-${randomUUID()}.sock`);
      proxy = await createAllowlistProxy({
        allowedDomains: ["allowed.test"],
        unixSocketPath: sockPath,
        refuseReservedAddresses: true, // the REAL setting `trigger-agent-task.ts` uses
        resolveHost: async (h) => (h === "allowed.test" ? "127.0.0.1" : undefined),
      });

      const result = await runInSandbox(
        sockPath,
        ["allowed.test"],
        `curl -sS --max-time 5 -w "EXIT:%{http_code}" http://allowed.test:${upPort}/`,
      );
      expect(result.stdout).not.toContain("SHOULD-NEVER-BE-SEEN");
      expect(result.stdout).toContain("EXIT:403");
    },
    30_000,
  );

  test.skipIf(!realSandbox.ok)(
    "the host's REAL loopback stays unreachable from inside the sandbox, bypassing the proxy entirely",
    async () => {
      const hostListener = http.createServer((_req, res) => res.end("HOST-LOOPBACK-LEAK"));
      const hostPort: number = await new Promise((r) => hostListener.listen(0, "127.0.0.1", () => r((hostListener.address() as net.AddressInfo).port)));
      sockPath = path.join(tmpdir(), `keryx-allowlist-it-${randomUUID()}.sock`);
      proxy = await createAllowlistProxy({ allowedDomains: ["allowed.test"], unixSocketPath: sockPath });
      try {
        // `--noproxy '*'` bypasses the sandbox's own HTTP_PROXY env for this one
        // request — a genuinely DIRECT connect attempt to the host's own loopback,
        // from inside the sandbox's PRIVATE netns (its own empty `lo`). Without
        // `--noproxy` curl would route this through the allowlist proxy instead
        // (which refuses it too, but that would prove the proxy's IP-literal
        // refusal, not netns isolation — a different claim this test is not about).
        const result = await runInSandbox(
          sockPath,
          [],
          `curl -sS --max-time 3 --noproxy '*' http://127.0.0.1:${hostPort}/ ; echo "CURL_EXIT:$?"`,
        );
        expect(result.stdout).not.toContain("HOST-LOOPBACK-LEAK");
        expect(result.stdout).toContain("CURL_EXIT:7"); // curl 7 = could not connect
      } finally {
        await new Promise<void>((r) => hostListener.close(() => r()));
      }
    },
    30_000,
  );
});
