import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { saveSandboxDefaults } from "../../../lib/sandbox-config";
import {
  type CommandRunner,
  extraReadDenyRoots,
  makeCommandRunner,
  resolveShellRestrictedMasks,
  resolveShellSandboxMode,
  shellExecTool,
} from "./shell-exec-tool";

function recordingRunner(result = { output: "done", isError: false }): {
  run: CommandRunner;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: async (command) => {
      calls.push(command);
      return result;
    },
  };
}

test("F2: extraReadDenyRoots parses KERYX_SANDBOX_READ_DENY and expands ~/", () => {
  expect(extraReadDenyRoots({})).toEqual([]);
  const home = homedir();
  const roots = extraReadDenyRoots({ KERYX_SANDBOX_READ_DENY: "~/.secretcfg, /etc/keys ,, " });
  // `~/` expands to the home dir; empty entries are dropped.
  expect(roots).toContain(path.join(home, ".secretcfg"));
  expect(roots).toContain("/etc/keys");
  expect(roots.length).toBe(2);
});

test("shell_exec is risk shell with a command input schema", () => {
  const { run } = recordingRunner();
  const tool = shellExecTool("/proj", run);
  expect(tool.definition.name).toBe("shell_exec");
  expect(tool.definition.risk).toBe("shell");
  expect(tool.definition.inputSchema.required).toEqual(["command"]);
});

test("shell_exec passes the command through to the runner", async () => {
  const { run, calls } = recordingRunner();
  const tool = shellExecTool("/proj", run);
  const result = await tool.invoke({ command: "git status" });
  expect(calls).toEqual(["git status"]);
  expect(result.isError).toBe(false);
});

test("shell_exec errors on a missing command WITHOUT invoking the runner", async () => {
  const { run, calls } = recordingRunner();
  const tool = shellExecTool("/proj", run);
  const result = await tool.invoke({});
  expect(result.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("shell_exec propagates a runner failure", async () => {
  const { run } = recordingRunner({ output: "boom", isError: true });
  const tool = shellExecTool("/proj", run);
  const result = await tool.invoke({ command: "false" });
  expect(result.isError).toBe(true);
  expect(result.output).toBe("boom");
});

describe("C-06 through C-08: timeout cleanup dispositions", () => {
  test("C-06/C-07: an already-exited process makes both TERM and KILL cleanup fail-soft", () => {
    const source = readFileSync(new URL("./shell-exec-tool.ts", import.meta.url), "utf8");

    expect(source).toMatch(/proc\.kill\("SIGTERM"\);\s*}\s*catch\s*{\s*\/\/ already gone/s);
    expect(source).toMatch(/proc\.kill\("SIGKILL"\);\s*}\s*catch\s*{\s*\/\/ already gone/s);
    expect(source).toContain("shell_exec: timed out after ${timeoutMs}ms and was killed");
  });

  test("C-08: a torn-down output reader preserves already-collected bytes", () => {
    const source = readFileSync(new URL("./shell-exec-tool.ts", import.meta.url), "utf8");

    expect(source).toMatch(/sink\.text \+= decoder\.decode\(chunk\.value, \{ stream: true \}\)/);
    expect(source).toMatch(/catch\s*{\s*\/\/ stream torn down by the kill — keep what we have/s);
    expect(source).toMatch(/Promise\.race\(\[drained, new Promise\(\(r\) => setTimeout\(r, 200\)\)\]\)/);
  });
});

describe("resolveShellSandboxMode", () => {
  test("default off; workspace/strict opt-in; danger forces off", () => {
    // Isolate from the developer's real sandbox.json
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-sbx-empty-"));
    expect(resolveShellSandboxMode({}, emptyDir)).toBe("off");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "workspace" }, emptyDir)).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "1" }, emptyDir)).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "strict" }, emptyDir)).toBe("strict");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "off" }, emptyDir)).toBe("off");
    expect(
      resolveShellSandboxMode(
        { KERYX_SANDBOX_SHELL: "strict", KERYX_DANGEROUSLY_DISABLE_SANDBOX: "1" },
        emptyDir,
      ),
    ).toBe("off");
  });

  test("P1: sandbox.json shell used when env unset; env wins", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-sbx-shell-"));
    saveSandboxDefaults({ shell: "workspace" }, dir);
    expect(resolveShellSandboxMode({}, dir)).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "strict" }, dir)).toBe("strict");
  });
});

const FIXTURE_KEY = "sk-test-fixture-not-real";

