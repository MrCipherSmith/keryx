import { describe, expect, test } from "bun:test";
import {
  defaultReadDenyList,
  defaultSandboxProfile,
  sandboxProfileFromPolicy,
  type SandboxProfileInput,
} from "./profile";
import type { PolicyProfile, PolicyProfileDefaults } from "../../policy/types";

function policy(
  defaults: Partial<PolicyProfileDefaults>,
  isolation: PolicyProfile["requiredControls"]["isolation"] = "not-required",
): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1",
    fingerprint: "fp",
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "allow", shell: "ask", network: "deny", delegate: "deny", ...defaults },
    requiredControls: { isolation, redactionFailure: "deny", networkBrokerFailure: "deny" },
  };
}

const base: Omit<SandboxProfileInput, "policy"> = {
  cwd: "/work/repo",
  tmpDir: "/tmp/session",
  home: "/home/u",
};

describe("sandboxProfileFromPolicy", () => {
  test("write=allow, network=deny ⇒ workspace-write + network off", () => {
    const p = sandboxProfileFromPolicy({ ...base, policy: policy({ write: "allow", network: "deny" }) });
    expect(p.mode).toBe("workspace-write");
    expect(p.network).toBe("off");
    expect(p.writableRoots).toEqual(["/work/repo", "/tmp/session"]);
  });

  test("write=deny ⇒ read-only with no writable roots", () => {
    const p = sandboxProfileFromPolicy({ ...base, policy: policy({ write: "deny" }) });
    expect(p.mode).toBe("read-only");
    expect(p.writableRoots).toEqual([]);
  });

  test("network=allow ⇒ network on", () => {
    const p = sandboxProfileFromPolicy({ ...base, policy: policy({ network: "allow" }) });
    expect(p.network).toBe("on");
    expect(p.allowedDomains).toEqual([]);
  });

  test("network=allow + allowedDomains ⇒ restricted with those domains", () => {
    const p = sandboxProfileFromPolicy({
      ...base,
      policy: policy({ network: "allow" }),
      allowedDomains: ["*.github.com", "registry.npmjs.org", "  "],
    });
    expect(p.network).toBe("restricted");
    expect(p.allowedDomains).toEqual(["*.github.com", "registry.npmjs.org"]);
  });

  test("network=deny ignores allowedDomains (stays off)", () => {
    const p = sandboxProfileFromPolicy({
      ...base,
      policy: policy({ network: "deny" }),
      allowedDomains: ["*.github.com"],
    });
    expect(p.network).toBe("off");
    expect(p.allowedDomains).toEqual([]);
  });

  test("isolation required-fail-closed ⇒ required true", () => {
    const p = sandboxProfileFromPolicy({
      ...base,
      policy: policy({}, "required-fail-closed"),
    });
    expect(p.required).toBe(true);
  });

  test("dangerFullAccess escape hatch bypasses containment", () => {
    const p = sandboxProfileFromPolicy({
      ...base,
      policy: policy({ write: "deny", network: "deny" }, "required-fail-closed"),
      dangerFullAccess: true,
    });
    expect(p.mode).toBe("danger-full-access");
    expect(p.network).toBe("on");
    expect(p.required).toBe(false);
    expect(p.writableRoots).toEqual([]);
  });

  test("read-deny list expands secret subpaths under home", () => {
    const p = sandboxProfileFromPolicy({ ...base, policy: policy({}) });
    expect(p.readDenyList).toContain("/home/u/.ssh");
    expect(p.readDenyList).toContain("/home/u/.aws");
  });

  test("mapping is deterministic", () => {
    const input = { ...base, policy: policy({ write: "allow" }) };
    expect(sandboxProfileFromPolicy(input)).toEqual(sandboxProfileFromPolicy(input));
  });
});

describe("defaults", () => {
  test("defaultSandboxProfile is workspace-write + network off", () => {
    const p = defaultSandboxProfile("/w", "/t", "/home/u");
    expect(p.mode).toBe("workspace-write");
    expect(p.network).toBe("off");
    expect(p.writableRoots).toEqual(["/w", "/t"]);
    expect(p.required).toBe(false);
  });

  test("defaultReadDenyList empty without home", () => {
    expect(defaultReadDenyList(undefined)).toEqual([]);
  });
});
