import { describe, expect, test } from "bun:test";
import { wrapWithSandbox } from "./wrap";
import { SandboxedProcessAdapter } from "./adapter";
import type { SandboxProfile } from "./profile";
import type { ContainedCommand, ProcessAdapter, ProcessObservation } from "../executor";

const profile: SandboxProfile = {
  mode: "workspace-write",
  network: "off",
  writableRoots: ["/work/repo"],
  readDenyList: [],
  allowedDomains: [],
  required: false,
};

const command: ContainedCommand = {
  path: "/bin/echo",
  argv: ["echo", "hi"],
  env: {},
  cwd: "/work/repo",
};

/** Fake inner adapter that records the command it was asked to spawn. */
class RecordingAdapter implements ProcessAdapter {
  received?: ContainedCommand;
  spawn(cmd: ContainedCommand): ProcessObservation {
    this.received = cmd;
    return { kind: "clean-exit", exitCode: 0, outputBytes: 2, terminationMode: "none", observedHash: "h" };
  }
}

describe("wrapWithSandbox", () => {
  test("darwin ⇒ seatbelt", () => {
    const r = wrapWithSandbox(command, profile, { platform: "darwin" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wrapped).toBe(true);
      expect(r.command.path).toBe("/usr/bin/sandbox-exec");
    }
  });

  test("linux ⇒ bwrap", () => {
    const r = wrapWithSandbox(command, profile, { platform: "linux" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command.argv[0]).toBe("bwrap");
  });

  test("danger-full-access ⇒ pass-through, not wrapped", () => {
    const r = wrapWithSandbox(command, { ...profile, mode: "danger-full-access" }, { platform: "darwin" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.wrapped).toBe(false);
      expect(r.command).toEqual(command);
    }
  });

  test("unsupported platform ⇒ fail closed", () => {
    const r = wrapWithSandbox(command, profile, { platform: "win32" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("win32");
  });

  test("linux + network restricted ⇒ fail closed (not yet enforceable)", () => {
    const r = wrapWithSandbox(command, { ...profile, network: "restricted", allowedDomains: ["x.com"] }, { platform: "linux" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("restricted");
  });

  test("darwin + network restricted ⇒ seatbelt-wrapped", () => {
    const r = wrapWithSandbox(
      command,
      { ...profile, network: "restricted", allowedDomains: ["x.com"], proxy: { host: "127.0.0.1", port: 5000 } },
      { platform: "darwin" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command.path).toBe("/usr/bin/sandbox-exec");
  });
});

describe("SandboxedProcessAdapter", () => {
  test("wraps then delegates to inner (darwin)", () => {
    const inner = new RecordingAdapter();
    const a = new SandboxedProcessAdapter({ profile, inner, platform: "darwin", launcherAvailable: true });
    a.spawn(command);
    expect(inner.received?.path).toBe("/usr/bin/sandbox-exec");
  });

  test("launcher unavailable + failClosed ⇒ spawn-error, inner never called", () => {
    const inner = new RecordingAdapter();
    const a = new SandboxedProcessAdapter({
      profile: { ...profile, required: true },
      inner,
      platform: "linux",
      launcherAvailable: false,
    });
    const obs = a.spawn(command);
    expect(obs.kind).toBe("spawn-error");
    expect(inner.received).toBeUndefined();
  });

  test("launcher unavailable + relaxed (not required) ⇒ delegates unsandboxed", () => {
    const inner = new RecordingAdapter();
    const a = new SandboxedProcessAdapter({
      profile,
      inner,
      platform: "linux",
      launcherAvailable: false,
      failIfUnavailable: false,
    });
    a.spawn(command);
    expect(inner.received).toEqual(command); // unwrapped
  });

  test("danger-full-access ⇒ delegates unwrapped even with launcher present", () => {
    const inner = new RecordingAdapter();
    const a = new SandboxedProcessAdapter({
      profile: { ...profile, mode: "danger-full-access" },
      inner,
      platform: "darwin",
      launcherAvailable: true,
    });
    a.spawn(command);
    expect(inner.received).toEqual(command);
  });

  test("unsupported platform + failClosed ⇒ spawn-error", () => {
    const inner = new RecordingAdapter();
    const a = new SandboxedProcessAdapter({ profile, inner, platform: "win32", launcherAvailable: true });
    const obs = a.spawn(command);
    expect(obs.kind).toBe("spawn-error");
    expect(inner.received).toBeUndefined();
  });

  test("AC-H2: launcher unavailable surfaces non-empty errorMessage with program path", () => {
    const inner = new RecordingAdapter();
    const a = new SandboxedProcessAdapter({
      profile: { ...profile, required: true },
      inner,
      platform: "linux",
      launcherAvailable: false,
    });
    const obs = a.spawn(command);
    expect(obs.kind).toBe("spawn-error");
    expect(typeof obs.errorMessage).toBe("string");
    expect((obs.errorMessage ?? "").length).toBeGreaterThan(0);
    expect(obs.errorMessage).toContain(command.path);
  });

  test("AC-H2: clean-exit 71 after wrap ⇒ spawn-error with structured detail", () => {
    class Exit71Adapter implements ProcessAdapter {
      spawn(): ProcessObservation {
        return {
          kind: "clean-exit",
          exitCode: 71,
          outputBytes: 0,
          observedHash: "f".repeat(64),
        };
      }
    }
    const a = new SandboxedProcessAdapter({
      profile,
      inner: new Exit71Adapter(),
      platform: "darwin",
      launcherAvailable: true,
    });
    const obs = a.spawn(command);
    expect(obs.kind).toBe("spawn-error");
    expect(obs.errorMessage).toMatch(/exit 71|EX_OSERR/i);
    expect(obs.errorMessage).toContain(command.path);
  });

  test("AC-H2: inner spawn-error is re-annotated with program path", () => {
    class InnerSpawnError implements ProcessAdapter {
      spawn(): ProcessObservation {
        return {
          kind: "spawn-error",
          observedHash: "1".repeat(64),
          errorMessage: "ENOENT",
        };
      }
    }
    const a = new SandboxedProcessAdapter({
      profile,
      inner: new InnerSpawnError(),
      platform: "darwin",
      launcherAvailable: true,
    });
    const obs = a.spawn(command);
    expect(obs.kind).toBe("spawn-error");
    expect(obs.errorMessage).toMatch(/sandbox spawn failed/);
    expect(obs.errorMessage).toContain(command.path);
    expect(obs.errorMessage).toContain("ENOENT");
  });
});
