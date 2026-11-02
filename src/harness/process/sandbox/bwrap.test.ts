import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import {
  BWRAP_PROGRAM,
  NO_GIT_PROTECTION,
  buildBwrapArgs,
  gitProtectBwrapArgs,
  hostBwrapOptions,
  inspectMaskTarget,
  pathEntriesUnderHidden,
  wrapBwrap,
} from "./bwrap";
import type { MaskTargetKind, PathBindProbe } from "./bwrap";
import type { GitControlEntry, GitProtection } from "./git-protect";
import type { SandboxProfile } from "./profile";
import type { ContainedCommand } from "../executor";

/** Classify every read-deny path as a directory (the pre-existing test fixture). */
const asDir = (): MaskTargetKind => "dir";

const workspaceWrite: SandboxProfile = {
  mode: "workspace-write",
  network: "off",
  writableRoots: ["/work/repo", "/tmp/session"],
  readDenyList: ["/home/u/.ssh"],
  allowedDomains: [],
  required: true,
};

const command: ContainedCommand = {
  path: "/bin/echo",
  argv: ["echo", "hi"],
  env: { PATH: "/usr/bin" },
  cwd: "/work/repo",
};

/** Find the index of a flag+value pair in an argv array. */
function hasPair(args: string[], flag: string, a: string, b?: string): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] === a && (b === undefined || args[i + 2] === b)) return true;
  }
  return false;
}

describe("buildBwrapArgs", () => {
  test("root is bound read-only", () => {
    expect(hasPair(buildBwrapArgs(workspaceWrite, asDir), "--ro-bind", "/", "/")).toBe(true);
  });

  test("writable roots are re-bound RW", () => {
    const args = buildBwrapArgs(workspaceWrite, asDir);
    expect(hasPair(args, "--bind", "/work/repo", "/work/repo")).toBe(true);
    expect(hasPair(args, "--bind", "/tmp/session", "/tmp/session")).toBe(true);
  });

  test("secrets are masked with tmpfs", () => {
    expect(hasPair(buildBwrapArgs(workspaceWrite, asDir), "--tmpfs", "/home/u/.ssh")).toBe(true);
  });

  test("network off unshares net", () => {
    expect(buildBwrapArgs(workspaceWrite, asDir)).toContain("--unshare-net");
  });

  test("network on keeps host net (no --unshare-net)", () => {
    expect(buildBwrapArgs({ ...workspaceWrite, network: "on" }, asDir)).not.toContain("--unshare-net");
  });

  test("read-only mode has no RW binds beyond tmpfs /tmp", () => {
    const args = buildBwrapArgs(
      { ...workspaceWrite, mode: "read-only", writableRoots: [] },
      asDir,
    );
    expect(hasPair(args, "--bind", "/work/repo", "/work/repo")).toBe(false);
  });

  test("hardening flags present", () => {
    const args = buildBwrapArgs(workspaceWrite, asDir);
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    expect(args).toContain("--unshare-ipc");
  });

  test("a PID namespace is unshared, so the host process table is not visible", () => {
    // Without --unshare-pid a contained command enumerates every process on the
    // machine and can signal any owned by the same user (stress finding S4).
    const args = buildBwrapArgs(workspaceWrite, asDir);
    expect(args).toContain("--unshare-pid");
  });

  test("--unshare-pid is paired with --proc, which a new PID namespace requires", () => {
    // A PID namespace without a fresh /proc mount leaves the contained process
    // reading the HOST's /proc — the flag would then be cosmetic.
    const args = buildBwrapArgs(workspaceWrite, asDir);
    expect(hasPair(args, "--proc", "/proc")).toBe(true);
    expect(args.indexOf("--proc")).toBeLessThan(args.indexOf("--unshare-pid"));
  });

  test("deterministic", () => {
    expect(buildBwrapArgs(workspaceWrite, asDir)).toEqual(buildBwrapArgs(workspaceWrite, asDir));
  });

  test("a secret FILE is masked with /dev/null, not tmpfs", () => {
    const profile = { ...workspaceWrite, readDenyList: ["/home/u/.netrc"] };
    const args = buildBwrapArgs(profile, () => "file");
    expect(hasPair(args, "--ro-bind", "/dev/null", "/home/u/.netrc")).toBe(true);
    expect(hasPair(args, "--tmpfs", "/home/u/.netrc")).toBe(false);
  });

  test("a secret path that does not exist is skipped entirely", () => {
    // Regression: mounting over a missing path aborts bwrap with
    // "Can't mkdir …: Read-only file system" because / is bound read-only.
    const args = buildBwrapArgs(workspaceWrite, () => "missing");
    expect(args).not.toContain("/home/u/.ssh");
  });
});

