// The autonomous runner, against a scripted child so every exit code can be reached.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AutonomousRunLockedError,
  runAutonomousReview,
  type AutonomousRunOptions,
  type ChildHandle,
  type ChildSpec,
} from "./autonomous-run";
import { validateSummary } from "./autonomous-summary";

const REF = "https://github.com/o/r/pull/7";
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "autonomous-run-"));
  mkdirSync(path.join(cwd, ".metaproject", "reviews"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const call = (command: string) => ({ type: "tool_call", name: "bash", input: JSON.stringify({ command }) });
const result = (output: string, isError = false) => ({ type: "tool_result", name: "bash", isError, output });

function writePackage(id: string, status: string, findings: unknown[] = []): void {
  const dir = path.join(cwd, ".metaproject", "reviews", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, reviewId: id, status, target: { kind: "pr", ref: REF }, updatedAt: new Date().toISOString() }),
  );
  writeFileSync(path.join(dir, "findings.json"), JSON.stringify(findings));
}

interface Ctx {
  spec: ChildSpec;
  emit: (event: object) => void;
  answer: (record: object) => void;
  killed: () => boolean;
  sleep: (ms: number) => Promise<void>;
}

/** A child whose behaviour is a script; it exits with 143 when killed. */
function scripted(script: (ctx: Ctx) => Promise<number> | number, seen?: ChildSpec[], kills?: string[]) {
  return (spec: ChildSpec): ChildHandle => {
    seen?.push(spec);
    let killed = false;
    let release: (code: number) => void = () => {};
    const killedSignal = new Promise<number>((resolve) => {
      release = resolve;
    });
    const ctx: Ctx = {
      spec,
      emit: (event) => appendFileSync(spec.eventsFile, `${JSON.stringify(event)}\n`),
      answer: (record) => appendFileSync(spec.answersFile, `${JSON.stringify(record)}\n`),
      killed: () => killed,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const exited = Promise.race([Promise.resolve().then(() => script(ctx)), killedSignal]);
    return {
      exited,
      kill: (signal) => {
        kills?.push(signal ?? "SIGTERM");
        killed = true;
        release(143);
      },
    };
  };
}

function options(spawn: ReturnType<typeof scripted>, overrides: Partial<AutonomousRunOptions> = {}): AutonomousRunOptions {
  return {
    cwd,
    ref: REF,
    spawn,
    resolveHead: async () => "abc123",
    pollMs: 5,
    stallMs: 2000,
    killGraceMs: 20,
    ...overrides,
  };
}

describe("exit codes", () => {
  test("0: the package closed", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          c.emit(call("keryx review start --target pr"));
          c.emit(result("started"));
          writePackage("rv-1", "closed", [{ severity: "major" }, { severity: "major" }, { severity: "minor" }]);
          c.emit(call("keryx review complete rv-1"));
          c.emit(result("closed"));
          c.emit({ type: "usage", usage: { totalTokens: 900 } });
          c.emit({ type: "turn_end", text: "done", toolCalls: 2 });
          return 0;
        }),
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(run.status).toBe("complete");
    expect(run.summary.package).toMatchObject({ id: "rv-1", status: "closed" });
    expect(run.summary.findings).toEqual({ blocker: 0, major: 2, minor: 1, info: 0 });
    expect(run.summary.tokens).toBe(900);
    expect(validateSummary(run.summary)).toEqual([]);
    expect(existsSync(path.join(run.runDir, "summary.json"))).toBe(true);
    expect(existsSync(path.join(run.runDir, "report.md"))).toBe(true);
  });

  test("2: the turn ended with the package still open", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          writePackage("rv-1", "reviewed");
          c.emit(call("keryx review ingest --id rv-1"));
          c.emit(result("ingested"));
          c.emit({ type: "turn_end", text: "I stopped", toolCalls: 1 });
          return 0;
        }),
      ),
    );
    expect(run.exitCode).toBe(2);
    expect(run.status).toBe("incomplete");
    expect(run.summary.package?.status).toBe("reviewed");
    expect(run.summary.rounds).toBe(1);
  });

  test("2: the child died before opening any package", async () => {
    const run = await runAutonomousReview(options(scripted(() => 1)));
    expect(run.exitCode).toBe(2);
    expect(run.summary.package).toBeNull();
  });

  test("3: a floor refused a call and the package was not closed", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          writePackage("rv-1", "reviewed");
          c.emit(call("gh pr merge 7"));
          c.emit(result("command not approved by the user; not executed", true));
          c.emit({ type: "turn_end", text: "blocked", toolCalls: 1 });
          return 0;
        }),
      ),
    );
    expect(run.exitCode).toBe(3);
    expect(run.status).toBe("floor");
    expect(run.summary.floorRefusals).toBe(1);
    expect(run.summary.reason).toContain("floor");
  });

  test("a refusal that the run routed around does not fail a closed package", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          c.emit(call("rm -rf x"));
          c.emit(result("command not approved by the user; not executed", true));
          writePackage("rv-1", "closed");
          return 0;
        }),
      ),
    );
    expect(run.exitCode).toBe(0);
    expect(run.summary.floorRefusals).toBe(1);
  });

  test("4: the token budget stops the run and keeps the package", async () => {
    const kills: string[] = [];
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          writePackage("rv-1", "draft");
          c.emit({ type: "usage", usage: { totalTokens: 5000 } });
          await c.sleep(10_000);
          return 0;
        }, undefined, kills),
        { budgetTokens: 1000 },
      ),
    );
    expect(run.exitCode).toBe(4);
    expect(run.status).toBe("budget");
    expect(run.summary.reason).toContain("token budget 1000");
    expect(run.summary.package?.id).toBe("rv-1");
    expect(kills.length).toBeGreaterThan(0);
  });

  test("2: an operator stop ends the child, keeps the package and says it was stopped", async () => {
    const stop = new AbortController();
    const kills: string[] = [];
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          writePackage("rv-1", "draft");
          c.emit(call("keryx review ingest --id rv-1"));
          setTimeout(() => stop.abort(), 30);
          await c.sleep(10_000);
          return 0;
        }, undefined, kills),
        { signal: stop.signal },
      ),
    );
    expect(run.exitCode).toBe(2);
    expect(run.status).toBe("incomplete");
    expect(run.summary.reason).toContain("stopped by the operator");
    expect(run.summary.package?.id).toBe("rv-1");
    expect(kills.length).toBeGreaterThan(0);
  });

  test("4: the wall-clock budget stops a run that never ends", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          c.emit({ type: "usage", usage: { totalTokens: 1 } });
          await c.sleep(10_000);
          return 0;
        }),
        { budgetMinutes: 0.001 },
      ),
    );
    expect(run.exitCode).toBe(4);
    expect(run.summary.reason).toMatch(/minute budget/);
  });

  test("the budget waits for a tool call in flight, within the grace", async () => {
    const kills: string[] = [];
    let resultAt = 0;
    let killedAt = 0;
    const spawn = scripted(
      async (c) => {
        c.emit(call("keryx review ingest --id x"));
        await c.sleep(80);
        resultAt = Date.now();
        c.emit(result("ok"));
        await c.sleep(10_000);
        return 0;
      },
      undefined,
      kills,
    );
    const wrapped = (spec: ChildSpec): ChildHandle => {
      const handle = spawn(spec);
      return {
        exited: handle.exited,
        kill: (signal) => {
          killedAt = Date.now();
          handle.kill(signal);
        },
      };
    };
    const run = await runAutonomousReview(options(wrapped as ReturnType<typeof scripted>, { budgetMinutes: 0.0005, budgetGraceMs: 2000 }));
    expect(run.exitCode).toBe(4);
    expect(killedAt).toBeGreaterThanOrEqual(resultAt);
  });

  test("5: a child that goes quiet is stopped and the last phase named", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          c.emit(call("keryx review ingest --id x"));
          c.emit(result("ok"));
          await c.sleep(10_000);
          return 0;
        }),
        { stallMs: 120 },
      ),
    );
    expect(run.exitCode).toBe(5);
    expect(run.status).toBe("stalled");
    expect(run.summary.phase).toBe("review ingest");
    expect(run.summary.reason).toContain("review ingest");
  });

  test("a child that keeps writing is not stalled", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          for (let i = 0; i < 6; i += 1) {
            c.emit({ type: "assistant", text: "still here" });
            await c.sleep(40);
          }
          writePackage("rv-1", "closed");
          return 0;
        }),
        { stallMs: 120 },
      ),
    );
    expect(run.exitCode).toBe(0);
  });
});

