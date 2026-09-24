import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// R1-F3 / R1-F5 (review round 1, PR #691): a shared flag parser
// (`src/learning/cli-args.ts`'s `parseLearnArgs`) replaces per-command
// `args.includes("--flag")` (blind to `--flag=value`) and
// `args.find((a) => !a.startsWith("-"))` (blind to a value-flag's own value
// looking like a positional).
// ---------------------------------------------------------------------------

describe("keryx learn: --flag=value on a boolean flag is refused, not silently read as absent (R1-F3)", () => {
  test("prune --dry-run=true is refused, and nothing is deleted", async () => {
    await withTempHome(async (root, env) => {
      const observationsDir = path.join(root, ".metaproject", "data", "learning", "observations");
      mkdirSync(observationsDir, { recursive: true });
      const staleFile = path.join(observationsDir, "2020-01-01.jsonl");
      writeFileSync(staleFile, `${JSON.stringify({ line: 1 })}\n`);

      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["prune", "--dry-run=true"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
      expect(run.stderr).toContain("--dry-run=true");
      // Refused before `pruneLearning` ever ran — the stale file (30+ days
      // past its TTL, so a real prune pass would delete it) is untouched.
      expect(readFileSync(staleFile, "utf8")).toContain('"line":1');
    });
  });

  test("apply --dry-run=1 is refused, not silently treated as a real (non-dry-run) apply", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["apply", "testing.whatever-00000000", "--skill", "module/name", "--dry-run=1"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
      expect(run.stderr).toContain("--dry-run=1");
    });
  });

  test("accept --refresh=1 is refused, not silently treated as a full (non-refresh) accept", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true };
      const run = await capture(() => learnCommand(["accept", "testing.whatever-00000000", "--refresh=1"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
      expect(run.stderr).toContain("--refresh=1");
    });
  });
});

describe("keryx learn: a value flag's own value is never read as the positional id (R1-F5)", () => {
  test("reject --scope user foo reads id \"foo\", not \"user\"", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["reject", "--scope", "user", "foo"], deps));
      // No such record — refused by rejectPattern, not by a malformed-flag
      // check — but the error names the id that was actually looked up.
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('"foo"');
      expect(run.stderr).not.toContain('"user"');
    });
  });

  test("apply --skill m/n <id> reads id, not the --skill value", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["apply", "--skill", "m/n", "testing.some-id-00000000"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("testing.some-id-00000000");
      expect(run.stderr).not.toContain('"m/n"');
    });
  });
});

// R3-F4 (review round 3, PR #691, minor): the finding lists this among the
// missing regression tests — R2-F8's "would delete"/"would expire" dry-run
// wording (distinguishing a preview from a real destructive run) had no
// test.
describe("keryx learn prune: --dry-run wording says 'would', a real run says the deed is done (R2-F8, R3-F4)", () => {
  test("--dry-run prints 'would delete'/'would expire' and deletes nothing", async () => {
    await withTempHome(async (root, env) => {
      const observationsDir = path.join(root, ".metaproject", "data", "learning", "observations");
      mkdirSync(observationsDir, { recursive: true });
      const staleFile = path.join(observationsDir, "2020-01-01.jsonl");
      writeFileSync(staleFile, `${JSON.stringify({ line: 1 })}\n`);

      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["prune", "--dry-run"], deps));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("would delete");
      expect(run.stdout).toContain("(dry run — nothing written)");
      expect(run.stdout).not.toMatch(/(?<!would )deleted \d/);
      expect(readFileSync(staleFile, "utf8")).toContain('"line":1'); // untouched
    });
  });

  test("a real run (no --dry-run) says 'deleted', not 'would delete', and actually deletes", async () => {
    await withTempHome(async (root, env) => {
      const observationsDir = path.join(root, ".metaproject", "data", "learning", "observations");
      mkdirSync(observationsDir, { recursive: true });
      const staleFile = path.join(observationsDir, "2020-01-01.jsonl");
      writeFileSync(staleFile, `${JSON.stringify({ line: 1 })}\n`);

      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["prune"], deps));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("deleted");
      expect(run.stdout).not.toContain("would delete");
      expect(run.stdout).not.toContain("dry run");
      expect(() => readFileSync(staleFile, "utf8")).toThrow(); // actually deleted
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

// ---------------------------------------------------------------------------
// R3-F4 (review round 3, PR #691, minor): the review lists this among the
// missing regression tests — per-verb `-h`/`--help` and positional-arity
// enforcement (`learn.ts`'s `wantsHelp`/`positionalArityError`, R2-F2) had
// no test at all before this. Each case below proves the guard by disabling
// it in a scratch copy (see this task's reply for the exact commands run;
// never `git stash`), not just by asserting the current behavior.
// ---------------------------------------------------------------------------

describe("keryx learn: per-verb -h/--help prints usage and does nothing (R2-F2, R3-F4)", () => {
  const CASES: ReadonlyArray<readonly [string[], string]> = [
    [["observe", "-h"], "keryx learn observe"],
    [["extract", "-h"], "keryx learn extract"],
    [["list", "-h"], "keryx learn list"],
    [["review", "-h"], "keryx learn review"],
    [["accept", "-h"], "keryx learn accept"],
    [["reject", "-h"], "keryx learn reject"],
    [["apply", "-h"], "keryx learn apply"],
    [["promote", "-h"], "keryx learn promote"],
    [["graduate", "-h"], "keryx learn graduate"],
    [["graduate", "apply", "-h"], "keryx learn graduate apply"],
    [["prune", "-h"], "keryx learn prune"],
  ];

  for (const [args, usageSubstring] of CASES) {
    test(`\`${args.join(" ")}\` prints just that verb's usage, exit 0, no side effects`, async () => {
      await withTempHome(async (root, env) => {
        const deps: LearnCommandDeps = { cwd: root, env, isTerminal: false };
        const run = await capture(() => learnCommand(args, deps));
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("Usage:");
        expect(run.stdout).toContain(usageSubstring);
        // Never reached the mutating/reading verb body: no observations dir,
        // no candidates dir, nothing created under .metaproject/.
        expect(() => readFileSync(path.join(root, ".metaproject"), "utf8")).toThrow();
      });
    });
  }

  test("--help (long spelling) works the same as -h", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["prune", "--help"], deps));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("keryx learn prune");
    });
  });

  test("-h wins even alongside other args (never reaches arity/flag validation)", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["accept", "-h", "--bogus-flag"], deps));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("keryx learn accept");
      expect(run.stderr).toBe("");
    });
  });
});

