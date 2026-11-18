// The hardened unattended sandbox on macOS (Seatbelt).
//
// Two halves, like unattended.test.ts. The plan half is deterministic (injected
// platform, launcher, probe and filesystem) and runs on any host. The containment
// half runs REAL commands under the real `sandbox-exec` and checks what they can
// do; it runs only on macOS where sandbox-exec can apply a profile (not inside
// another sandbox), which is exactly the case the planner refuses otherwise.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { planUnattendedSandbox, type UnattendedSandboxInput } from "./unattended";
import { DARWIN_DNS_SOCKET } from "./unattended-seatbelt";

const HOME = "/Users/op";

function darwinInput(overrides: Partial<UnattendedSandboxInput> = {}): UnattendedSandboxInput {
  const dirs = new Set([HOME, "/scratch", "/Users/op/.bun", "/Users/op/.ssh", "/repo", "/scratch/run/work", "/scratch/run/home", "/Users/op/.local/share/keryx", "/T"]);
  return {
    worktree: "/scratch/run/work",
    scratchHome: "/scratch/run/home",
    network: false,
    readOnly: ["/repo"],
    hide: ["/scratch"],
    env: { PATH: "/Users/op/.bun/bin:/usr/bin:/bin", SSH_AUTH_SOCK: "/tmp/agent.sock", GITHUB_TOKEN: "ghp_secret", TZ: "UTC" },
    home: HOME,
    platform: "darwin",
    detect: {
      existsSync: (p) => p === "/usr/bin/sandbox-exec" || dirs.has(p) || p === "/Users/op/.bun/bin",
      isDir: (p) => dirs.has(p),
      realpath: (p) => p,
      readText: () => undefined,
      listDir: () => [],
      userTempDir: "/T",
    },
    probe: () => true,
    ...overrides,
  };
}

function profileOf(plan: ReturnType<typeof planUnattendedSandbox>): string {
  if (!plan.ok) throw new Error(`expected a plan, got a refusal: ${plan.reason}`);
  const i = plan.args.indexOf("-p");
  return plan.args[i + 1] ?? "";
}