describe("launch", () => {
  test("starts a print shell with no stdin, review-auto, trust, and an answers file", async () => {
    const seen: ChildSpec[] = [];
    await runAutonomousReview(options(scripted(() => 0, seen)));
    const spec = seen[0]!;
    expect(spec.stdin).toBe("ignore");
    expect(spec.argv).toContain("--print");
    expect(spec.argv).toContain("--trust");
    expect(spec.argv[spec.argv.indexOf("--review-system") + 1]).toBe("review-auto");
    expect(spec.env["KERYX_REVIEW_SYSTEM"]).toBe("review-auto");
    expect(spec.env["KERYX_AUTONOMOUS_ANSWERS_FILE"]).toBe(spec.answersFile);
    expect(spec.argv.join(" ")).toContain(REF);
  });

  test("the real child sees neither a TTY on stdin nor on stdout, and gets the environment", async () => {
    const run = await runAutonomousReview({
      cwd,
      ref: REF,
      resolveHead: async () => "abc123",
      command: { execPath: process.execPath, script: path.join(import.meta.dir, "fixtures", "autonomous-child.ts") },
      pollMs: 20,
      stallMs: 20_000,
    });
    const lines = readFileSync(path.join(run.runDir, "events.ndjson"), "utf8").trim().split("\n");
    const tty = JSON.parse(lines[0]!) as { stdin: boolean; stdout: boolean; answers: string | null; system: string | null };
    expect(tty.stdin).toBe(false);
    expect(tty.stdout).toBe(false);
    expect(tty.answers).toBe(path.join(run.runDir, "answers.ndjson"));
    expect(tty.system).toBe("review-auto");
  });
});

