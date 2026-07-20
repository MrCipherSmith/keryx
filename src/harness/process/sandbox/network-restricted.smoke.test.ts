// Live end-to-end restricted-network smoke (flow 098, T7). REAL processes +
// seatbelt — gated behind KERYX_ALLOW_REAL_SUBPROCESS=1 on macOS with
// sandbox-exec present. Skipped under a normal `bun test`.
//
// Proves the full restricted chain with the PRODUCTION sync spawn path: the
// allowlist proxy (worker thread) keeps serving while the main thread blocks in
// spawnSync, the OS denies all direct network, and only allowlisted hosts pass
// through the proxy.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { defaultSandboxProfile } from "./profile";
import { setupNetworkRun } from "./network-run";
import { wrapSeatbelt } from "./seatbelt";

const flag = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";
const supported = process.platform === "darwin"; // macOS enforces restricted in v1.x

describe.skipIf(!flag || !supported)("restricted-network live smoke (macOS)", () => {
  test("proxy allows allowlisted host, blocks others, and direct network is denied", async () => {
    const cwd = realpathSync(process.cwd());
    const home = homedir();

    // Upstream in a child process (reachable while the main thread blocks in spawnSync).
    const child = spawn("bun", [
      "-e",
      "const h=require('node:http');const s=h.createServer((q,r)=>{r.writeHead(200);r.end('OK-UP')});s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port))",
    ]);
    const upPort: number = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("upstream did not start")), 5000);
      child.stdout.on("data", (d) => {
        const m = /PORT=(\d+)/.exec(d.toString());
        if (m) {
          clearTimeout(timer);
          res(Number(m[1]));
        }
      });
    });

    const base = defaultSandboxProfile(cwd, realpathSync(tmpdir()), home);
    const net = await setupNetworkRun({ ...base, network: "restricted", allowedDomains: ["localhost"] });

    const runCurl = (url: string, useProxy: boolean) => {
      const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home };
      if (useProxy) Object.assign(env, net.envAdditions);
      const wrapped = wrapSeatbelt({ path: "/usr/bin/curl", argv: ["curl", "-sS", "-m", "5", url], env, cwd }, net.profile);
      return spawnSync(wrapped.path, wrapped.argv.slice(1), { cwd, env, timeout: 9000, encoding: "utf8" });
    };

    try {
      const allowed = runCurl(`http://localhost:${upPort}/`, true);
      expect(allowed.stdout).toContain("OK-UP");

      const disallowed = runCurl("http://blocked.example.com/", true);
      expect(disallowed.stdout).toContain("blocked by keryx sandbox network allowlist");

      const direct = runCurl(`http://localhost:${upPort}/`, false);
      expect(direct.status).not.toBe(0); // seatbelt denied the bypass
      expect(direct.stdout ?? "").not.toContain("OK-UP");
    } finally {
      await net.close();
      child.kill();
    }
  });
});
