// A `restricted` network posture fails closed regardless of the escape hatch
// (flow 134, S1 / AC1 / AC2).
//
// `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` reaches `failIfUnavailable: false`, and
// before this the restricted case fell through it: `defaultSandboxProfile` never
// sets `required`, and `setupNetworkRun` spreads an incoming profile to attach
// the proxy without setting it either. On Linux the wrap refuses `restricted`,
// so the command was spawned uncontained — while the allowlist proxy was already
// listening and `HTTP(S)_PROXY` was already in the command env. The caller asked
// to restrict egress to a domain list and got no restriction at all, shaped like
// one.
//
// Both halves are asserted here on purpose. AC1 alone could be satisfied by
// refusing everything, which would break every host without a launcher; AC2 pins
// the escape hatch open for the case it was written for.

import { describe, expect, test } from "bun:test";
import { SandboxedProcessAdapter } from "./adapter";
import type { SandboxProfile } from "./profile";
import type { ContainedCommand, ProcessAdapter, ProcessObservation } from "../executor";

const command: ContainedCommand = {
  path: "/bin/echo",
  argv: ["/bin/echo", "hi"],
  env: {},
  cwd: "/work/repo",
};

/** Records whether the real spawn was ever reached. */
function spy(): ProcessAdapter & { spawned: () => number } {
  let count = 0;
  return {
    spawn(): ProcessObservation {
      count += 1;
      return { kind: "clean-exit", exitCode: 0, observedHash: "h" };
    },
    spawned: () => count,
  };
}

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    mode: "workspace-write",
    network: "off",
    writableRoots: ["/work/repo"],
    readDenyList: [],
    allowedDomains: [],
    required: false,
    ...overrides,
  };
}

const RESTRICTED = profile({
  network: "restricted",
  allowedDomains: ["registry.npmjs.org"],
});

describe("restricted network posture ignores the unsandboxed escape hatch", () => {
  test("AC1: Linux + restricted refuses even with failIfUnavailable false", () => {
    const inner = spy();
    const observation = new SandboxedProcessAdapter({
      profile: RESTRICTED,
      inner,
      platform: "linux",
      launcherAvailable: true,
      bwrapPath: "/usr/bin/bwrap",
      // What KERYX_SANDBOX_ALLOW_UNSANDBOXED=1 resolves to.
      failIfUnavailable: false,
    }).spawn(command);

    expect(observation.kind).toBe("spawn-error");
    // The point of the test: the process must never have started.
    expect(inner.spawned()).toBe(0);
  });

  test("AC1: restricted with no launcher refuses too, hatch or no hatch", () => {
    const inner = spy();
    const observation = new SandboxedProcessAdapter({
      profile: RESTRICTED,
      inner,
      platform: "linux",
      launcherAvailable: false,
      failIfUnavailable: false,
    }).spawn(command);

    expect(observation.kind).toBe("spawn-error");
    expect(inner.spawned()).toBe(0);
  });

  test("AC2: the hatch still works for a non-restricted profile with no launcher", () => {
    const inner = spy();
    const observation = new SandboxedProcessAdapter({
      profile: profile({ network: "off" }),
      inner,
      platform: "linux",
      launcherAvailable: false,
      failIfUnavailable: false,
    }).spawn(command);

    // Weaker containment, knowingly accepted — this is what the variable is for.
    expect(observation.kind).toBe("clean-exit");
    expect(inner.spawned()).toBe(1);
  });

  test("AC2: without the hatch, a missing launcher still fails closed", () => {
    const inner = spy();
    const observation = new SandboxedProcessAdapter({
      profile: profile({ network: "off" }),
      inner,
      platform: "linux",
      launcherAvailable: false,
    }).spawn(command);

    expect(observation.kind).toBe("spawn-error");
    expect(inner.spawned()).toBe(0);
  });

  test("danger-full-access is still the one explicit way out", () => {
    const inner = spy();
    const observation = new SandboxedProcessAdapter({
      profile: profile({ mode: "danger-full-access", network: "restricted" }),
      inner,
      platform: "linux",
      launcherAvailable: false,
      failIfUnavailable: false,
    }).spawn(command);

    expect(observation.kind).toBe("clean-exit");
    expect(inner.spawned()).toBe(1);
  });
});
