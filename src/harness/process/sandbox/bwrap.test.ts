import { describe, expect, test } from "bun:test";
import { BWRAP_PROGRAM, buildBwrapArgs, wrapBwrap } from "./bwrap";
import type { SandboxProfile } from "./profile";
import type { ContainedCommand } from "../executor";

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
    expect(hasPair(buildBwrapArgs(workspaceWrite), "--ro-bind", "/", "/")).toBe(true);
  });

  test("writable roots are re-bound RW", () => {
    const args = buildBwrapArgs(workspaceWrite);
    expect(hasPair(args, "--bind", "/work/repo", "/work/repo")).toBe(true);
    expect(hasPair(args, "--bind", "/tmp/session", "/tmp/session")).toBe(true);
  });

  test("secrets are masked with tmpfs", () => {
    expect(hasPair(buildBwrapArgs(workspaceWrite), "--tmpfs", "/home/u/.ssh")).toBe(true);
  });

  test("network off unshares net", () => {
    expect(buildBwrapArgs(workspaceWrite)).toContain("--unshare-net");
  });

  test("network on keeps host net (no --unshare-net)", () => {
    expect(buildBwrapArgs({ ...workspaceWrite, network: "on" })).not.toContain("--unshare-net");
  });

  test("read-only mode has no RW binds beyond tmpfs /tmp", () => {
    const args = buildBwrapArgs({ ...workspaceWrite, mode: "read-only", writableRoots: [] });
    expect(hasPair(args, "--bind", "/work/repo", "/work/repo")).toBe(false);
  });

  test("hardening flags present", () => {
    const args = buildBwrapArgs(workspaceWrite);
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    expect(args).toContain("--unshare-ipc");
  });

  test("deterministic", () => {
    expect(buildBwrapArgs(workspaceWrite)).toEqual(buildBwrapArgs(workspaceWrite));
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