// review-security-code-w5:F-001 / F-002 — host IPC and repository control files.
const noHost = { git: NO_GIT_PROTECTION, ipcDirs: [] };

describe("buildBwrapArgs: host IPC services are unreachable (F-001)", () => {
  test("/run, /var/run and a runtime dir outside /run are hidden behind an empty tmpfs", () => {
    const args = buildBwrapArgs(workspaceWrite, asDir, { git: NO_GIT_PROTECTION, ipcDirs: ["/run", "/var/run", "/xdg"] });
    expect(hasPair(args, "--tmpfs", "/run")).toBe(true);
    expect(hasPair(args, "--tmpfs", "/var/run")).toBe(true);
    expect(hasPair(args, "--tmpfs", "/xdg")).toBe(true);
  });

  test("the hide comes after the root bind and before the writable binds, so a session tmp under /run still re-binds", () => {
    const args = buildBwrapArgs({ ...workspaceWrite, writableRoots: ["/run/user/1000/s"] }, asDir, {
      git: NO_GIT_PROTECTION,
      ipcDirs: ["/run"],
    });
    const hide = args.indexOf("/run");
    expect(args[hide - 1]).toBe("--tmpfs");
    expect(args.indexOf("--ro-bind")).toBeLessThan(hide);
    expect(hide).toBeLessThan(args.indexOf("--bind"));
  });

  test("the allowed half: nothing is hidden when the host has no such dir, and the root bind is untouched", () => {
    const args = buildBwrapArgs(workspaceWrite, asDir, noHost);
    expect(hasPair(args, "--tmpfs", "/run")).toBe(false);
    expect(hasPair(args, "--bind", "/work/repo", "/work/repo")).toBe(true);
  });

  test("network on binds the resolv.conf target back read-only after hiding /run", () => {
    const args = buildBwrapArgs({ ...workspaceWrite, network: "on" }, asDir, {
      git: NO_GIT_PROTECTION,
      ipcDirs: ["/run"],
      resolvConf: "/run/systemd/resolve/stub-resolv.conf",
    });
    const hide = args.indexOf("/run");
    const bind = args.indexOf("/run/systemd/resolve/stub-resolv.conf");
    expect(args[bind - 1]).toBe("--ro-bind");
    expect(bind).toBeGreaterThan(hide);
  });

  test("hostBwrapOptions: XDG_RUNTIME_DIR outside /run is hidden, with no duplicates", () => {
    const dir = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "keryx-xdg-")));
    try {
      const opts = hostBwrapOptions(workspaceWrite, { XDG_RUNTIME_DIR: dir });
      expect(opts.ipcDirs).toContain(dir);
      expect(new Set(opts.ipcDirs).size).toBe(opts.ipcDirs.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const ctl = (p: string, entry: GitControlEntry, kind: "dir" | "file" | "missing") => ({ path: p, real: p, entry, kind });

describe("buildBwrapArgs: the git control files stay read-only inside the writable root (F-002)", () => {
  test("hooks and config are re-bound read-only AFTER the RW root bind", () => {
    const git: GitProtection = {
      controls: [ctl("/work/repo/.git/config", "config", "file"), ctl("/work/repo/.git/hooks", "hooks", "dir")],
      anchors: ["/work/repo/.git"],
    };
    const args = buildBwrapArgs(workspaceWrite, asDir, { git, ipcDirs: [] });
    const rw = args.indexOf("--bind");
    for (const g of ["/work/repo/.git/config", "/work/repo/.git/hooks"]) {
      expect(hasPair(args, "--ro-bind", g, g)).toBe(true);
      expect(args.indexOf(g)).toBeGreaterThan(rw);
    }
  });

  // review-security-code-w2:F-002 / review-logic-w3:F-002 (2): Linux refuses
  // rename(2) only for a dentry that is itself a mount point, so `.git` must be one.
  test("the git dir is bound onto itself (a mount point cannot be renamed), before the control binds inside it", () => {
    const git: GitProtection = { controls: [ctl("/work/repo/.git/config", "config", "file")], anchors: ["/work/repo/.git"] };
    const args = buildBwrapArgs(workspaceWrite, asDir, { git, ipcDirs: [] });
    expect(hasPair(args, "--bind", "/work/repo/.git", "/work/repo/.git")).toBe(true);
    const anchorAt = args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/work/repo/.git");
    expect(anchorAt).toBeGreaterThan(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/work/repo"));
    expect(anchorAt).toBeLessThan(args.indexOf("/work/repo/.git/config"));
  });

  // review-security-code-w2:F-001 / review-logic-w3:F-002 (1): a missing path needs a mount point.
  test("a missing hooks dir gets a read-only empty tmpfs; a missing config / config.worktree a /dev/null file", () => {
    const git: GitProtection = {
      controls: [
        ctl("/work/repo/.git/config.worktree", "config.worktree", "missing"),
        ctl("/work/repo/.git/hooks", "hooks", "missing"),
      ],
      anchors: ["/work/repo/.git"],
    };
    const args = buildBwrapArgs(workspaceWrite, asDir, { git, ipcDirs: [] });
    expect(hasPair(args, "--tmpfs", "/work/repo/.git/hooks")).toBe(true);
    expect(hasPair(args, "--remount-ro", "/work/repo/.git/hooks")).toBe(true);
    expect(args.indexOf("--remount-ro")).toBeGreaterThan(args.indexOf("--tmpfs", args.indexOf("/work/repo")));
    expect(hasPair(args, "--ro-bind", "/dev/null", "/work/repo/.git/config.worktree")).toBe(true);
  });

  test("a missing commondir gets NO mount point: an empty one would make git die, inside and on the host", () => {
    const git: GitProtection = { controls: [ctl("/work/repo/.git/commondir", "commondir", "missing")], anchors: ["/work/repo/.git"] };
    expect(gitProtectBwrapArgs(git)).toEqual(["--bind", "/work/repo/.git", "/work/repo/.git"]);
  });

  test("an existing control path is bound at its real path", () => {
    const git: GitProtection = {
      controls: [{ path: "/work/repo/.git/hooks", real: "/work/repo/githooks", entry: "hooks", kind: "dir" }],
      anchors: [],
    };
    expect(gitProtectBwrapArgs(git)).toEqual(["--ro-bind", "/work/repo/githooks", "/work/repo/githooks"]);
  });

  test("a real repo on disk resolves to its control files and anchor through hostBwrapOptions", () => {
    const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "keryx-gitprot-")));
    try {
      mkdirSync(nodePath.join(root, ".git"), { recursive: true }); // no hooks dir
      writeFileSync(nodePath.join(root, ".git", "config"), "[core]\n");
      const profile = { ...workspaceWrite, writableRoots: [root] };
      const args = buildBwrapArgs(profile, asDir, hostBwrapOptions(profile, {}));
      const dotGit = nodePath.join(root, ".git");
      const hooks = nodePath.join(dotGit, "hooks");
      const config = nodePath.join(dotGit, "config");
      expect(hasPair(args, "--bind", dotGit, dotGit)).toBe(true);
      expect(hasPair(args, "--tmpfs", hooks)).toBe(true);
      expect(hasPair(args, "--ro-bind", config, config)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // review-logic-w3:F-001: a bind follows a symlink, so an anchor on `.git -> outside`
  // mounted the outside git dir READ-WRITE. No read-write bind may name the link or
  // its target; the outside git dir stays under the read-only `/`.
  test.each(["absolute", "relative"])("a %s `.git` symlink to a git dir outside the roots gets no read-write bind", (form) => {
    const base = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "keryx-gitlink-")));
    try {
      const outside = nodePath.join(base, "outside", "g.git");
      mkdirSync(nodePath.join(outside, "hooks"), { recursive: true });
      writeFileSync(nodePath.join(outside, "config"), "[core]\n");
      writeFileSync(nodePath.join(outside, "HEAD"), "ref: refs/heads/main\n");
      const root = nodePath.join(base, "root");
      mkdirSync(root);
      symlinkSync(form === "absolute" ? outside : nodePath.relative(root, outside), nodePath.join(root, ".git"));
      const profile = { ...workspaceWrite, writableRoots: [root] };
      const host = hostBwrapOptions(profile, {});
      const args = buildBwrapArgs(profile, asDir, host);
      const rwBinds = args.flatMap((a, i) => (a === "--bind" ? [args[i + 1]] : []));
      expect(rwBinds).toEqual([root]);
      expect(host.git.anchors).toEqual([]);
      expect(host.git.links).toEqual([nodePath.join(root, ".git")]);
      expect(args.join("\0")).not.toContain(outside);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a `.git` symlink to a git dir INSIDE the root anchors the real dir, never the link", () => {
    const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "keryx-gitlinkin-")));
    try {
      const real = nodePath.join(root, "meta", "repo.git");
      mkdirSync(nodePath.join(real, "hooks"), { recursive: true });
      writeFileSync(nodePath.join(real, "config"), "[core]\n");
      symlinkSync("meta/repo.git", nodePath.join(root, ".git"));
      const profile = { ...workspaceWrite, writableRoots: [root] };
      const args = buildBwrapArgs(profile, asDir, hostBwrapOptions(profile, {}));
      const rwBinds = args.flatMap((a, i) => (a === "--bind" ? [args[i + 1]] : []));
      expect(rwBinds).toEqual([root, nodePath.join(root, "meta"), real]);
      expect(hasPair(args, "--ro-bind", nodePath.join(real, "config"), nodePath.join(real, "config"))).toBe(true);
      expect(hasPair(args, "--ro-bind", nodePath.join(real, "hooks"), nodePath.join(real, "hooks"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // review-security-code-w3:F-001: the existing submodule layout — `.git/modules/**`
  // (nested ones too) and every `<sub>/.git` gitlink file — is covered by mounts.
  // Paths that do not exist at launch cannot be (no mount point); see os-sandbox.md.
  test("a superproject's existing submodule gitdirs (nested too) and gitlink files are read-only", () => {
    const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "keryx-gitsub-")));
    try {
      const dotGit = nodePath.join(root, ".git");
      const lib = nodePath.join(dotGit, "modules", "lib");
      const deep = nodePath.join(lib, "modules", "deep");
      for (const [gd, wt] of [
        [dotGit, undefined],
        [lib, "../../../lib"],
        [deep, "../../../../../lib/deep"],
      ] as const) {
        mkdirSync(nodePath.join(gd, "hooks"), { recursive: true });
        writeFileSync(nodePath.join(gd, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(nodePath.join(gd, "config"), wt === undefined ? "[core]\n" : `[core]\n\tworktree = ${wt}\n`);
      }
      mkdirSync(nodePath.join(root, "lib", "deep"), { recursive: true });
      writeFileSync(nodePath.join(root, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
      writeFileSync(nodePath.join(root, "lib", "deep", ".git"), "gitdir: ../../.git/modules/lib/modules/deep\n");
      const profile = { ...workspaceWrite, writableRoots: [root] };
      const host = hostBwrapOptions(profile, {});
      const args = buildBwrapArgs(profile, asDir, host);
      for (const p of [
        nodePath.join(lib, "config"),
        nodePath.join(lib, "hooks"),
        nodePath.join(deep, "config"),
        nodePath.join(deep, "hooks"),
        nodePath.join(root, "lib", ".git"),
        nodePath.join(root, "lib", "deep", ".git"),
      ]) {
        expect(hasPair(args, "--ro-bind", p, p)).toBe(true);
      }
      for (const a of [lib, deep, nodePath.join(root, "lib"), nodePath.join(root, "lib", "deep")]) {
        expect(hasPair(args, "--bind", a, a)).toBe(true);
      }
      // The sealed dirs are a Seatbelt-only rule: nothing in the argv names them.
      expect(host.git.sealed).toContain(nodePath.join(dotGit, "modules"));
      expect(host.git.sealed).toContain(nodePath.join(dotGit, "worktrees"));
      expect(gitProtectBwrapArgs({ controls: [], anchors: [], sealed: [nodePath.join(dotGit, "modules")], links: ["/x/.git"] })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// review-logic-w2:F-003 — NixOS keeps the system PATH under /run.
describe("pathEntriesUnderHidden: PATH entries the /run hide would remove are bound back", () => {
  const nixProbe: PathBindProbe = {
    realDir: (p) =>
      ({
        "/run/current-system/sw/bin": "/nix/store/abc-system-path/bin",
        "/run/wrappers/bin": "/run/wrappers/wrappers.x1",
        "/run/user/1000/fnm/bin": "/home/u/.fnm/v20/bin",
        "/run/user/1000": "/run/user/1000",
        "/run/via-link": "/run/user/1000",
        "/run/dbus": "/run/dbus",
        "/usr/bin": "/usr/bin",
      })[p],
    hasSocket: (dir) => dir === "/run/dbus",
  };
  const nixPath = [
    "/run/wrappers/bin",
    "/home/u/.nix-profile/bin",
    "/run/current-system/sw/bin",
    "/usr/bin",
    "/run/user/1000/fnm/bin",
    "/run/user/1000",
    "/run/via-link",
    "/run/dbus",
    "/run",
    "relative/bin",
    "/run/missing/bin",
    "/run/wrappers/bin",
  ].join(":");

  test("the NixOS system PATH and setuid wrappers come back; nothing outside a hidden dir is listed", () => {
    expect(pathEntriesUnderHidden(nixPath, ["/run"], ["/run/user/1000"], nixProbe)).toEqual([
      "/run/wrappers/bin",
      "/run/current-system/sw/bin",
      "/run/user/1000/fnm/bin",
    ]);
  });

  test("never a socket home: not /run itself, not the runtime dir (by name or via a link), not a dir holding a socket", () => {
    const out = pathEntriesUnderHidden(nixPath, ["/run"], ["/run/user/1000"], nixProbe);
    for (const p of ["/run", "/run/user/1000", "/run/via-link", "/run/dbus"]) expect(out).not.toContain(p);
  });

  test("buildBwrapArgs binds them read-only after the tmpfs hide and before the writable roots", () => {
    const args = buildBwrapArgs(workspaceWrite, asDir, {
      git: NO_GIT_PROTECTION,
      ipcDirs: ["/run"],
      pathBinds: ["/run/current-system/sw/bin"],
    });
    const hide = args.findIndex((a, i) => a === "--tmpfs" && args[i + 1] === "/run");
    const bind = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/run/current-system/sw/bin");
    expect(args[bind + 2]).toBe("/run/current-system/sw/bin");
    expect(bind).toBeGreaterThan(hide);
    expect(bind).toBeLessThan(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/work/repo"));
  });

  test("hostBwrapOptions feeds PATH through it (real host: nothing under a hidden dir on this machine is invented)", () => {
    const opts = hostBwrapOptions(workspaceWrite, { PATH: "/usr/bin:/bin" });
    expect(opts.pathBinds).toEqual([]);
  });
});

describe("inspectMaskTarget", () => {
  test("classifies dir / file / missing against the real filesystem", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "keryx-mask-"));
    const file = nodePath.join(dir, "secret");
    writeFileSync(file, "x");
    try {
      expect(inspectMaskTarget(dir)).toBe("dir");
      expect(inspectMaskTarget(file)).toBe("file");
      expect(inspectMaskTarget(nodePath.join(dir, "nope"))).toBe("missing");
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wrapBwrap", () => {
  test("wraps under bwrap <args> -- <cmd> [args]", () => {
    const wrapped = wrapBwrap(command, workspaceWrite);
    expect(wrapped.path).toBe(BWRAP_PROGRAM);
    expect(wrapped.argv[0]).toBe("bwrap");
    const sep = wrapped.argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(wrapped.argv[sep + 1]).toBe("/bin/echo");
    expect(wrapped.argv[sep + 2]).toBe("hi");
    expect(wrapped.cwd).toBe("/work/repo");
    expect(wrapped.env).toEqual({ PATH: "/usr/bin" });
  });

  test("absolute launcher path override", () => {
    const wrapped = wrapBwrap(command, workspaceWrite, "/usr/bin/bwrap");
    expect(wrapped.path).toBe("/usr/bin/bwrap");
    expect(wrapped.argv[0]).toBe("bwrap");
  });
});
