import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { learnCommand, type LearnCommandDeps } from "./learn";
import { observationFilePath } from "../learning/service";

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function capture(run: () => Promise<void> | void): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  process.exitCode = 0;
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, stderr, exitCode };
}

function withTempHome<T>(fn: (root: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-learn-cmd-root-"));
  const home = mkdtempSync(path.join(tmpdir(), "keryx-learn-cmd-home-"));
  const env = { KERYX_HOME: home };
  return fn(root, env).finally(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

describe("keryx learn accept: non-TTY refusal through the command layer", () => {
  test("refuses with a named reason, no bypass", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: false };
      const run = await capture(() => learnCommand(["accept", "testing.whatever-00000000"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("accept-requires-terminal");
    });
  });

  test("--yes is refused as an unknown flag, not silently accepted as a bypass", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true };
      const run = await capture(() => learnCommand(["accept", "testing.whatever-00000000", "--yes"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
      expect(run.stderr).toContain("--yes");
    });
  });
});

describe("keryx learn promote: non-TTY refusal through the command layer", () => {
  test("refuses with a named reason, no bypass, before ever calling promotePattern", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: false };
      const run = await capture(() => learnCommand(["promote", "testing.whatever-00000000"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("promote-requires-terminal");
      // Not the stub's own "not-implemented" — the command layer's own TTY
      // guard must refuse before ever reaching `promotePattern`.
      expect(run.stderr).not.toContain("not-implemented");
    });
  });

  test("--yes is refused: promote takes no flags at all", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true, readLine: async () => "testing.whatever-00000000" };
      const run = await capture(() => learnCommand(["promote", "testing.whatever-00000000", "--yes"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
      expect(run.stderr).toContain("--yes");
    });
  });
});

describe("keryx learn graduate apply: non-TTY refusal and no bypass flag", () => {
  test("refuses with a named reason", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: false };
      const run = await capture(() => learnCommand(["graduate", "apply", "proposal-1"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("graduate-apply-requires-terminal");
    });
  });

  test("--yes is refused", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true };
      const run = await capture(() => learnCommand(["graduate", "apply", "proposal-1", "--yes"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
    });
  });
});

describe("keryx learn observe --hook claude", () => {
  test("invalid JSON on stdin: exits 0, prints nothing, writes no observation line", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, readStdin: async () => "{ not valid json" };
      const run = await capture(() => learnCommand(["observe", "--hook", "claude"], deps));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe("");
      const today = new Date().toISOString().slice(0, 10);
      expect(() => readFileSync(observationFilePath(root, today), "utf8")).toThrow();
    });
  });

  test("a valid PostToolUse payload: exits 0, prints nothing, appends one observation line", async () => {
    await withTempHome(async (root, env) => {
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      const payload = {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_response: { stdout: "hi\n" },
        cwd: root,
      };
      const deps: LearnCommandDeps = { cwd: root, env, readStdin: async () => JSON.stringify(payload) };
      const run = await capture(() => learnCommand(["observe", "--hook", "claude"], deps));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe("");

      const today = new Date().toISOString().slice(0, 10);
      const raw = readFileSync(observationFilePath(root, today), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]!) as { event: string; sessionId: string; tool: string | null };
      expect(line.event).toBe("tool-complete");
      expect(line.sessionId).toBe("session-1");
      expect(line.tool).toBe("Bash");
    });
  });

  // O-3
  test("cwd inside a subdirectory: the observation is still written at the project root (nearest .metaproject/)", async () => {
    await withTempHome(async (root, env) => {
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      const subdir = path.join(root, "src", "deep", "nested");
      mkdirSync(subdir, { recursive: true });
      const payload = { hook_event_name: "SessionEnd", session_id: "session-1", cwd: subdir };
      const deps: LearnCommandDeps = { cwd: subdir, env, readStdin: async () => JSON.stringify(payload) };
      const run = await capture(() => learnCommand(["observe", "--hook", "claude"], deps));
      expect(run.exitCode).toBe(0);

      const today = new Date().toISOString().slice(0, 10);
      // Written at the project ROOT's observations dir, not under the subdirectory.
      const raw = readFileSync(observationFilePath(root, today), "utf8");
      expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
      expect(() => readFileSync(observationFilePath(subdir, today), "utf8")).toThrow();
    });
  });

  // O-3
  test("no .metaproject/ anywhere above cwd: exits 0 and writes nothing (never creates one)", async () => {
    const bareDir = mkdtempSync(path.join(tmpdir(), "keryx-learn-cmd-bare-"));
    try {
      const payload = { hook_event_name: "SessionEnd", session_id: "session-1", cwd: bareDir };
      const deps: LearnCommandDeps = { cwd: bareDir, env: {}, readStdin: async () => JSON.stringify(payload) };
      const run = await capture(() => learnCommand(["observe", "--hook", "claude"], deps));
      expect(run.exitCode).toBe(0);
      expect(() => readFileSync(path.join(bareDir, ".metaproject"), "utf8")).toThrow();
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  // O-6
  test("stdin over 1 MiB is dropped: exits 0, writes nothing", async () => {
    await withTempHome(async (root, env) => {
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      const oversized = `{"hook_event_name":"SessionEnd","session_id":"s1","cwd":"${root}","padding":"${"a".repeat(1024 * 1024 + 1)}"}`;
      const deps: LearnCommandDeps = { cwd: root, env, readStdin: async () => oversized };
      const run = await capture(() => learnCommand(["observe", "--hook", "claude"], deps));
      expect(run.exitCode).toBe(0);
      const today = new Date().toISOString().slice(0, 10);
      expect(() => readFileSync(observationFilePath(root, today), "utf8")).toThrow();
    });
  });

  test("without --hook: reports today's observation file line count", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["observe"], deps));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("0 line(s)");
      expect(run.stdout).toContain("writer is unbuffered; nothing to flush");
    });
  });
});

describe("keryx learn: unknown subcommand", () => {
  test("is refused with a non-zero exit", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["bogus"], deps));
      expect(run.exitCode).toBe(1);
    });
  });
});
