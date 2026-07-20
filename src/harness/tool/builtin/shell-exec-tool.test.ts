import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { type CommandRunner, makeCommandRunner, resolveShellSandboxMode, shellExecTool } from "./shell-exec-tool";

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

describe("resolveShellSandboxMode", () => {
  test("default off; workspace/strict opt-in; danger forces off", () => {
    expect(resolveShellSandboxMode({})).toBe("off");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "workspace" })).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "1" })).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "strict" })).toBe("strict");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "off" })).toBe("off");
    expect(
      resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "strict", KERYX_DANGEROUSLY_DISABLE_SANDBOX: "1" }),
    ).toBe("off");
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
});
