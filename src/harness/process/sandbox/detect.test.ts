import { describe, expect, test } from "bun:test";
import { detectSandboxLauncher, resolveSandboxAdapter } from "./detect";
import type { SandboxProfile } from "./profile";
import type { ContainedCommand, ProcessAdapter, ProcessObservation } from "../executor";

const profile: SandboxProfile = {
  mode: "workspace-write",
  network: "off",
  writableRoots: ["/work"],
  readDenyList: [],
  allowedDomains: [],
  required: false,
};

const noopInner: ProcessAdapter = {
  spawn(_c: ContainedCommand): ProcessObservation {
    return { kind: "clean-exit", exitCode: 0, terminationMode: "none", observedHash: "h" };
  },
};

describe("detectSandboxLauncher", () => {
  test("darwin: available when sandbox-exec exists", () => {
    const info = detectSandboxLauncher({ platform: "darwin", existsSync: (p) => p === "/usr/bin/sandbox-exec" });
    expect(info.available).toBe(true);
    expect(info.path).toBe("/usr/bin/sandbox-exec");
  });

  test("darwin: unavailable when missing", () => {
    const info = detectSandboxLauncher({ platform: "darwin", existsSync: () => false });
    expect(info.available).toBe(false);
    expect(info.reason).toContain("sandbox-exec");
  });

  test("linux: resolves bwrap on PATH", () => {
    const info = detectSandboxLauncher({
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      existsSync: (p) => p === "/usr/bin/bwrap",
    });
    expect(info.available).toBe(true);
    expect(info.path).toBe("/usr/bin/bwrap");
  });

  test("linux: unavailable when bwrap not on PATH", () => {
    const info = detectSandboxLauncher({ platform: "linux", env: { PATH: "/usr/bin" }, existsSync: () => false });
    expect(info.available).toBe(false);
    expect(info.reason).toContain("bubblewrap");
  });

  test("unsupported platform", () => {
    const info = detectSandboxLauncher({ platform: "win32" });
    expect(info.available).toBe(false);
    expect(info.reason).toContain("win32");
  });
});

describe("resolveSandboxAdapter", () => {
  test("builds an adapter and returns launcher info", () => {
    const { adapter, info } = resolveSandboxAdapter(profile, noopInner, {
      platform: "darwin",
      existsSync: () => true,
    });
    expect(info.available).toBe(true);
    // Adapter wraps then delegates without throwing.
    const obs = adapter.spawn({ path: "/bin/echo", argv: ["echo"], env: {}, cwd: "/work" });
    expect(obs.kind).toBe("clean-exit");
  });

  test("required profile + missing launcher ⇒ adapter fails closed", () => {
    const { adapter } = resolveSandboxAdapter(
      { ...profile, required: true },
      noopInner,
      { platform: "linux", env: { PATH: "/usr/bin" }, existsSync: () => false },
    );
    const obs = adapter.spawn({ path: "/bin/echo", argv: ["echo"], env: {}, cwd: "/work" });
    expect(obs.kind).toBe("spawn-error");
  });
});
