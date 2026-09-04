// `keryx sessions fork` — branching reachable from the CLI (flow 134, S4 / AC6).
//
// Before this verb the only way to branch a conversation was to copy transcript
// files by hand: `forkBranch` existed in the harness but had no entry point, and
// nothing in the product ever set `parentSessionId`. These tests drive the
// command exactly as the CLI does — argv in, session store on disk out — and
// assert the branch lands in the store with its ancestry intact.
//
// Isolation: every test points `KERYX_DATA_DIR` at a fresh temp directory, so
// nothing here reads or writes the developer's real sessions.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createSession,
  findSession,
  listSessions,
  loadContext,
  persistHistory,
  resolveProjectRoot,
  sessionDir,
} from "../session";
import { sessionsCommand } from "./sessions";

let dataDir: string;
let projectDir: string;
let previousDataDir: string | undefined;
let logged: string[];
let errored: string[];
let restoreLog: () => void;

function captureConsole(): () => void {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errored.push(args.map(String).join(" "));
  };
  return () => {
    console.log = originalLog;
    console.error = originalError;
  };
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-fork-data-")));
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-fork-proj-")));
  previousDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
  logged = [];
  errored = [];
  restoreLog = captureConsole();
  process.exitCode = 0;
});

afterEach(() => {
  restoreLog();
  if (previousDataDir === undefined) {
    delete process.env.KERYX_DATA_DIR;
  } else {
    process.env.KERYX_DATA_DIR = previousDataDir;
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  process.exitCode = 0;
});

/** A source session with two turns of history, persisted like the shell does. */
function seedSession(title = "original work"): string {
  const created = createSession({
    cwd: projectDir,
    title,
    provider: "fake-provider",
    model: "fixture-model",
  });
  persistHistory(
    created,
    [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    { title },
  );
  return created.summary.id;
}

/** Run the command with `process.cwd()` pointed at the temp project. */
async function runSessions(args: string[]): Promise<void> {
  const originalCwd = process.cwd();
  process.chdir(projectDir);
  try {
    await sessionsCommand(args);
  } finally {
    process.chdir(originalCwd);
  }
}

describe("keryx sessions fork (flow 134, S4)", () => {
  test("forks a session into the store with parentSessionId pointing at the source", async () => {
    const sourceId = seedSession();

    await runSessions(["fork", sourceId]);

    expect(process.exitCode).toBe(0);
    const rows = listSessions(projectDir);
    expect(rows.length).toBe(2);

    const fork = rows.find((s) => s.id !== sourceId);
    expect(fork).toBeDefined();
    expect(fork?.parentSessionId).toBe(sourceId);
    expect(fork?.title).toBe("original work (fork)");
    // Provider/model carry over: a branch of a conversation is the same
    // conversation until it diverges.
    expect(fork?.provider).toBe("fake-provider");
    expect(fork?.model).toBe("fixture-model");
  });

  test("the fork resumes with the source's history, and writing to it leaves the source untouched", async () => {
    const sourceId = seedSession();

    await runSessions(["fork", sourceId, "--json"]);
    const payload = JSON.parse(logged.join("\n")) as { id: string; parentSessionId: string };
    expect(payload.parentSessionId).toBe(sourceId);

    const forkHistory = loadContext(projectDir, payload.id);
    expect(forkHistory.map((m) => m.content)).toEqual(["first question", "first answer"]);

    // Diverge the fork, then re-read the source: the copy is a copy.
    const forkSummary = findSession(projectDir, payload.id);
    expect(forkSummary).toBeDefined();
    persistHistory(
      {
        summary: forkSummary as NonNullable<typeof forkSummary>,
        dir: sessionDir(resolveProjectRoot(projectDir), payload.id),
      },
      [...forkHistory, { role: "user", content: "a different second question" }],
    );

    const sourceHistory = loadContext(projectDir, sourceId);
    expect(sourceHistory.map((m) => m.content)).toEqual(["first question", "first answer"]);
  });

  test("--title names the fork", async () => {
    const sourceId = seedSession();

    await runSessions(["fork", sourceId, "--title", "try the other approach"]);

    const fork = listSessions(projectDir).find((s) => s.id !== sourceId);
    expect(fork?.title).toBe("try the other approach");
  });

  test("a short id resolves the same as a full one", async () => {
    const sourceId = seedSession();
    const short = sourceId.replace(/-/g, "").slice(-8);

    await runSessions(["fork", short]);

    expect(process.exitCode).toBe(0);
    expect(listSessions(projectDir).length).toBe(2);
  });

  test("an unknown id fails with a non-zero exit and creates nothing", async () => {
    seedSession();

    await runSessions(["fork", "no-such-session"]);

    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("No session");
    expect(listSessions(projectDir).length).toBe(1);
  });

  test("a missing id prints usage rather than forking something arbitrary", async () => {
    seedSession();

    await runSessions(["fork"]);

    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("Usage: keryx sessions fork");
    expect(listSessions(projectDir).length).toBe(1);
  });

  test("the listing marks a fork so its ancestry is visible without --json", async () => {
    const sourceId = seedSession();
    await runSessions(["fork", sourceId]);
    logged = [];

    await runSessions(["list"]);

    expect(logged.join("\n")).toContain("↳ original work (fork)");
  });

  test("help mentions fork", async () => {
    await runSessions(["--help"]);
    expect(logged.join("\n")).toContain("keryx sessions fork");
  });
});
