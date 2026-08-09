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

// ---------------------------------------------------------------------------
// AC3 — layer selection, per profile rather than per host
// ---------------------------------------------------------------------------

describe("Linux layer selection", () => {
  /** Everything the Landlock branch needs, none of it read from this host. */
  const landlockOpts = {
    platform: "linux",
    landlockAbi: 4,
    bunPath: "/usr/local/bin/bun",
    landlockExecPath: "/opt/keryx/landlock-exec.js",
    home: "/home/u",
  } as const;

  /** An expressible profile: workspace-write, network on. */
  const expressible: SandboxProfile = { ...profile, network: "on" };

  test("an expressible profile is wrapped by Landlock, in the §4.2 shape", () => {
    const r = wrapWithSandbox(command, expressible, landlockOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layer).toBe("landlock");
    expect(r.command.path).toBe("/usr/local/bin/bun");
    expect(r.command.argv.slice(0, 3)).toEqual([
      "/usr/local/bin/bun",
      "/opt/keryx/landlock-exec.js",
      "--ruleset",
    ]);
    expect(r.command.argv[4]).toBe("--");
    // The real command follows, argv[0] dropped exactly as wrapBwrap drops it.
    expect(r.command.argv.slice(5)).toEqual(["/bin/echo", "hi"]);
    expect(r.command.cwd).toBe(command.cwd);
    expect(r.command.env).toBe(command.env);
  });

  test("the ruleset it passes is the translation of that profile", () => {
    const r = wrapWithSandbox(command, expressible, landlockOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ruleset = JSON.parse(r.command.argv[3] as string);
    const paths = ruleset.pathRules.map((rule: { path: string }) => rule.path);
    expect(paths).toContain("/work/repo");
    expect(paths).toContain("/usr");
    // The mechanism, asserted where it is used and not only where it is built.
    expect(paths).not.toContain("/home/u");
  });

  test('network "off" selects bubblewrap, because Landlock is TCP-only', () => {
    // Selection is per PROFILE: this is the same host as the test above.
    const r = wrapWithSandbox(command, { ...profile, network: "off" }, landlockOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layer).toBe("bwrap");
    expect(r.command.argv[0]).toBe("bwrap");
  });

  test("a kernel below the write boundary's ABI falls back rather than under-restricting", () => {
    const r = wrapWithSandbox(command, expressible, { ...landlockOpts, landlockAbi: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layer).toBe("bwrap");
  });

  test("a kernel with no Landlock falls back", () => {
    const r = wrapWithSandbox(command, expressible, { ...landlockOpts, landlockAbi: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layer).toBe("bwrap");
  });

  test("an unmeasured ABI is not a guess in either direction — it falls back", () => {
    const { landlockAbi: _abi, ...withoutAbi } = landlockOpts;
    const r = wrapWithSandbox(command, expressible, withoutAbi);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layer).toBe("bwrap");
  });

  test("not knowing where the applier is falls back, and says nothing about the profile", () => {
    const { landlockExecPath: _path, ...withoutApplier } = landlockOpts;
    const r = wrapWithSandbox(command, expressible, withoutApplier);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layer).toBe("bwrap");
  });

  test("a profile neither layer can express fails closed, with the reason", () => {
    // A malformed writable root is the profile's own shape, not the kernel's:
    // handing it to bubblewrap would hand a second launcher the same bad input.
    const r = wrapWithSandbox(command, { ...expressible, writableRoots: ["relative"] }, landlockOpts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("relative");
  });

  test("network=restricted still fails closed on both layers", () => {
    const r = wrapWithSandbox(command, { ...expressible, network: "restricted" }, landlockOpts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("network=restricted");
  });

  test("danger-full-access is still the only pass-through (AC8)", () => {
    const r = wrapWithSandbox(command, { ...expressible, mode: "danger-full-access" }, landlockOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wrapped).toBe(false);
    expect(r.command).toBe(command);
    expect(r.layer).toBeUndefined();
  });

  test("darwin is untouched by any of this (AC9)", () => {
    const r = wrapWithSandbox(command, expressible, { ...landlockOpts, platform: "darwin" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layer).toBe("seatbelt");
    expect(r.command.path).toBe("/usr/bin/sandbox-exec");
  });
});
