import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SANDBOX_EXEC_PATH, buildSeatbeltProfile, wrapSeatbelt } from "./seatbelt";
import { defaultSandboxProfile, type SandboxProfile } from "./profile";
import type { ContainedCommand } from "../executor";

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

// Flow 481 T8: the herdr-core socket is never part of a sandbox profile. `hc`
// cannot reach the core from a sandboxed shell, and that is deliberate.
describe("herdr-core socket stays out of the profile", () => {
  const HC_ENV = {
    HC_SOCKET: "/Users/u/.local/state/herdr-core/core.sock",
    HC_TERMINAL_SOCKET: "/Users/u/.local/state/herdr-core/t13.sock",
    HC_TERMINAL_ID: "t13",
  } as const;

  test("the generated profile names neither socket, whatever the process env holds", () => {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(HC_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      for (const p of [workspaceWrite, defaultSandboxProfile("/work/repo", "/tmp/session", "/home/u")]) {
        const sb = buildSeatbeltProfile(p);
        expect(sb).not.toContain(HC_ENV.HC_SOCKET);
        expect(sb).not.toContain(HC_ENV.HC_TERMINAL_SOCKET);
        expect(sb).not.toContain("herdr-core");
        expect(sb).not.toContain("core.sock");
        expect(sb).not.toMatch(/\(allow network[^)]*\(?(remote unix|unix-socket|path-literal)/);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("no sandbox source file references the herdr-core socket variables", () => {
    const dir = import.meta.dir;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(text).not.toMatch(/HC_SOCKET|HC_TERMINAL_SOCKET/);
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
