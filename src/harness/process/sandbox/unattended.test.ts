// Flow 290 T13 (AC13): the hardened unattended sandbox.
//
// Two halves. The refusal half is deterministic (injected platform/launcher/
// probe). The containment half runs REAL commands under the real launcher and
// probes what they can see — it is skipped only where bwrap cannot create a
// sandbox at all, which is itself the case `planUnattendedSandbox` refuses.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { planUnattendedSandbox, toolchainRoots, UNATTENDED_ENV_ALLOWLIST, type UnattendedSandboxInput } from "./unattended";

function input(overrides: Partial<UnattendedSandboxInput> = {}): UnattendedSandboxInput {
  return {
    worktree: "/tmp/wt",
    scratchHome: "/tmp/wt-home",
    network: false,
    readOnly: [],
    env: { PATH: "/usr/bin:/bin" },
    home: homedir(),
    platform: "linux",
    detect: { existsSync: (p) => p === "/usr/bin/bwrap" },
    probe: () => true,
    ...overrides,
  };
}

describe("AC13: an unattended run never runs uncontained — every opt-out and every gap refuses", () => {
  test("KERYX_DANGEROUSLY_DISABLE_SANDBOX=1 refuses", () => {
    const plan = planUnattendedSandbox(input({ env: { PATH: "/usr/bin", KERYX_DANGEROUSLY_DISABLE_SANDBOX: "1" } }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("KERYX_DANGEROUSLY_DISABLE_SANDBOX=1");
  });

  test.each(["off", "0", "false"])("KERYX_SANDBOX_SHELL=%s refuses", (value) => {
    const plan = planUnattendedSandbox(input({ env: { PATH: "/usr/bin", KERYX_SANDBOX_SHELL: value } }));
    expect(plan.ok).toBe(false);
  });

  test("a non-Linux host refuses (the hardened profile is bwrap-only in this version)", () => {
    const plan = planUnattendedSandbox(input({ platform: "darwin" }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("Linux (bubblewrap) only");
  });

  test("no launcher on PATH refuses", () => {
    const plan = planUnattendedSandbox(input({ detect: { existsSync: () => false } }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("no sandbox launcher");
  });

  test("a launcher that cannot create a namespace refuses", () => {
    const plan = planUnattendedSandbox(input({ probe: () => false }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("cannot create a sandbox");
  });
});

describe("AC13: the plan is built from allow lists", () => {
  test("env: only the allowlist passes; HOME/XDG/TMPDIR point at the scratch home; tokens and SSH_AUTH_SOCK do not pass", () => {
    const plan = planUnattendedSandbox(
      input({
        env: {
          PATH: "/usr/bin",
          LANG: "C.UTF-8",
          GITHUB_TOKEN: "ghp_secret",
          GH_TOKEN: "x",
          ANTHROPIC_API_KEY: "sk",
          SSH_AUTH_SOCK: "/run/user/1000/ssh.sock",
          AWS_SECRET_ACCESS_KEY: "y",
        },
      }),
    );
    if (!plan.ok) throw new Error(plan.reason);
    const names = Object.keys(plan.env).sort();
    for (const name of names) {
      expect([...UNATTENDED_ENV_ALLOWLIST, "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "BUN_INSTALL_CACHE_DIR", "TMPDIR", "KERYX_TOOL_CALL"]).toContain(name);
    }
    expect(plan.env["GITHUB_TOKEN"]).toBeUndefined();
    expect(plan.env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(plan.env["HOME"]).toBe("/tmp/wt-home");
    expect(plan.env["TMPDIR"]).toBe("/tmp");
  });

  test("filesystem: home hidden wholesale, private /tmp (host /tmp never re-bound), network unshared by default", () => {
    const plan = planUnattendedSandbox(input());
    if (!plan.ok) throw new Error(plan.reason);
    const args = plan.args.join(" ");
    expect(args).toContain(`--tmpfs ${homedir()}`);
    expect(args).toContain("--tmpfs /tmp");
    expect(plan.args.filter((a) => a === tmpdir() || a === "/tmp").length).toBe(1); // only the tmpfs mount point
    expect(plan.args).toContain("--unshare-net");
  });

  test("T14: /run is hidden wholesale (not socket-by-socket), and resolv.conf is bound back only for network: true", () => {
    const off = planUnattendedSandbox(input());
    if (!off.ok) throw new Error(off.reason);
    expect(off.args.join(" ")).toContain("--tmpfs /run");
    expect(off.args.join(" ")).not.toContain("docker.sock");
    const on = planUnattendedSandbox(input({ network: true }));
    if (!on.ok) throw new Error(on.reason);
    const resolvIdx = on.args.findIndex((a, i) => a === "--ro-bind" && on.args[i + 1]?.includes("resolv"));
    // Only when this host's /etc/resolv.conf points into a hidden dir; never a directory.
    if (resolvIdx >= 0) expect(on.args[resolvIdx + 1]).toMatch(/resolv\.conf$/);
  });

  test("dispatch.network: true is the only way to keep the network", () => {
    const plan = planUnattendedSandbox(input({ network: true }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.args).not.toContain("--unshare-net");
  });

  test("toolchain roots come from PATH entries under home, never home itself nor ~/.local", () => {
    const home = homedir();
    const roots = toolchainRoots(`${home}/.bun/bin:/usr/bin:${home}/.local/bin:${home}`, home);
    expect(roots).not.toContain(home);
    expect(roots).not.toContain(path.join(home, ".local"));
    for (const root of roots) expect(root.startsWith(home)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live containment — real bwrap, real probes.
// ---------------------------------------------------------------------------

const live = planUnattendedSandbox({
  worktree: tmpdir(),
  scratchHome: tmpdir(),
  network: false,
  readOnly: [],
  env: process.env,
  home: homedir(),
});
const liveAvailable = live.ok;

describe.skipIf(!liveAvailable)("AC13 (live): what a command inside the unattended sandbox can reach", () => {
  let base = "";
  let worktree = "";
  let scratch = "";
  let hostMarker = "";
  let homeMarkerDir = "";
  const savedToken = process.env["KERYX_T13_FAKE_TOKEN"];

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "keryx-unattended-live-"));
    worktree = path.join(base, "wt");
    scratch = path.join(base, "home");
    await mkdir(worktree);
    await mkdir(scratch);
    hostMarker = path.join(tmpdir(), `keryx-t13-host-marker-${process.pid}`);
    await writeFile(hostMarker, "host tmp\n");
    // A machine-specific credential dir the old deny list did not know about.
    homeMarkerDir = await mkdtemp(path.join(homedir(), ".keryx-t13-gh-work-"));
    await writeFile(path.join(homeMarkerDir, "hosts.yml"), "oauth_token: gho_fake\n");
    process.env["KERYX_T13_FAKE_TOKEN"] = "ghp_should_not_pass";
  });

  afterAll(async () => {
    if (savedToken === undefined) delete process.env["KERYX_T13_FAKE_TOKEN"];
    else process.env["KERYX_T13_FAKE_TOKEN"] = savedToken;
    await rm(base, { recursive: true, force: true });
    await rm(hostMarker, { force: true });
    await rm(homeMarkerDir, { recursive: true, force: true });
  });

  function runInside(command: string, network = false): { code: number; out: string } {
    const plan = planUnattendedSandbox({
      worktree,
      scratchHome: scratch,
      network,
      readOnly: [],
      env: process.env,
      home: homedir(),
    });
    if (!plan.ok) throw new Error(plan.reason);
    const argv = plan.wrap(["/bin/sh", "-c", command]);
    try {
      const out = execFileSync(argv[0]!, argv.slice(1), { cwd: worktree, env: plan.env, stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out: out.toString() };
    } catch (error) {
      const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? 1, out: `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}` };
    }
  }

  // Positive control first: every "cannot see X" below would pass vacuously if
  // the sandbox failed to start at all (observed while writing these tests).
  test("control: a trivial command runs inside the sandbox", () => {
    const result = runInside("echo alive");
    expect(result).toEqual({ code: 0, out: "alive\n" });
  });

  test("a machine-specific credential dir under $HOME (e.g. ~/.config/gh-work) is invisible", () => {
    expect(runInside("true").code).toBe(0);
    expect(runInside(`cat ${JSON.stringify(path.join(homeMarkerDir, "hosts.yml"))}`).code).not.toBe(0);
  });

  test("an exported token and SSH_AUTH_SOCK are not in the environment", () => {
    const { code, out } = runInside("env");
    expect(code).toBe(0);
    expect(out).not.toContain("ghp_should_not_pass");
    expect(out).not.toContain("SSH_AUTH_SOCK");
  });

  test("the host's /tmp is not visible; the sandbox /tmp is private", () => {
    expect(runInside("test -d /tmp").code).toBe(0);
    expect(runInside(`cat ${JSON.stringify(hostMarker)}`).code).not.toBe(0);
  });

  test("network is off: only the loopback interface exists", () => {
    // /proc/net/dev reflects the process's own network namespace (the sandbox
    // mounts a fresh /proc); /sys/class/net would show the host's, bound read-only.
    const { code, out } = runInside("tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '");
    expect(code).toBe(0);
    expect(out.trim().split(/\s+/)).toEqual(["lo"]);
  });

  test("the worktree and the scratch home are writable; the real home is not", async () => {
    expect(runInside("echo ok > inside.txt && echo ok > \"$HOME/h.txt\"").code).toBe(0);
    expect((await readFile(path.join(worktree, "inside.txt"), "utf8")).trim()).toBe("ok");
    expect((await readFile(path.join(scratch, "h.txt"), "utf8")).trim()).toBe("ok");
    const realHomeWrite = path.join(homedir(), `.keryx-t13-should-not-exist-${process.pid}`);
    runInside(`echo x > ${JSON.stringify(realHomeWrite)}`);
    await expect(readFile(realHomeWrite, "utf8")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Flow 290 T14 (security re-review): `--unshare-net` does not isolate AF_UNIX
  // PATH sockets. /run is where the host's services listen — it must be hidden.
  // -------------------------------------------------------------------------

  test(
    "T14: no unix socket anywhere is visible inside the sandbox (find / -type s is empty); /run is empty",
    () => {
      const control = runInside("echo alive");
      expect(control.code).toBe(0);
      // Still scans the WHOLE sandbox root — this is a security regression
      // test (flow 290's re-review: `--unshare-net` does not isolate AF_UNIX
      // PATH sockets), and a host socket could in principle sit anywhere
      // reachable through `planUnattendedSandbox`'s `--ro-bind / /` — under
      // `/var/lib` (docker, containerd, snapd runtime state), `/srv`, `/opt`,
      // `/mnt`, the project directory itself, and so on. Narrowing the scan to
      // "the paths we already believe matter" would make this a test of our
      // own assumptions rather than a closure over the filesystem, which is
      // exactly what a deny-list (the profile this replaced, see
      // `unattended.ts`'s own header) gets wrong.
      //
      // What IS pruned is chosen because it cannot hold a LIVE HOST socket
      // reachable through the read-only bind, not because it seems unlikely:
      //   /proc, /sys  pseudo-filesystems (synthetic per-process/per-device
      //                state), not on-disk trees a socket file lives in.
      //   /usr         a static, read-only installed-package tree; nothing
      //                binds a listening socket under a package prefix.
      //   /dev         `planUnattendedSandbox` passes `--dev /dev`, bwrap's
      //                OWN fresh devtmpfs — never the host's `/dev` — so
      //                anything under it reflects the sandbox, not the host,
      //                by construction, whether or not this fix is correct.
      //   /nix/store,
      //   /snap        present only on some hosts; when present, the same
      //                static-read-only-package-tree reasoning as `/usr`.
      // These are also the large, expensive-to-walk trees, so pruning them is
      // both correctness-preserving and most of why the unpruned scan was
      // slow. Everywhere else — `/run`, `/var/run`, `/home`, `/var/lib`,
      // `/opt`, `/srv`, `/mnt`, the worktree, etc. — is walked in full.
      const found = runInside(
        "find / \\( -path /proc -o -path /sys -o -path /usr -o -path /dev -o -path /nix/store -o -path /snap \\) -prune -o -type s -print 2>/dev/null; echo end",
      );
      expect(found.out.trim()).toBe("end");
      expect(runInside("ls -A /run").out.trim()).toBe("");
    },
    // This still shells out to a real bwrap sandbox and a real `find` over
    // live filesystem state (not test-controlled), so it is not a pure
    // in-process assertion bun's 5s default was sized for — kept generous to
    // absorb a genuinely slower or busier CI host without masking a real
    // hang; a sandbox or `find` that is actually stuck would still fail
    // loudly well before this.
    20_000,
  );

  test.each([
    ["resolvectl", "resolvectl query github.com"],
    ["busctl", "busctl list"],
  ])("T14: %s (systemd-resolved / system D-Bus) cannot reach its service", (tool, command) => {
    expect(runInside("echo alive").code).toBe(0);
    if (runInside(`command -v ${tool}`).code !== 0) return; // tool absent on this host: nothing to reach
    expect(runInside(command).code).not.toBe(0);
  });

  test("T14: a unix socket the test itself listens on under the host /run is unreachable from inside", async () => {
    // /run/lock is world-writable (1777) on common distros and is NOT the
    // per-user runtime dir — so only hiding /run itself can make this
    // unreachable (a socket in $XDG_RUNTIME_DIR would be hidden by that rule
    // alone and prove nothing about /run).
    const runSide = "/run/lock";
    const { accessSync, constants } = await import("node:fs");
    try {
      accessSync(runSide, constants.W_OK);
    } catch {
      return; // no world-writable dir under /run on this host
    }
    const { createServer, connect } = await import("node:net");
    const sock = path.join(runSide, `keryx-t14-${process.pid}.sock`);
    const server = createServer((c) => c.end("hello from the host\n"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, () => resolve());
    });
    try {
      // Positive control: from the host the socket answers.
      const greeting = await new Promise<string>((resolve, reject) => {
        const c = connect(sock);
        let data = "";
        c.on("data", (d) => (data += d.toString()));
        c.on("end", () => resolve(data));
        c.on("error", reject);
      });
      expect(greeting).toContain("hello from the host");
      expect(runInside("echo alive").code).toBe(0);
      expect(runInside(`test -S ${JSON.stringify(sock)}`).code).not.toBe(0);
      const bun = process.execPath;
      const attempt = runInside(
        `${JSON.stringify(bun)} -e 'const n = require("node:net"); const c = n.connect(${JSON.stringify(sock)}); c.on("data", d => { process.stdout.write("REACHED " + d); process.exit(0) }); c.on("error", () => { process.stdout.write("unreachable"); process.exit(3) })'`,
      );
      expect(attempt.out).not.toContain("REACHED");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("T14: abstract-namespace sockets are per network namespace — invisible with network off, visible with network on", async () => {
    const { createServer } = await import("node:net");
    const name = `keryx-t14-abstract-${process.pid}`;
    const server = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(`\0${name}`, () => resolve());
    });
    try {
      // Positive control: the host sees it.
      expect((await readFile("/proc/net/unix", "utf8")).includes(`@${name}`)).toBe(true);
      const off = runInside(`grep -c ${JSON.stringify(`@${name}`)} /proc/net/unix`);
      expect(off.out.trim()).toBe("0");
      // Documented consequence of `dispatch.network: true`: the host netns is
      // shared, and so are its abstract sockets.
      const on = runInside(`grep -c ${JSON.stringify(`@${name}`)} /proc/net/unix`, true);
      expect(on.out.trim()).toBe("1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
