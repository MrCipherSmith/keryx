import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { superviseArm } from "./arena-supervisor";
import { killPidTree, thresholdsFor, type WatchdogThresholds } from "./arena-watchdog";
import { ArmKilledError, readTracked, throwIfKilled } from "../benchmark/retrieval-supervision";

const tight: WatchdogThresholds = {
  ...thresholdsFor("research"),
  ceilingMs: 150,
  silenceMs: 60_000,
};

const waitFor = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
};

describe("superviseArm", () => {
  test("kills a real child that outruns its ceiling, and says why", async () => {
    const proc = Bun.spawn(["sleep", "30"]);
    const supervision = superviseArm(
      { pid: proc.pid, silenceMs: () => 0 },
      {
        thresholds: tight,
        worktreePath: "/nonexistent-arena-tree",
        cell: "t-x-on",
        pollMs: 25,
        // The real kill, with a short grace: a SIGTERMed child stays a zombie until
        // Bun reaps it, reads as alive, and the default 5s grace outlasts the test.
        kill: (pid, tree) => void killPidTree(pid, tree, 100),
      },
    );
    await waitFor(() => supervision.killReason !== undefined);
    await proc.exited;
    supervision.stop();
    expect(supervision.killReason).toBe("ceiling");
    expect(proc.signalCode ?? proc.exitCode).not.toBe(0);
    expect(() => throwIfKilled(supervision)).toThrow(ArmKilledError);
  });

  test("leaves an arm alone that is working inside its budget", async () => {
    // The case the watchdog's own tests call the one usually forgotten: an honest
    // arm must reach the end of its budget, not be trimmed near it.
    const killed: number[] = [];
    const supervision = superviseArm(
      { pid: 999_999, silenceMs: () => 0 },
      {
        thresholds: { ...tight, ceilingMs: 60_000 },
        worktreePath: "/nonexistent-arena-tree",
        cell: "t-x-on",
        pollMs: 20,
        observeChildren: () => ["bun src/cli.ts shell"],
        kill: (pid) => void killed.push(pid),
      },
    );
    await Bun.sleep(150);
    supervision.stop();
    expect(killed).toEqual([]);
    expect(supervision.killReason).toBeUndefined();
    expect(() => throwIfKilled(supervision)).not.toThrow();
  });

  test("silence is suspended while a known-long child is alive", async () => {
    // A context arm told to run `keryx gdgraph build` emits nothing while it does.
    const killed: number[] = [];
    const supervision = superviseArm(
      { pid: 999_999, silenceMs: () => 10 * 60_000 },
      {
        thresholds: { ...tight, ceilingMs: 60_000, silenceMs: 1000 },
        worktreePath: "/nonexistent-arena-tree",
        cell: "t-x-on",
        pollMs: 20,
        observeChildren: () => ["keryx gdgraph build"],
        kill: (pid) => void killed.push(pid),
      },
    );
    await Bun.sleep(120);
    supervision.stop();
    expect(killed).toEqual([]);
  });

  test("writes one log line per poll, with the verdict", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "supervisor-test-"));
    try {
      const logFile = path.join(root, "watchdog.jsonl");
      const supervision = superviseArm(
        { pid: 999_999, silenceMs: () => 0 },
        {
          thresholds: tight,
          worktreePath: "/nonexistent-arena-tree",
          cell: "t-x-on",
          pollMs: 20,
          logFile,
          observeChildren: () => ["x"],
          kill: () => {},
        },
      );
      await waitFor(() => supervision.killReason !== undefined);
      supervision.stop();
      const lines = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.at(-1)?.verdict).toBe("killed");
      expect(lines.at(-1)?.reason).toBe("ceiling");
      expect(lines.every((line) => line.cell === "t-x-on")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readTracked", () => {
  test("returns the whole stream and notes every chunk", async () => {
    let chunks = 0;
    const proc = Bun.spawn(["sh", "-c", "printf 'a\\n'; sleep 0.05; printf 'b\\n'"], { stdout: "pipe" });
    const text = await readTracked(proc.stdout, () => void (chunks += 1));
    expect(text).toBe("a\nb\n");
    expect(chunks).toBeGreaterThanOrEqual(2);
  });
});
