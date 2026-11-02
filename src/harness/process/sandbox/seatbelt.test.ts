import { describe, expect, test } from "bun:test";
import { SANDBOX_EXEC_PATH, buildSeatbeltProfile, wrapSeatbelt } from "./seatbelt";
import type { SandboxProfile } from "./profile";
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

describe("buildSeatbeltProfile: host IPC and git control files (review-security-code-w5 F-001/F-002)", () => {
  test("LaunchServices mach services are denied, and open/osascript cannot be exec'd", () => {
    const sb = buildSeatbeltProfile(workspaceWrite, []);
    expect(sb).toContain('(deny mach-lookup (global-name-prefix "com.apple.coreservices") (global-name-prefix "com.apple.lsd"))');
    expect(sb).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))');
  });

  test("the IPC deny applies in read-only mode too", () => {
    const sb = buildSeatbeltProfile({ ...workspaceWrite, mode: "read-only", writableRoots: [] }, []);
    expect(sb).toContain("(deny mach-lookup");
  });

  test("git hooks/config are re-denied AFTER the root allow (last match wins), and the git dir by name", () => {
    const sb = buildSeatbeltProfile(workspaceWrite, ["/work/repo/.git/config", "/work/repo/.git/hooks"]);
    const allow = sb.indexOf('(allow file-write* (subpath "/work/repo"))');
    for (const g of ["/work/repo/.git/config", "/work/repo/.git/hooks"]) {
      const deny = sb.indexOf(`(deny file-write* (subpath "${g}"))`);
      expect(deny).toBeGreaterThan(allow);
    }
    expect(sb).toContain('(deny file-write* (literal "/work/repo/.git"))');
  });

  test("no git control paths, no git deny lines", () => {
    expect(buildSeatbeltProfile(workspaceWrite, [])).not.toContain(".git");
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