describe("answers", () => {
  test("the summary counts the automatic answers and keeps the last", async () => {
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          c.answer({ at: "t1", question: "Plan?", answer: "a", basis: "recommended" });
          c.answer({ at: "t2", question: "Merge?", answer: "__cancel__", basis: "refused-irreversible" });
          writePackage("rv-1", "closed");
          return 0;
        }),
      ),
    );
    expect(run.summary.autoAnswers.count).toBe(2);
    expect(run.summary.autoAnswers.last).toEqual({ question: "Merge?", answer: "__cancel__", basis: "refused-irreversible" });
  });
});

describe("arbiter log (flow 425 AC6)", () => {
  const record = (rule: string, verdict = "allow") => ({ at: "t", kind: "budget", verdict, rule, reason: "model", cached: false, ms: 1 });

  test("the child is told where to write its arbiter log, inside the run directory", async () => {
    const seen: ChildSpec[] = [];
    await runAutonomousReview(options(scripted(() => 0, seen)));
    expect(seen[0]!.env["KERYX_ARBITER_LOG"]).toBe(path.join(seen[0]!.runDir, "arbiter.log"));
  });

  test("the log is copied into the package the run ended with, closed or not", async () => {
    for (const status of ["closed", "reviewed"]) {
      rmSync(path.join(cwd, ".metaproject", "reviews"), { recursive: true, force: true });
      mkdirSync(path.join(cwd, ".metaproject", "reviews"), { recursive: true });
      const run = await runAutonomousReview(
        options(
          scripted(async (c) => {
            appendFileSync(path.join(c.spec.runDir, "arbiter.log"), `${JSON.stringify(record("R-04"))}\n`);
            writePackage("rv-1", status);
            return 0;
          }),
          { out: `out-${status}` },
        ),
      );
      const copied = path.join(cwd, ".metaproject", "reviews", "rv-1", "arbiter.log");
      expect(existsSync(copied)).toBe(true);
      expect(readFileSync(copied, "utf8")).toBe(readFileSync(path.join(run.runDir, "arbiter.log"), "utf8"));
    }
  });

  test("a run that asked nothing leaves no arbiter.log in the package", async () => {
    await runAutonomousReview(
      options(
        scripted(async () => {
          writePackage("rv-1", "closed");
          return 0;
        }),
      ),
    );
    expect(existsSync(path.join(cwd, ".metaproject", "reviews", "rv-1", "arbiter.log"))).toBe(false);
  });

  test("a new head starts a new log and keeps the old one beside it", async () => {
    let head = "aaaaaaa1";
    const spawn = scripted(async (c) => {
      appendFileSync(path.join(c.spec.runDir, "arbiter.log"), `${JSON.stringify(record(head === "aaaaaaa1" ? "R-01" : "R-02"))}\n`);
      return 0;
    });
    const first = await runAutonomousReview(options(spawn, { resolveHead: async () => head }));
    head = "bbbbbbb2";
    await runAutonomousReview(options(spawn, { resolveHead: async () => head }));
    const now = readFileSync(path.join(first.runDir, "arbiter.log"), "utf8");
    expect(now).toContain("R-02");
    expect(now).not.toContain("R-01");
    expect(readFileSync(path.join(first.runDir, "arbiter.aaaaaaa1.log"), "utf8")).toContain("R-01");
  });

  test("a resumed run on the same head keeps appending to one log", async () => {
    const spawn = scripted(async (c) => {
      appendFileSync(path.join(c.spec.runDir, "arbiter.log"), `${JSON.stringify(record("R-03"))}\n`);
      return 0;
    });
    const first = await runAutonomousReview(options(spawn));
    await runAutonomousReview(options(spawn));
    expect(readFileSync(path.join(first.runDir, "arbiter.log"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("one run per pull request", () => {
  test("a second start while one is running is refused by name", async () => {
    const first = runAutonomousReview(
      options(
        scripted(async (c) => {
          await c.sleep(250);
          writePackage("rv-1", "closed");
          return 0;
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 60));
    await expect(runAutonomousReview(options(scripted(() => 0)))).rejects.toBeInstanceOf(AutonomousRunLockedError);
    expect((await first).exitCode).toBe(0);
  });

  test("a lock left by a dead process is taken over", async () => {
    const dir = path.join(cwd, ".metaproject", "data", "review-autonomous", "o-r-pr7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "lock.json"), JSON.stringify({ pid: 2_147_483_000, startedAt: "2026-10-11T00:00:00Z" }));
    const run = await runAutonomousReview(options(scripted(() => 0)));
    expect(run.exitCode).toBe(2);
  });

  test("the lock is gone when the run ends", async () => {
    const run = await runAutonomousReview(options(scripted(() => 0)));
    expect(existsSync(path.join(run.runDir, "lock.json"))).toBe(false);
  });

  test("a finished run on the same head is reused without starting a child", async () => {
    await runAutonomousReview(options(scripted(async () => (writePackage("rv-1", "closed"), 0))));
    const seen: ChildSpec[] = [];
    const again = await runAutonomousReview(options(scripted(() => 0, seen)));
    expect(seen).toHaveLength(0);
    expect(again.reused).toBe(true);
    expect(again.exitCode).toBe(0);
  });

  test("a new head starts a new run", async () => {
    await runAutonomousReview(options(scripted(async () => (writePackage("rv-1", "closed"), 0))));
    const seen: ChildSpec[] = [];
    const again = await runAutonomousReview(options(scripted(() => 0, seen), { resolveHead: async () => "def456" }));
    expect(seen).toHaveLength(1);
    expect(again.reused).toBe(false);
    expect(again.summary.attempts).toBe(1);
    expect(again.summary.target.head).toBe("def456");
  });

  test("an unfinished run on the same head resumes its package", async () => {
    await runAutonomousReview(options(scripted(async () => (writePackage("rv-1", "reviewed"), 0))));
    const seen: ChildSpec[] = [];
    const again = await runAutonomousReview(options(scripted(async () => (writePackage("rv-1", "closed"), 0), seen)));
    expect(again.summary.attempts).toBe(2);
    expect(again.reused).toBe(false);
    expect(seen[0]!.argv.join(" ")).toContain("rv-1");
    expect(again.exitCode).toBe(0);
  });

  test("with no resolvable head nothing is reused", async () => {
    const opts = options(scripted(async () => (writePackage("rv-1", "closed"), 0)), { resolveHead: async () => null });
    await runAutonomousReview(opts);
    const seen: ChildSpec[] = [];
    await runAutonomousReview({ ...opts, spawn: scripted(() => 0, seen) });
    expect(seen).toHaveLength(1);
  });
});

describe("progress file", () => {
  test("shows the phase while the run is going and the verdict after", async () => {
    let during: unknown;
    const run = await runAutonomousReview(
      options(
        scripted(async (c) => {
          c.emit(call("keryx review start --target pr"));
          await c.sleep(60);
          during = JSON.parse(readFileSync(path.join(c.spec.runDir, "progress.json"), "utf8"));
          writePackage("rv-1", "closed");
          return 0;
        }),
      ),
    );
    expect(during).toMatchObject({ state: "running", phase: "review start" });
    expect(JSON.parse(readFileSync(path.join(run.runDir, "progress.json"), "utf8"))).toMatchObject({ state: "complete", exitCode: 0 });
  });
});

describe("the pull request head reaches the child", () => {
  test("the prompt carries the resolved head and the --head instruction", async () => {
    const seen: ChildSpec[] = [];
    await runAutonomousReview(options(scripted(() => 1, seen)));
    const prompt = seen[0]!.argv[seen[0]!.argv.length - 1]!;
    expect(prompt).toContain("The pull request head is abc123");
    expect(prompt).toContain("--head abc123");
  });

  test("a head that could not be read leaves --head out of the prompt", async () => {
    const seen: ChildSpec[] = [];
    await runAutonomousReview(options(scripted(() => 1, seen), { resolveHead: async () => null }));
    expect(seen[0]!.argv[seen[0]!.argv.length - 1]!).not.toContain("--head");
  });
});