describe("keryx learn: positional arity is enforced per verb (R2-F2, R3-F4)", () => {
  test("accept with no id refuses with a usage message, never calls acceptPattern", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true };
      const run = await capture(() => learnCommand(["accept"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("usage: keryx learn accept");
    });
  });

  test("accept with two positionals refuses with the extra argument named", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true };
      const run = await capture(() => learnCommand(["accept", "id-one", "id-two"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unexpected argument(s): id-two");
    });
  });

  test("reject with no id refuses with a usage message", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["reject"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("usage: keryx learn reject");
    });
  });

  test("promote with no id refuses with a usage message", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true };
      const run = await capture(() => learnCommand(["promote"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("usage: keryx learn promote");
    });
  });

  test("graduate apply with no proposal id refuses with a usage message", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env, isTerminal: true };
      const run = await capture(() => learnCommand(["graduate", "apply"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("usage: keryx learn graduate apply");
    });
  });

  test("review takes at most one positional; a second is reported as unexpected", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["review", "id-a", "id-b"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unexpected argument(s): id-b");
    });
  });

  test("observe takes no positionals; one is reported as unexpected", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["observe", "bogus"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unexpected argument(s): bogus");
    });
  });

  test("prune takes no positionals; one is reported as unexpected, nothing pruned", async () => {
    await withTempHome(async (root, env) => {
      const observationsDir = path.join(root, ".metaproject", "data", "learning", "observations");
      mkdirSync(observationsDir, { recursive: true });
      const staleFile = path.join(observationsDir, "2020-01-01.jsonl");
      writeFileSync(staleFile, `${JSON.stringify({ line: 1 })}\n`);

      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["prune", "bogus"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unexpected argument(s): bogus");
      expect(readFileSync(staleFile, "utf8")).toContain('"line":1');
    });
  });
});

describe("keryx learn: a single-dash flag (other than the lone '-') is refused, not silently accepted as a positional (R2-F2, R3-F4)", () => {
  test("prune -n is refused as an unknown flag, and nothing is pruned", async () => {
    await withTempHome(async (root, env) => {
      const observationsDir = path.join(root, ".metaproject", "data", "learning", "observations");
      mkdirSync(observationsDir, { recursive: true });
      const staleFile = path.join(observationsDir, "2020-01-01.jsonl");
      writeFileSync(staleFile, `${JSON.stringify({ line: 1 })}\n`);

      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["prune", "-n"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
      expect(run.stderr).toContain("-n");
      expect(readFileSync(staleFile, "utf8")).toContain('"line":1');
    });
  });

  test("extract -x is refused as an unknown flag", async () => {
    await withTempHome(async (root, env) => {
      const deps: LearnCommandDeps = { cwd: root, env };
      const run = await capture(() => learnCommand(["extract", "-x"], deps));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("unknown flag");
      expect(run.stderr).toContain("-x");
    });
  });
});
