import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SANDBOX_EXEC_PATH, buildSeatbeltProfile, wrapSeatbelt } from "./seatbelt";
import { defaultSandboxProfile, type SandboxProfile } from "./profile";
import type { ContainedCommand } from "../executor";
import { shellSandboxProfile } from "../shell-spawn";

const workspaceWrite: SandboxProfile = {
  mode: "workspace-write",
  network: "off",
  writableRoots: ["/work/repo", "/tmp/session"],
  readDenyList: ["/home/u/.ssh", "/home/u/.aws"],
  allowedDomains: [],
  required: true,
};

const command: ContainedCommand = {
  path: "/bin/echo",
  argv: ["echo", "hi"],
  env: { PATH: "/usr/bin" },
  cwd: "/work/repo",
};

describe("buildSeatbeltProfile", () => {
  test("allow-default with write-deny then root re-allow", () => {
    const sb = buildSeatbeltProfile(workspaceWrite);
    expect(sb).toContain("(allow default)");
    expect(sb).toContain('(deny file-write* (subpath "/"))');
    expect(sb).toContain('(allow file-write* (subpath "/work/repo"))');
    expect(sb).toContain('(allow file-write* (subpath "/tmp/session"))');
  });

  test("network off emits deny network*", () => {
    expect(buildSeatbeltProfile(workspaceWrite)).toContain("(deny network*)");
  });

  test("network on omits the network deny", () => {
    const sb = buildSeatbeltProfile({ ...workspaceWrite, network: "on" });
    expect(sb).not.toContain("(deny network*)");
  });

  test("network restricted: deny-all then allow only the loopback proxy socket", () => {
    const sb = buildSeatbeltProfile({
      ...workspaceWrite,
      network: "restricted",
      allowedDomains: ["api.github.com"],
      proxy: { host: "127.0.0.1", port: 51234 },
    });
    expect(sb).toContain("(deny network*)");
    expect(sb).toContain('(allow network-outbound (remote ip "localhost:51234"))');
  });

  test("network restricted without a live proxy denies all network (fail-safe)", () => {
    const sb = buildSeatbeltProfile({ ...workspaceWrite, network: "restricted", allowedDomains: ["x.com"] });
    expect(sb).toContain("(deny network*)");
    expect(sb).not.toContain("network-outbound");
  });

  test("secret reads are denied", () => {
    const sb = buildSeatbeltProfile(workspaceWrite);
    expect(sb).toContain('(deny file-read* (subpath "/home/u/.ssh"))');
    expect(sb).toContain('(deny file-read* (subpath "/home/u/.aws"))');
  });

  test("read-only mode: no writable-root allow lines", () => {
    const sb = buildSeatbeltProfile({ ...workspaceWrite, mode: "read-only", writableRoots: [] });
    expect(sb).toContain('(deny file-write* (subpath "/"))');
    expect(sb).not.toContain("(allow file-write* (subpath");
  });

  test("deterministic", () => {
    expect(buildSeatbeltProfile(workspaceWrite)).toBe(buildSeatbeltProfile(workspaceWrite));
  });

  test("string escaping of a path with a quote", () => {
    const sb = buildSeatbeltProfile({ ...workspaceWrite, writableRoots: ['/w/a"b'] });
    expect(sb).toContain('\\"');
  });
});

// Flow 481: Keryx adds nothing to the sandbox for herdr-core. These pin that, and
// the mode matrix docs/docs/guides/herdr.md ("The sandbox caveat") states: a network-off
// or restricted (allowed domains configured) profile denies the unix socket; a network-on
// profile (the interactive shell's `workspace` mode, no allowed domains) leaves it
// reachable, so the sandbox does not contain `hc`.
describe("herdr-core and the sandbox profile", () => {
  const profiles = {
    off: workspaceWrite,
    default: defaultSandboxProfile("/work/repo", "/tmp/session", "/home/u"),
    on: { ...workspaceWrite, network: "on" as const },
  };

  test("no profile names a herdr-core path or allows a unix socket", () => {
    for (const p of Object.values(profiles)) {
      const sb = buildSeatbeltProfile(p);
      expect(sb).not.toContain("herdr-core");
      expect(sb).not.toContain("core.sock");
      expect(sb).not.toMatch(/\(allow network[^)]*\(?(remote unix|unix-socket|path-literal)/);
    }
  });

  test("network off denies all network, the socket included; network on has no network rule at all", () => {
    expect(buildSeatbeltProfile(profiles.off)).toContain("(deny network*)");
    expect(buildSeatbeltProfile(profiles.default)).toContain("(deny network*)");
    // `workspace` mode: under (allow default) nothing stops a connect to the herdr-core socket.
    const on = buildSeatbeltProfile(profiles.on);
    expect(on).toContain("(allow default)");
    expect(on).not.toMatch(/\(deny network/);
  });

  // With allowed domains configured, the shell's own profile builder returns `network: "restricted"`
  // in EVERY mode (`workspace` included): the profile denies all network but the loopback proxy, so
  // the herdr-core socket is unreachable. Built from an explicit env object: the process environment is never touched, no proxy starts.
  test("allowed domains: every mode becomes restricted and denies the socket too", () => {
    const env = { KERYX_SANDBOX_ALLOWED_DOMAINS: "api.github.com" };
    for (const mode of ["workspace", "strict"] as const) {
      const profile = shellSandboxProfile("/work/repo", mode, env);
      expect(profile.network).toBe("restricted");
      const withProxy = { ...profile, proxy: { host: "127.0.0.1", port: 51234 } };
      for (const sb of [buildSeatbeltProfile(profile), buildSeatbeltProfile(withProxy)]) {
        expect(sb).toContain("(allow default)");
        expect(sb).toContain("(deny network*)");
        // The only network allowance is the loopback proxy; nothing opens a unix socket.
        expect(sb).not.toMatch(/\(allow network[^)]*\(?(remote unix|unix-socket|path-literal)/);
        expect(sb).not.toContain("core.sock");
        for (const line of sb.split("\n").filter((l) => l.includes("(allow network"))) {
          expect(line).toMatch(/remote ip "localhost:\d+"/);
        }
      }
    }
    // Without allowed domains `workspace` is network-on: the reachable case above.
    expect(shellSandboxProfile("/work/repo", "workspace", {}).network).toBe("on");
    expect(shellSandboxProfile("/work/repo", "strict", {}).network).toBe("off");
  });

  test("no sandbox source file references any herdr-core variable (HC_*)", () => {
    const dir = import.meta.dir;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), "utf8");
      // Any HC_* name, not only today's socket variables: a new hc variable is caught too.
      expect(text).not.toMatch(/\bHC_[A-Z0-9_]+/);
    }
  });
});

describe("wrapSeatbelt", () => {
  test("wraps under sandbox-exec -p <profile> <cmd> [args]", () => {
    const wrapped = wrapSeatbelt(command, workspaceWrite);
    expect(wrapped.path).toBe(SANDBOX_EXEC_PATH);
    expect(wrapped.argv[0]).toBe("sandbox-exec");
    expect(wrapped.argv[1]).toBe("-p");
    expect(wrapped.argv[2]).toContain("(allow default)"); // inline profile
    expect(wrapped.argv[3]).toBe("/bin/echo"); // original program
    expect(wrapped.argv[4]).toBe("hi"); // original arg tail
    expect(wrapped.cwd).toBe("/work/repo");
    expect(wrapped.env).toEqual({ PATH: "/usr/bin" });
  });
});
