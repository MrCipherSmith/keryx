// review-architecture-w6:F-003 — every host read of planUnattendedSandbox goes
// through the injected filesystem, so the same input yields the same bwrap argv
// on any machine.

import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { planUnattendedSandbox, toolchainRoots, type UnattendedSandboxInput } from "./unattended";

/** A fake host: only the listed dirs exist (and bwrap). */
const fakeFs = (dirs: string[]) => ({
  existsSync: (p: string) => p === "/usr/bin/bwrap" || dirs.includes(p),
  isDir: (p: string) => dirs.includes(p),
  realpath: (p: string) => p,
});

function input(overrides: Partial<UnattendedSandboxInput>): UnattendedSandboxInput {
  return {
    worktree: "/fake/wt",
    scratchHome: "/fake/wt-home",
    network: false,
    readOnly: [],
    env: { PATH: "/usr/bin:/bin" },
    home: "/fake/home",
    platform: "linux",
    probe: () => true,
    ...overrides,
  };
}

function tmpfsTargets(args: readonly string[]): string[] {
  // "/tmp" is the standing scratch tmpfs, not a host-read decision.
  return args.flatMap((a, i) => (a === "--tmpfs" && args[i + 1] !== "/tmp" ? [args[i + 1] as string] : []));
}

describe("planUnattendedSandbox host-read seam", () => {
  test("real $HOME and a real XDG_RUNTIME_DIR are not consulted when the fake host lacks them", () => {
    const plan = planUnattendedSandbox(
      input({
        home: homedir(),
        env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: tmpdir() },
        detect: fakeFs([]),
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(tmpfsTargets(plan.args)).toEqual([]);
  });

  test("home, runtime dir, config dir, hide dirs and read-only roots follow the injected fs", () => {
    const plan = planUnattendedSandbox(
      input({
        env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: "/fake/xdg" },
        configDir: "/fake/cfg",
        hide: ["/fake/scratch-parent"],
        readOnly: ["/fake/ro"],
        detect: fakeFs(["/fake/home", "/fake/xdg", "/fake/cfg", "/fake/scratch-parent", "/fake/ro"]),
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(tmpfsTargets(plan.args)).toEqual(
      expect.arrayContaining(["/fake/home", "/fake/xdg", "/fake/cfg", "/fake/scratch-parent"]),
    );
    expect(plan.args.join(" ")).toContain("--ro-bind /fake/ro /fake/ro");
  });

  test("a read-only root the fake host lacks is skipped even if the real machine has it", () => {
    const plan = planUnattendedSandbox(input({ readOnly: ["/tmp"], detect: fakeFs([]) }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // /tmp is always a scratch tmpfs. Only a host read-only bind would
    // violate the injected filesystem's refusal to expose this root.
    const mounts = (args: readonly string[]) => args.flatMap((arg, i) =>
      arg === "--ro-bind" ? [args.slice(i, i + 3)] : []);
    expect(mounts(plan.args)).not.toContainEqual(["--ro-bind", "/tmp", "/tmp"]);
    expect(plan.args.slice(plan.args.indexOf("--tmpfs"), plan.args.indexOf("--tmpfs") + 2)).toEqual(["--tmpfs", "/tmp"]);
    const present = planUnattendedSandbox(input({ readOnly: ["/tmp"], detect: fakeFs(["/tmp"]) }));
    expect(present.ok).toBe(true);
    if (present.ok) expect(mounts(present.args)).toContainEqual(["--ro-bind", "/tmp", "/tmp"]);
  });

  test("the config dir derives from the input env and home, not from process state", () => {
    const plan = planUnattendedSandbox(
      input({
        env: { PATH: "/usr/bin:/bin", XDG_DATA_HOME: "/fake/data" },
        detect: fakeFs(["/fake/data/keryx"]),
      }),
    );
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(tmpfsTargets(plan.args)).toContain("/fake/data/keryx");

    const fallback = planUnattendedSandbox(input({ detect: fakeFs(["/fake/home/.local/share/keryx"]) }));
    expect(fallback.ok).toBe(true);
    if (fallback.ok) expect(tmpfsTargets(fallback.args)).toContain("/fake/home/.local/share/keryx");
  });

  test("toolchainRoots takes the existence check from the caller", () => {
    expect(toolchainRoots("/fake/home/.bun/bin", "/fake/home", () => false)).toEqual([]);
    expect(toolchainRoots("/fake/home/.bun/bin", "/fake/home", () => true)).toEqual(["/fake/home/.bun"]);
  });
});
