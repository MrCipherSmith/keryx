// Live OS-sandbox smoke (flow 093, T7). REAL processes — gated behind
// KERYX_ALLOW_REAL_SUBPROCESS=1 and a supported platform with the launcher
// present, exactly like real-process-adapter.smoke.test.ts. Under a normal
// `bun test` the whole block is skipped and nothing is spawned.
//
// Proves the two v1 boundaries on the real OS: a write OUTSIDE the workspace
// roots is denied, a write INSIDE succeeds. (Network-off is validated manually;
// asserting DNS failure in CI is environment-fragile.)

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { detectSandboxLauncher } from "./detect";

const flag = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";
const launcher = detectSandboxLauncher();
const supported = (process.platform === "darwin" || process.platform === "linux") && launcher.available;

describe.skipIf(!flag || !supported)("OS-sandbox live smoke", () => {
  test("write inside cwd succeeds; write outside the workspace is denied", async () => {
    const { RealProcessAdapter } = await import("../real-process-adapter");
    const { SandboxedProcessAdapter } = await import("./adapter");
    const { defaultSandboxProfile } = await import("./profile");

    // Canonicalize: macOS /tmp and /var are symlinks, and the sandbox matches on
    // the real path. Production wiring (T6) canonicalizes writable roots the same way.
    const work = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-sbx-")));
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-sbxtmp-")));
    const inside = path.join(work, "inside.txt");
    const outside = path.join(homedir(), `keryx_sbx_FORBIDDEN_${process.pid}.txt`);

    const profile = defaultSandboxProfile(work, tmp, homedir()); // workspace-write + net off
    const inner = new RealProcessAdapter({ allowRealSubprocess: true, timeoutMs: 8000 });
    const adapter = new SandboxedProcessAdapter({
      profile,
      inner,
      platform: process.platform,
      launcherAvailable: launcher.available,
      ...(launcher.path ? { bwrapPath: launcher.path } : {}),
    });

    try {
      adapter.spawn({
        path: "/bin/sh",
        argv: ["sh", "-c", `echo ok > ${inside}`],
        env: { PATH: "/usr/bin:/bin", HOME: homedir() },
        cwd: work,
      });
      expect(existsSync(inside)).toBe(true);

      adapter.spawn({
        path: "/bin/sh",
        argv: ["sh", "-c", `echo bad > ${outside}`],
        env: { PATH: "/usr/bin:/bin", HOME: homedir() },
        cwd: work,
      });
      expect(existsSync(outside)).toBe(false); // sandbox denied the write
    } finally {
      for (const f of [inside, outside]) if (existsSync(f)) rmSync(f);
      rmSync(work, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the default profile denies network (verified against an unsandboxed control)", async () => {
    const { RealProcessAdapter } = await import("../real-process-adapter");
    const { SandboxedProcessAdapter } = await import("./adapter");
    const { defaultSandboxProfile } = await import("./profile");

    const work = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-net-")));
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-nettmp-")));
    const out = path.join(work, "fetched.txt");
    const env = { PATH: "/usr/bin:/bin", HOME: homedir() };
    const inner = new RealProcessAdapter({ allowRealSubprocess: true, timeoutMs: 20000 });

    /** Fetch a public URL into `out`; returns true when bytes were received. */
    const fetched = (profileMode: "sandboxed" | "control"): boolean => {
      if (existsSync(out)) rmSync(out);
      const base = defaultSandboxProfile(work, tmp, homedir()); // workspace-write + net OFF
      const profile =
        profileMode === "control"
          ? { ...base, mode: "danger-full-access" as const } // adapter skips containment
          : base;
      const adapter = new SandboxedProcessAdapter({
        profile,
        inner,
        platform: process.platform,
        launcherAvailable: launcher.available,
        ...(launcher.path ? { bwrapPath: launcher.path } : {}),
      });
      adapter.spawn({
        path: "/usr/bin/curl",
        argv: ["curl", "-sS", "-m", "10", "-o", out, "https://example.com"],
        env,
        cwd: work,
      });
      return existsSync(out) && Bun.file(out).size > 0;
    };

    try {
      // Control first: if the runner has no outbound network at all, the
      // sandboxed leg would "pass" for the wrong reason — so skip instead.
      if (!fetched("control")) {
        console.warn("[skip] no outbound network in this environment; net-off assertion inconclusive");
        return;
      }
      expect(fetched("sandboxed")).toBe(false); // network denied by the OS sandbox
    } finally {
      if (existsSync(out)) rmSync(out);
      rmSync(work, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // PID namespace (flow 115, finding 6 / stress finding S4). Linux only —
  // `--unshare-pid` is a bubblewrap capability; Seatbelt has no equivalent, so
  // on macOS the host process table stays visible and this is not asserted.
  test.skipIf(process.platform !== "linux")(
    "the contained process cannot see the host process table (verified against an unsandboxed control)",
    async () => {
      const { RealProcessAdapter } = await import("../real-process-adapter");
      const { SandboxedProcessAdapter } = await import("./adapter");
      const { defaultSandboxProfile } = await import("./profile");

      const work = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-pid-")));
      const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-pidtmp-")));
      const out = path.join(work, "pids.txt");
      const env = { PATH: "/usr/bin:/bin", HOME: homedir() };
      const inner = new RealProcessAdapter({ allowRealSubprocess: true, timeoutMs: 8000 });

      /** Count the processes visible to a command run under `mode`. */
      const visibleProcesses = (mode: "sandboxed" | "control"): number => {
        if (existsSync(out)) rmSync(out);
        const base = defaultSandboxProfile(work, tmp, homedir());
        const profile =
          mode === "control"
            ? { ...base, mode: "danger-full-access" as const } // adapter skips containment
            : base;
        const adapter = new SandboxedProcessAdapter({
          profile,
          inner,
          platform: process.platform,
          launcherAvailable: launcher.available,
          ...(launcher.path ? { bwrapPath: launcher.path } : {}),
        });
        adapter.spawn({
          path: "/bin/sh",
          argv: ["sh", "-c", `ps -e -o pid= | wc -l > ${out}`],
          env,
          cwd: work,
        });
        if (!existsSync(out)) return -1;
        return Number.parseInt(readFileSync(out, "utf8").trim(), 10);
      };

      try {
        // CONTROL (the allowed half of the pair): uncontained, `ps` works and
        // sees the whole machine. Without this, "few processes" could equally
        // mean the sandbox never launched or `ps` is missing — the failure mode
        // that makes a broken sandbox look like a perfect one.
        const host = visibleProcesses("control");
        expect(host).toBeGreaterThan(10);

        // DENIED half: inside the PID namespace only the namespace's own
        // processes exist (the shell, ps, wc — a handful).
        const contained = visibleProcesses("sandboxed");
        expect(contained).toBeGreaterThan(0); // ps still RAN — not a silent failure
        expect(contained).toBeLessThan(host);
        expect(contained).toBeLessThan(10);
      } finally {
        if (existsSync(out)) rmSync(out);
        rmSync(work, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