describe("macOS unattended plan: refusals", () => {
  test("network allowlist refuses on macOS — never silently downgraded", () => {
    const plan = planUnattendedSandbox(
      darwinInput({ network: { mode: "allowlist", proxySocketPath: "/scratch/p.sock", forwarderArgv: ["keryx", "__sandbox-net-forward"] } }),
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('network "allowlist"');
  });

  test("no sandbox-exec refuses", () => {
    const plan = planUnattendedSandbox(darwinInput({ detect: { ...darwinInput().detect, existsSync: () => false } }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("no sandbox launcher");
  });

  test("a sandbox-exec that cannot apply a profile (nested sandbox) refuses", () => {
    const plan = planUnattendedSandbox(darwinInput({ probe: () => false }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("cannot apply a profile");
  });

  test("the opt-outs refuse on macOS too", () => {
    expect(planUnattendedSandbox(darwinInput({ env: { PATH: "/usr/bin", KERYX_DANGEROUSLY_DISABLE_SANDBOX: "1" } })).ok).toBe(false);
    expect(planUnattendedSandbox(darwinInput({ env: { PATH: "/usr/bin", KERYX_SANDBOX_SHELL: "off" } })).ok).toBe(false);
  });
});

describe("macOS unattended plan: the profile", () => {
  test("a Seatbelt plan: named, wrapped by sandbox-exec, TMPDIR inside the scratch home", () => {
    const plan = planUnattendedSandbox(darwinInput());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe("seatbelt");
    expect(plan.label).toBe("macOS Seatbelt");
    const argv = plan.wrap(["/bin/sh", "-c", "date"]);
    expect(argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(argv[1]).toBe("-p");
    expect(argv.slice(-3)).toEqual(["/bin/sh", "-c", "date"]);
    expect(plan.env["HOME"]).toBe("/scratch/run/home");
    expect(plan.env["TMPDIR"]).toBe("/scratch/run/home/tmp");
    expect(plan.env["TZ"]).toBe("UTC");
    expect(plan.env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(plan.env["GITHUB_TOKEN"]).toBeUndefined();
  });

  test("hides $HOME, keryx's config, the scratch parent and the host temp dirs wholesale", () => {
    const profile = profileOf(planUnattendedSandbox(darwinInput()));
    const hideLine = profile.split("\n").find((l) => l.startsWith("(deny file-read* file-write* (subpath \"/private/tmp\")")) ?? "";
    for (const dir of ["/private/tmp", "/private/var/tmp", "/private/var/folders", HOME, "/Users/op/.local/share/keryx", "/scratch"]) {
      expect(hideLine).toContain(`(subpath "${dir}")`);
    }
  });

  test("writes are denied everywhere except the worktree and the scratch home", () => {
    const profile = profileOf(planUnattendedSandbox(darwinInput()));
    const lines = profile.split("\n");
    const denyAll = lines.indexOf('(deny file-write* (subpath "/"))');
    const allowRw = lines.findIndex((l) => l === '(allow file-read* file-write* (subpath "/scratch/run/work") (subpath "/scratch/run/home"))');
    expect(denyAll).toBeGreaterThan(-1);
    expect(allowRw).toBeGreaterThan(denyAll);
    expect(profile).not.toContain('(allow file-write* (subpath "/repo"))');
  });

  test("toolchain and read-only roots come back read-only; secrets inside them are denied again after", () => {
    const profile = profileOf(planUnattendedSandbox(darwinInput()));
    const lines = profile.split("\n");
    const readBack = lines.findIndex((l) => l.startsWith("(allow file-read* ") && l.includes('(subpath "/Users/op/.bun")') && l.includes('(subpath "/repo")'));
    const secrets = lines.findIndex((l) => l.startsWith("(deny file-read* file-write* ") && l.includes('(subpath "/Users/op/.ssh")'));
    expect(readBack).toBeGreaterThan(-1);
    expect(secrets).toBeGreaterThan(readBack);
    expect(profile).toContain('(allow file-read-metadata (literal "/Users/op")');
  });

  test("network off denies every socket; full allows IP but only the DNS resolver's UNIX socket", () => {
    const off = profileOf(planUnattendedSandbox(darwinInput()));
    expect(off).toContain("(deny network*)");
    const full = profileOf(planUnattendedSandbox(darwinInput({ network: true })));
    expect(full).not.toContain("(deny network*)");
    expect(full).toContain("(deny network-outbound (remote unix-socket))");
    expect(full).toContain(`(path-literal "${DARWIN_DNS_SOCKET}")`);
  });

  test("keychain, pasteboard, launchd handoff and signals to other processes are denied", () => {
    const profile = profileOf(planUnattendedSandbox(darwinInput()));
    expect(profile).toContain('(global-name "com.apple.SecurityServer")');
    expect(profile).toContain('(global-name-prefix "com.apple.pasteboard")');
    expect(profile).toContain('(literal "/bin/launchctl")');
    expect(profile).toContain('(literal "/usr/bin/security")');
    expect(profile).toContain("(deny signal (target others))");
  });
});

// --- containment: real sandbox-exec ------------------------------------------

function seatbeltWorks(): boolean {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return false;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!seatbeltWorks())("macOS unattended containment (real sandbox-exec)", () => {
  let base = "";
  let worktree = "";
  let scratchHome = "";
  let outside = "";
  let run: (command: string, network?: boolean) => { status: number | null; stdout: string; stderr: string };

  beforeAll(async () => {
    base = realpathSync(await mkdtemp(path.join(tmpdir(), "keryx-unattended-darwin-")));
    worktree = path.join(base, "run", "work");
    scratchHome = path.join(base, "run", "home");
    outside = path.join(base, "outside");
    await mkdir(worktree, { recursive: true });
    await mkdir(scratchHome, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "top secret\n");
    execFileSync("git", ["init", "-q", worktree]);
    run = (command, network = false) => {
      const plan = planUnattendedSandbox({
        worktree,
        scratchHome,
        network,
        readOnly: [],
        hide: [path.join(base, "run")],
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        home: homedir(),
      });
      if (!plan.ok) throw new Error(plan.reason);
      const argv = plan.wrap(["/bin/sh", "-c", command]);
      const r = spawnSync(argv[0] ?? "", argv.slice(1), { cwd: worktree, env: plan.env, encoding: "utf8", timeout: 30_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
  });

  afterAll(async () => {
    if (base.length > 0) await rm(base, { recursive: true, force: true });
  });

  test("runs `TZ=America/New_York date` inside the sandbox", () => {
    const r = run("TZ=America/New_York date +%Z");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^E[SD]T$/);
  });

  test("writes inside the worktree and TMPDIR work", () => {
    const r = run('echo ok > inside.txt && cat inside.txt && f=$(mktemp "$TMPDIR/x.XXXXXX") && echo tmp > "$f" && cat "$f"');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ok\ntmp\n");
  });

  test("a write outside the project is refused and leaves nothing behind", () => {
    const target = path.join(outside, "escape.txt");
    const r = run(`echo pwned > '${target}'`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Operation not permitted");
    expect(existsSync(target)).toBe(false);
  });

  test("a write into $HOME is refused", () => {
    const target = path.join(homedir(), `.keryx-unattended-escape-${process.pid}`);
    const r = run(`echo pwned > '${target}'`);
    expect(r.status).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  test("$HOME, the host temp dir and other scratch content cannot be read", () => {
    expect(run(`ls '${homedir()}'`).status).not.toBe(0);
    expect(run(`cat '${path.join(outside, "secret.txt")}'`).status).not.toBe(0);
    expect(run("ls /private/tmp").status).not.toBe(0);
  });

  test("the repository's git hooks cannot be written", () => {
    const r = run("mkdir -p .git/hooks && echo 'echo pwned' > .git/hooks/post-checkout");
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(worktree, ".git", "hooks", "post-checkout"))).toBe(false);
  });

  test("network off: no socket can be opened, the UNIX DNS socket included", () => {
    const r = run(`/usr/bin/nc -U ${DARWIN_DNS_SOCKET} </dev/null; echo "rc=$?"`);
    expect(r.stdout).not.toContain("rc=0");
  });

  test("the keychain CLI and launchctl cannot be executed", () => {
    expect(run("/usr/bin/security list-keychains").status).not.toBe(0);
    expect(run("/bin/launchctl list").status).not.toBe(0);
  });
});
