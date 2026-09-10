import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendWatchdogLine,
  descendantCommands,
  evaluate,
  hasLongRunningChild,
  killProcessTree,
  silenceOf,
  thresholdsFor,
  type WatchdogSnapshot,
} from "./arena-watchdog";

const research = thresholdsFor("research");

function snapshot(overrides: Partial<WatchdogSnapshot> = {}): WatchdogSnapshot {
  return {
    elapsedMs: 60_000,
    silenceMs: 1000,
    children: ["/usr/bin/claude -p ..."],
    tokens: 50_000,
    repeatedCalls: 0,
    escapedWrites: [],
    treeGrowthBytes: 10_000,
    ...overrides,
  };
}

describe("evaluate — the case usually forgotten", () => {
  test("an arm working honestly at 90% of its budget is NOT killed", () => {
    // Every other test here proves the watchdog can kill. This one proves it does
    // not kill the thing it exists to protect, which is the failure that makes a
    // watchdog worse than none.
    const verdict = evaluate(snapshot({ elapsedMs: research.ceilingMs * 0.9 }), research);
    expect(verdict.kill).toBe(false);
  });

  test("a healthy snapshot is not killed for any reason", () => {
    expect(evaluate(snapshot(), research).kill).toBe(false);
  });
});

describe("evaluate — each signal fires", () => {
  test("the hard ceiling", () => {
    const verdict = evaluate(snapshot({ elapsedMs: research.ceilingMs + 1 }), research);
    expect(verdict.reason).toBe("ceiling");
  });

  test("silence, when nothing long is running", () => {
    const verdict = evaluate(
      snapshot({ silenceMs: research.silenceMs + 1, children: ["/bin/sh -c idle"] }),
      research,
    );
    expect(verdict.reason).toBe("silence");
  });

  test("the token ceiling", () => {
    expect(evaluate(snapshot({ tokens: research.tokenCeiling + 1 }), research).reason).toBe("tokens");
  });

  test("a loop", () => {
    expect(evaluate(snapshot({ repeatedCalls: research.loopLimit }), research).reason).toBe("loop");
  });

  test("disk growth", () => {
    expect(evaluate(snapshot({ treeGrowthBytes: research.diskCeilingBytes + 1 }), research).reason).toBe("disk");
  });

  test("a write outside the arm's roots", () => {
    const verdict = evaluate(snapshot({ escapedWrites: ["/Users/someone/.claude/settings.json"] }), research);
    expect(verdict.reason).toBe("escaped-tree");
  });

  test("an empty process tree that is also silent is hung, and needs no patience", () => {
    const verdict = evaluate(snapshot({ children: [], silenceMs: research.silenceMs + 1 }), research);
    expect(verdict.reason).toBe("dead-and-silent");
  });
});

describe("evaluate — silence suspension", () => {
  test("a graph rebuild buys silence, because the context arm is INSTRUCTED to run one", () => {
    // `.metaproject/index.md` tells the context arm to rebuild when uncommitted
    // code files are present, and a T2 tree is dirty from the first edit. A naive
    // silence detector would kill exactly the behaviour under test and the report
    // would name keryx as the harness that hangs.
    const verdict = evaluate(
      snapshot({ silenceMs: research.silenceMs * 3, children: ["keryx gdgraph build"] }),
      research,
    );
    expect(verdict.kill).toBe(false);
    expect(verdict.silenceSuspended).toBe(true);
  });

  test("suspension does not excuse a loop, a token overrun or an escape", () => {
    // Otherwise "keep a long child alive" becomes a way to run forever.
    const children = ["keryx gdgraph build"];
    expect(evaluate(snapshot({ children, repeatedCalls: 9 }), research).reason).toBe("loop");
    expect(evaluate(snapshot({ children, tokens: 99_000_000 }), research).reason).toBe("tokens");
    expect(evaluate(snapshot({ children, escapedWrites: ["/etc/hosts"] }), research).reason).toBe("escaped-tree");
    expect(evaluate(snapshot({ children, elapsedMs: research.ceilingMs + 1 }), research).reason).toBe("ceiling");
  });

  test("an unrelated child does not suspend silence", () => {
    const verdict = evaluate(
      snapshot({ silenceMs: research.silenceMs + 1, children: ["/usr/bin/say hello"] }),
      research,
    );
    expect(verdict.reason).toBe("silence");
  });
});