describe("resolveShellRestrictedMasks (AC7)", () => {
  test("P0.b default auto: key present without MASK_ENV → masks + auto TLS", () => {
    // Empty config dir so developer sandbox.json cannot affect unit test.
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-p0b-"));
    const r = resolveShellRestrictedMasks({ DEEPSEEK_API_KEY: FIXTURE_KEY }, emptyDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks).toEqual([
      {
        name: "DEEPSEEK_API_KEY",
        realValue: FIXTURE_KEY,
        injectHosts: ["api.deepseek.com"],
      },
    ]);
    expect(r.tlsTerminate).toBe(true);
  });

  test("explicit manual: key present without MASK_ENV → no masks", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-man-"));
    const r = resolveShellRestrictedMasks(
      { KERYX_SANDBOX_MASK_MODE: "manual", DEEPSEEK_API_KEY: FIXTURE_KEY },
      emptyDir,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks).toEqual([]);
    expect(r.tlsTerminate).toBe(false);
  });

  test("auto mode derives deepseek mask and auto TLS", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-auto-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_MODE: "auto",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      emptyDir,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks).toEqual([
      {
        name: "DEEPSEEK_API_KEY",
        realValue: FIXTURE_KEY,
        injectHosts: ["api.deepseek.com"],
      },
    ]);
    expect(r.tlsTerminate).toBe(true);
  });

  test("manual MASK_ENV without TLS fails closed", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-tls-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_MODE: "manual",
        KERYX_SANDBOX_MASK_ENV: "DEEPSEEK_API_KEY@api.deepseek.com",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      emptyDir,
    );
    expect(r.ok).toBe(false);
  });

  test("manual MASK_ENV with TLS=1 wires masks", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-tls1-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_MODE: "manual",
        KERYX_SANDBOX_MASK_ENV: "DEEPSEEK_API_KEY@api.deepseek.com",
        KERYX_SANDBOX_TLS_TERMINATE: "1",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      emptyDir,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks[0]?.name).toBe("DEEPSEEK_API_KEY");
    expect(r.tlsTerminate).toBe(true);
  });

  test("invalid MASK_ENV fails closed", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-bad-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_ENV: "NOHOST",
        KERYX_SANDBOX_TLS_TERMINATE: "1",
      },
      emptyDir,
    );
    expect(r.ok).toBe(false);
  });
});

// Live FS-containment smoke — gated on KERYX_ALLOW_REAL_SUBPROCESS=1 + macOS.
const liveFlag = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1" && process.platform === "darwin";
describe.skipIf(!liveFlag)("makeCommandRunner OS sandbox (macOS live)", () => {
  test("strict mode: write inside workspace succeeds, write outside is denied", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-shell-sbx-")));
    const outside = path.join(homedir(), `keryx_shell_FORBIDDEN_${process.pid}.txt`);
    const prev = process.env.KERYX_SANDBOX_SHELL;
    process.env.KERYX_SANDBOX_SHELL = "strict";
    try {
      const run = makeCommandRunner(root);
      await run("echo ok > ./inside.txt");
      expect(existsSync(path.join(root, "inside.txt"))).toBe(true);

      await run(`echo bad > ${outside}`);
      expect(existsSync(outside)).toBe(false); // sandbox denied the outside write
    } finally {
      if (prev === undefined) delete process.env.KERYX_SANDBOX_SHELL;
      else process.env.KERYX_SANDBOX_SHELL = prev;
      if (existsSync(outside)) rmSync(outside);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restricted network: allowlisted host reachable via proxy, others blocked", async () => {
    const upstream = http.createServer((_q, r) => {
      r.writeHead(200);
      r.end("OK-UP");
    });
    const upPort: number = await new Promise((res) =>
      upstream.listen(0, "127.0.0.1", () => res((upstream.address() as { port: number }).port)),
    );
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-shell-net-")));
    const prevMode = process.env.KERYX_SANDBOX_SHELL;
    const prevDomains = process.env.KERYX_SANDBOX_ALLOWED_DOMAINS;
    process.env.KERYX_SANDBOX_SHELL = "strict";
    process.env.KERYX_SANDBOX_ALLOWED_DOMAINS = "localhost";
    try {
      const run = makeCommandRunner(root);
      await run(`/usr/bin/curl -sS -m 5 -o ./allowed.txt http://localhost:${upPort}/`);
      expect(readFileSync(path.join(root, "allowed.txt"), "utf8")).toContain("OK-UP");

      await run("/usr/bin/curl -sS -m 5 -o ./blocked.txt http://blocked.invalid/");
      expect(readFileSync(path.join(root, "blocked.txt"), "utf8")).toContain(
        "blocked by keryx sandbox network allowlist",
      );
    } finally {
      if (prevMode === undefined) delete process.env.KERYX_SANDBOX_SHELL;
      else process.env.KERYX_SANDBOX_SHELL = prevMode;
      if (prevDomains === undefined) delete process.env.KERYX_SANDBOX_ALLOWED_DOMAINS;
      else process.env.KERYX_SANDBOX_ALLOWED_DOMAINS = prevDomains;
      await new Promise<void>((r) => upstream.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