describe("evaluate — reason precedence", () => {
  test("an escape outranks an expired ceiling, because the reason is the diagnosis", () => {
    // A row that says "ceiling" when the arm actually wrote outside its worktree
    // costs an hour of reading the wrong logs.
    const verdict = evaluate(
      snapshot({ elapsedMs: research.ceilingMs + 1, escapedWrites: ["/Users/x/.claude/CLAUDE.md"] }),
      research,
    );
    expect(verdict.reason).toBe("escaped-tree");
  });
});

describe("thresholdsFor", () => {
  test("implement gets a longer ceiling than research", () => {
    expect(thresholdsFor("implement").ceilingMs).toBeGreaterThan(thresholdsFor("research").ceilingMs);
  });

  test("the adapter's own timeout must be able to sit ABOVE the ceiling", () => {
    // The watchdog has to win, or a kill is attributed to a bare timeout with no
    // reason recorded. Guarded here as an arithmetic fact the runner relies on.
    const ceiling = thresholdsFor("implement").ceilingMs;
    expect(ceiling + 60_000).toBeGreaterThan(ceiling);
  });
});

describe("hasLongRunningChild", () => {
  test("matches a known long command anywhere in the line", () => {
    expect(hasLongRunningChild(["/bin/sh -c 'keryx gdgraph build'"])).toBe(true);
  });

  test("an empty tree has no long child", () => {
    expect(hasLongRunningChild([])).toBe(false);
  });
});

describe("silenceOf", () => {
  test("a file that does not exist yet is not silence", () => {
    // An arm whose events file has not appeared is starting, not hung. Treating
    // absence as silence would kill every arm in its first poll.
    expect(silenceOf(path.join(mkdtempSync(path.join(tmpdir(), "wd-")), "absent.jsonl"))).toBe(0);
  });

  test("a file just written reports near-zero silence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-"));
    const file = path.join(dir, "events.jsonl");
    writeFileSync(file, "{}\n");
    expect(silenceOf(file)).toBeLessThan(5000);
  });

  test("silence is measured from the file's mtime", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-"));
    const file = path.join(dir, "events.jsonl");
    writeFileSync(file, "{}\n");
    expect(silenceOf(file, Date.now() + 600_000)).toBeGreaterThan(590_000);
  });
});

describe("descendantCommands", () => {
  test("finds a real child process", () => {
    const child = Bun.spawn(["sleep", "2"], { stdout: "ignore", stderr: "ignore" });
    try {
      const commands = descendantCommands(process.pid);
      expect(commands.some((command) => command.includes("sleep"))).toBe(true);
    } finally {
      child.kill();
    }
  });

  test("a pid that has exited yields nothing rather than throwing", () => {
    const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["sleep", "0.3"]);
    expect(descendantCommands(proc.pid)).toEqual([]);
  });

  test("the walk is bounded, so a poll cannot enumerate the whole machine", () => {
    // Unbounded from pid 1 this took 18 seconds — which would make the watchdog
    // the slowest thing in the run it is supposed to be supervising.
    const started = Date.now();
    const commands = descendantCommands(1, 8);
    expect(commands.length).toBeLessThanOrEqual(8);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("killProcessTree", () => {
  test("takes down a detached group and reports no survivors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-kill-"));
    const proc = Bun.spawn(["sh", "-c", `cd ${dir} && sleep 120`], {
      stdout: "ignore",
      stderr: "ignore",
      // Leading its own group is what makes a group kill possible at all.
      detached: true,
    });
    const outcome = killProcessTree(proc.pid, dir, 500);
    expect(outcome.signalled.length).toBeGreaterThan(0);
    expect(outcome.survivors).toEqual([]);
  });

  test("a group that is already gone is not an error", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-kill-"));
    const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore", detached: true });
    Bun.spawnSync(["sleep", "0.3"]);
    expect(() => killProcessTree(proc.pid, dir, 200)).not.toThrow();
  });
});

describe("appendWatchdogLine", () => {
  test("appends one JSON object per poll and creates the directory", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "wd-log-")), "run", "watchdog.jsonl");
    appendWatchdogLine(file, {
      ...snapshot(),
      t: "2026-09-10T00:00:00Z",
      cell: "keryx-shell/t1-abc/context-on",
      phase: "agent",
      budgetMs: research.ceilingMs,
      verdict: "ok",
      silenceSuspended: false,
    });
    appendWatchdogLine(file, {
      ...snapshot(),
      t: "2026-09-10T00:00:15Z",
      cell: "keryx-shell/t1-abc/context-on",
      phase: "agent",
      budgetMs: research.ceilingMs,
      verdict: "killed",
      reason: "silence",
      silenceSuspended: false,
    });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "{}").reason).toBe("silence");
  });
});
