// Flow 389, AC7: the limits of a digest run, and the multi-account rule.
//
//   - a dollar limit, a memory limit and a timeout; a run over a limit is stopped and reported;
//   - gh runs with the account the PATH chooses (~/work/** work, anything else personal), and no
//     `gh auth switch` or `gh auth login` is ever called.
//
// Every limit is tripped through its seam (`armTimeout`, `rssMb`, `armWatch`, a scripted provider),
// so nothing here waits for a real timer, allocates real memory or spends real money.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort, StreamOptions } from "../harness/provider/types";
import { readTriggerRuns, type TriggerRunRecord } from "../trigger/record";
import {
  addDigestSchedule,
  FakeGh,
  FakeSink,
  fakeSummary,
  issueJson,
  prJson,
  runDigest,
  setupDigestEnv,
  TestClock,
  type DigestTestEnv,
} from "./digest.test-helpers";
import { ghAccountForPath, ghEnvForProject } from "./digest-gh";
import { startLimits } from "./digest-limits";
import { readSnapshot } from "./digest-snapshot";

let env: DigestTestEnv;
let clock: TestClock;
let sink: FakeSink;
let name = "";

beforeEach(async () => {
  env = await setupDigestEnv();
  clock = new TestClock("2026-10-02T12:00:00Z");
  sink = new FakeSink();
});

afterEach(async () => {
  await env.teardown();
});

const PR12 = { number: 12, title: "Add the retry button", updatedAt: "2026-10-01T09:00:00Z" };

function gh(): FakeGh {
  return new FakeGh().set("pr", prJson([PR12])).set("issue", issueJson([])).set("review", "[]").set("ci", "[]");
}

async function lastRecord(): Promise<TriggerRunRecord> {
  const read = await readTriggerRuns(env.root);
  if (read.state !== "present") throw new Error("no run record");
  return read.records.filter((r) => r.outcome !== "reserved").at(-1)!;
}

async function reportText(): Promise<string> {
  const reportPath = (await lastRecord()).agentTask?.reportPath;
  if (reportPath === undefined) throw new Error("the run wrote no report");
  return readFile(path.join(env.root, reportPath), "utf8");
}

/** A timer seam the test fires by hand. */
function manualTimeout(): { armTimeout: (ms: number, fire: () => void) => () => void; armed: () => number | undefined; fire: () => void; disarmed: () => number } {
  let fire: (() => void) | undefined;
  let ms: number | undefined;
  let disarmed = 0;
  return {
    armTimeout: (afterMs, f) => {
      ms = afterMs;
      fire = f;
      return () => {
        disarmed += 1;
      };
    },
    armed: () => ms,
    fire: () => fire?.(),
    disarmed: () => disarmed,
  };
}

// ---- the three limits ---------------------------------------------------------

describe("AC7: the time limit", () => {
  test("the run arms a timer of maxSeconds, and disarms it when the run is done", async () => {
    name = await addDigestSchedule(env, { maxSeconds: 45 });
    const timer = manualTimeout();
    await runDigest(env, name, { runGh: gh().run, summarize: fakeSummary().summarize, now: clock.now, sink, limits: { armTimeout: timer.armTimeout } });
    expect(timer.armed()).toBe(45_000);
    expect(timer.disarmed()).toBe(1);
    expect((await lastRecord()).outcome).toBe("ok");
  });

  test("a run that is still reading when the timer fires is stopped, reported as failed with the reason, and says so in the topic", async () => {
    name = await addDigestSchedule(env, { maxSeconds: 30 });
    const timer = manualTimeout();
    const fake = gh();
    fake.onCall = () => {
      if (fake.calls.length === 2) timer.fire();
    };
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, limits: { armTimeout: timer.armTimeout } });

    // it stopped between calls: two of the four were made, none after the timer fired
    expect(fake.calls).toHaveLength(2);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("timed out after 30s");
    expect(await reportText()).toContain("- outcome: failed (timed out after 30s)");
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.text.split("\n")[0]).toBe("Digest morning stopped — timed out after 30s");
    expect(sink.sent[0]?.text).toContain(`Report: ${record.agentTask?.reportPath}`);
    expect(timer.disarmed()).toBe(1);
  });

  test("a run that was stopped keeps no half-read snapshot: the next run is still the baseline", async () => {
    name = await addDigestSchedule(env);
    const timer = manualTimeout();
    const fake = gh();
    fake.onCall = () => timer.fire();
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, limits: { armTimeout: timer.armTimeout } });
    expect(await readSnapshot(env.root, name)).toBeUndefined();
  });

  test("the limit trips once: the first reason stays, whatever trips after it", () => {
    const timer = manualTimeout();
    const limits = startLimits({ maxSeconds: 5, memoryLimitMb: 100 }, { armTimeout: timer.armTimeout, rssMb: () => 500, armWatch: () => () => {} });
    timer.fire();
    expect(limits.tripped()).toBe("timeout");
    expect(limits.signal.aborted).toBe(true);
    expect(limits.checkpoint()).toBe(true);
    limits.spendStopped();
    expect(limits.tripped()).toBe("timeout");
    expect(limits.reason()).toBe("timed out after 5s");
    limits.dispose();
    limits.dispose();
    expect(timer.disarmed()).toBe(1);
  });
});

describe("AC7: the memory limit", () => {
  test("a run whose memory grew over its limit at a checkpoint is stopped and reported with the growth", async () => {
    name = await addDigestSchedule(env, { memoryLimitMb: 256 });
    // serve is already 800 MiB when the run starts; the first gh call takes it to 1100 MiB: +300
    let rss = 800;
    const fake = gh();
    fake.onCall = () => {
      rss = 1100;
    };
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, limits: { rssMb: () => rss, armWatch: () => () => {} } });

    expect(fake.calls).toHaveLength(1);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("memory limit exceeded (the run grew by 300 MiB, limit 256 MiB)");
    expect(await reportText()).toContain("memory limit exceeded (the run grew by 300 MiB, limit 256 MiB)");
    expect(sink.sent[0]?.text.split("\n")[0]).toBe("Digest morning stopped — memory limit exceeded (the run grew by 300 MiB, limit 256 MiB)");
  });

  test("a host process that is already larger than the limit does not trip the run: only growth counts", async () => {
    name = await addDigestSchedule(env, { memoryLimitMb: 256 });
    const fake = gh();
    // 4 GiB resident, flat for the whole run
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, limits: { rssMb: () => 4096, armWatch: () => () => {} } });
    expect(fake.calls).toHaveLength(4);
    expect((await lastRecord()).outcome).toBe("ok");
  });

  test("the baseline is read once, when the limits start, and the limit is relative to it", () => {
    let rss = 5000;
    const limits = startLimits({ maxSeconds: 60, memoryLimitMb: 100 }, { armTimeout: () => () => {}, rssMb: () => rss, armWatch: () => () => {} });
    rss = 5090;
    expect(limits.checkpoint()).toBe(false);
    rss = 5101;
    expect(limits.checkpoint()).toBe(true);
    expect(limits.tripped()).toBe("memory");
    expect(limits.reason()).toBe("memory limit exceeded (the run grew by 101 MiB, limit 100 MiB)");
    limits.dispose();
  });

  test("memory is also watched while a call is in flight: the watch fires, the run stops at the next step", async () => {
    name = await addDigestSchedule(env, { memoryLimitMb: 256 });
    let rss = 100;
    let watch: (() => void) | undefined;
    let watchEvery = 0;
    let watchStopped = 0;
    const fake = gh();
    fake.onCall = () => {
      if (fake.calls.length === 1) {
        rss = 700; // the process grows during the first call
        watch?.();
      }
    };
    await runDigest(env, name, {
      runGh: fake.run,
      summarize: fakeSummary().summarize,
      now: clock.now,
      sink,
      limits: {
        rssMb: () => rss,
        armWatch: (fire, everyMs) => {
          watch = fire;
          watchEvery = everyMs;
          return () => {
            watchStopped += 1;
          };
        },
      },
    });
    expect(watchEvery).toBe(1000);
    expect(watchStopped).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect((await lastRecord()).detail).toContain("memory limit exceeded (the run grew by 600 MiB, limit 256 MiB)");
  });

  test("a run within its limit is not stopped, and checks the number at every step without tripping", async () => {
    name = await addDigestSchedule(env, { memoryLimitMb: 256 });
    let reads = 0;
    const fake = gh();
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, limits: { rssMb: () => (reads += 1, 255), armWatch: () => () => {} } });
    expect(fake.calls).toHaveLength(4);
    expect(reads).toBeGreaterThanOrEqual(4);
    expect((await lastRecord()).outcome).toBe("ok");
  });

  test("the limit comes from the schedule's own memory limit, not a fixed number", async () => {
    name = await addDigestSchedule(env, { memoryLimitMb: 1000 });
    // 100 MiB at the start, 1000 MiB after the first call: +900, under 1000
    let rss = 100;
    const fake = gh();
    fake.onCall = () => {
      rss = 1000;
    };
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, limits: { rssMb: () => rss, armWatch: () => () => {} } });
    expect((await lastRecord()).outcome).toBe("ok");
  });
});

describe("AC7: the dollar limit", () => {
  const DESCRIPTION: ProviderDescription = {
    capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false },
    descriptor: { providerId: "scripted" },
  };

  function scripted(events: Partial<NormalizedEvent>[]): ProviderPort & { calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      describe: () => DESCRIPTION,
      stream: (_request: NormalizedRequest, opts: StreamOptions) => {
        calls += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        })();
      },
    };
  }

  /** A baseline run, then one with a changed PR, so the second one asks the model for a summary. */
  async function secondRunWithModel(provider: ProviderPort, ceilingUsd: number): Promise<void> {
    name = await addDigestSchedule(env, { ceilingUsd });
    await runDigest(env, name, { runGh: gh().run, now: clock.now, sink, makeProvider: () => provider });
    clock.advance(10 * 60_000);
    const changed = new FakeGh().set("pr", prJson([{ ...PR12, updatedAt: "2026-10-02T11:00:00Z" }])).set("issue", "[]").set("review", "[]").set("ci", "[]");
    await runDigest(env, name, { runGh: changed.run, now: clock.now, sink, makeProvider: () => provider });
  }

  test("a summary that costs more than the ceiling is stopped, the run is failed, and the topic gets the status line", async () => {
    // 1,000,000 input tokens at $3 per million is $3, against a ceiling of $0.20
    const provider = scripted([{ kind: "text_delta", text: "partial" }, { kind: "usage_update", usage: { inputTokens: 1_000_000, outputTokens: 0 } }]);
    await secondRunWithModel(provider, 0.2);

    expect(provider.calls()).toBe(1);
    const record = await lastRecord();
    expect(record.outcome).toBe("failed");
    expect(record.detail).toContain("spend cap reached");
    expect(await reportText()).toContain("spend cap reached");
    const last = sink.sent.at(-1)?.text ?? "";
    expect(last.split("\n")[0]).toMatch(/^Digest morning stopped — spend cap reached/);
    expect(last).not.toContain("partial");
    expect(record.cost.recorded).toBe(true);
  });

  test("a summary within the ceiling is used, priced from its tokens, and above the plain text", async () => {
    const provider = scripted([{ kind: "text_delta", text: "One PR moved." }, { kind: "usage_update", usage: { inputTokens: 1000, outputTokens: 100 } }]);
    await secondRunWithModel(provider, 0.2);

    const record = await lastRecord();
    expect(record.outcome).toBe("ok");
    expect(record.cost).toMatchObject({ recorded: true });
    expect(record.cost.recorded && record.cost.usd).toBeCloseTo((1000 * 3 + 100 * 15) / 1_000_000, 6);
    expect(sink.sent.at(-1)?.text.startsWith("Summary (written by the model)\nOne PR moved.")).toBe(true);
  });

  test("a model that reports no usage is charged the whole reservation and its summary is never used", async () => {
    const provider = scripted([{ kind: "text_delta", text: "free lunch" }, { kind: "model_end" }]);
    await secondRunWithModel(provider, 0.2);
    const record = await lastRecord();
    // an unmetered model is treated as spending everything it was allowed: the run is stopped like an overspend
    expect(record.outcome).toBe("failed");
    expect(record.detail).toMatch(/spend cap reached|sent no token usage/);
    expect(record.cost.recorded && record.cost.usd).toBeGreaterThan(0);
    expect(sink.sent.at(-1)?.text ?? "").not.toContain("free lunch");
  });

  test("a baseline or a quiet run makes no model call at all, so it costs nothing", async () => {
    const provider = scripted([{ kind: "usage_update", usage: { inputTokens: 1, outputTokens: 1 } }]);
    name = await addDigestSchedule(env);
    await runDigest(env, name, { runGh: gh().run, now: clock.now, sink, makeProvider: () => provider });
    clock.advance(10 * 60_000);
    await runDigest(env, name, { runGh: gh().run, now: clock.now, sink, makeProvider: () => provider });
    expect(provider.calls()).toBe(0);
    expect((await lastRecord()).cost).toMatchObject({ recorded: true, usd: 0 });
  });

  test("the gh calls cost nothing: the digest's money is only ever the summary", async () => {
    name = await addDigestSchedule(env);
    await runDigest(env, name, { runGh: gh().run, summarize: fakeSummary().summarize, now: clock.now, sink });
    expect((await lastRecord()).cost).toMatchObject({ recorded: true, usd: 0 });
  });
});

// ---- the multi-account rule ---------------------------------------------------

describe("AC7: gh runs with the account the path chooses", () => {
  let counter = 0;
  async function accountOfRun(options: { workRoot?: string; preset?: string }): Promise<string | undefined> {
    counter += 1;
    name = await addDigestSchedule(env, { name: `acct-${counter}` });
    const fake = gh();
    const grantedEnv: Record<string, string | undefined> = { ...process.env };
    if (options.workRoot !== undefined) grantedEnv["GH_WORK_ROOT"] = options.workRoot;
    else delete grantedEnv["GH_WORK_ROOT"];
    if (options.preset !== undefined) grantedEnv["GH_ACCOUNT"] = options.preset;
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, grantedEnv });
    const accounts = new Set(fake.calls.map((c) => c.env["GH_ACCOUNT"]));
    expect(accounts.size).toBe(1);
    return [...accounts][0];
  }

  test("a project under the work root runs every gh call as the work account", async () => {
    expect(await accountOfRun({ workRoot: path.dirname(env.root) })).toBe("work");
  });

  test("a project anywhere else runs every gh call as the personal account", async () => {
    expect(await accountOfRun({ workRoot: path.join(env.aside, "work") })).toBe("personal");
  });

  test("with no work root named, the default ~/work decides, and a temp directory is not in it", async () => {
    expect(await accountOfRun({})).toBe("personal");
  });

  test("an account already set in the environment does not override the path: the path wins", async () => {
    expect(await accountOfRun({ workRoot: path.dirname(env.root), preset: "personal" })).toBe("work");
    expect(await accountOfRun({ workRoot: path.join(env.aside, "work"), preset: "work" })).toBe("personal");
  });

  test("the operator's own environment is passed on to gh, so its own login and config are used", async () => {
    const env2 = ghEnvForProject(env.root, { HOME: "/home/someone", GH_CONFIG_DIR: "/home/someone/.config/gh-work", PATH: "/usr/bin" });
    expect(env2["HOME"]).toBe("/home/someone");
    expect(env2["GH_CONFIG_DIR"]).toBe("/home/someone/.config/gh-work");
    expect(env2["GH_ACCOUNT"]).toBe("personal");
  });

  test("S-2: only an allowlist of the operator's environment reaches gh, never a token or an unrelated secret", () => {
    const env2 = ghEnvForProject(env.root, {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      GH_CONFIG_DIR: "/home/someone/.config/gh-work",
      GH_WORK_ROOT: "/home/someone/work",
      LC_ALL: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/someone/.config",
      HTTPS_PROXY: "http://proxy.local:3128",
      GH_TOKEN: "ghp_AbCdEf0123456789AbCdEf0123456789AbCd",
      GITHUB_TOKEN: "ghp_ZyXwVu0123456789ZyXwVu0123456789ZyXw",
      GH_ENTERPRISE_TOKEN: "enterprise-token",
      ANTHROPIC_API_KEY: "sk-ant-not-for-gh",
      FOO_SECRET: "hunter2",
      TELEGRAM_BOT_TOKEN: "123:abc",
    });
    expect(Object.keys(env2).sort()).toEqual(
      ["GH_ACCOUNT", "GH_CONFIG_DIR", "GH_WORK_ROOT", "HOME", "HTTPS_PROXY", "LC_ALL", "PATH", "XDG_CONFIG_HOME"].sort(),
    );
    expect(env2["GH_ACCOUNT"]).toBe("personal");
  });

  test("S-2: the env of a real run's gh calls carries no token from serve's environment, only the account", async () => {
    counter += 1;
    name = await addDigestSchedule(env, { name: `acct-${counter}` });
    const fake = gh();
    const grantedEnv = { PATH: process.env["PATH"], GH_TOKEN: "ghp_AbCdEf0123456789AbCdEf0123456789AbCd", GITHUB_TOKEN: "x", FOO_SECRET: "y", GH_ACCOUNT: "work" };
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, grantedEnv });
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(call.env["GH_TOKEN"]).toBeUndefined();
      expect(call.env["GITHUB_TOKEN"]).toBeUndefined();
      expect(call.env["FOO_SECRET"]).toBeUndefined();
      expect(call.env["GH_ACCOUNT"]).toBe("personal");
      expect(call.env["PATH"]).toBe(process.env["PATH"]);
    }
  });

  test("ghAccountForPath: under ~/work is work; a sibling that only shares the prefix, the home itself and ~/worker are not", async () => {
    const home = path.join(env.aside, "home");
    const work = path.join(home, "work");
    await mkdir(path.join(work, "org", "repo"), { recursive: true });
    await mkdir(path.join(home, "worker", "repo"), { recursive: true });
    await mkdir(path.join(home, "keryx"), { recursive: true });
    expect(ghAccountForPath(path.join(work, "org", "repo"), { home })).toBe("work");
    expect(ghAccountForPath(work, { home })).toBe("work");
    expect(ghAccountForPath(path.join(home, "worker", "repo"), { home })).toBe("personal");
    expect(ghAccountForPath(path.join(home, "keryx"), { home })).toBe("personal");
    expect(ghAccountForPath(home, { home })).toBe("personal");
  });

  test("ghAccountForPath follows symbolic links, so a link into ~/work is work and a link out of it is personal", async () => {
    const home = path.join(env.aside, "home2");
    const work = path.join(home, "work");
    await mkdir(path.join(work, "app"), { recursive: true });
    await mkdir(path.join(home, "play", "app"), { recursive: true });
    await symlink(path.join(work, "app"), path.join(home, "play", "link-to-work"));
    await symlink(path.join(home, "play", "app"), path.join(work, "link-to-play"));
    expect(ghAccountForPath(path.join(home, "play", "link-to-work"), { home })).toBe("work");
    expect(ghAccountForPath(path.join(work, "link-to-play"), { home })).toBe("personal");
  });

  test("a work root that does not exist on this machine makes every project personal", () => {
    expect(ghAccountForPath(env.root, { workRoot: path.join(env.aside, "nowhere") })).toBe("personal");
  });
});

describe("AC7: gh auth switch and gh auth login are never called", () => {
  test("across a whole run, no gh call carries an auth, login, switch, token or api word", async () => {
    name = await addDigestSchedule(env, { repos: ["MrCipherSmith/keryx", "MrCipherSmith/other"] });
    const fake = gh().empty("MrCipherSmith/other");
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink, grantedEnv: { ...process.env, GH_WORK_ROOT: path.dirname(env.root) } });
    expect(fake.calls).toHaveLength(8);
    for (const call of fake.calls) {
      for (const word of ["auth", "login", "switch", "token", "api", "logout", "refresh"]) expect(call.argv).not.toContain(word);
      // the only verbs are the read-only ones the catalogue fixes
      expect(["list"]).toContain(call.argv[1]!);
    }
  });

  test("the account is chosen in the environment of the call, not by a command: work and personal runs differ only in GH_ACCOUNT", async () => {
    name = await addDigestSchedule(env);
    const work = gh();
    await runDigest(env, name, { runGh: work.run, summarize: fakeSummary().summarize, now: clock.now, sink, grantedEnv: { ...process.env, GH_WORK_ROOT: path.dirname(env.root) } });
    clock.advance(10 * 60_000);
    const personal = gh();
    await runDigest(env, name, { runGh: personal.run, summarize: fakeSummary().summarize, now: clock.now, sink, grantedEnv: { ...process.env, GH_WORK_ROOT: path.join(env.aside, "work") } });
    expect(work.calls.map((c) => c.argv)).toEqual(personal.calls.map((c) => c.argv));
    expect(work.calls[0]?.env["GH_ACCOUNT"]).toBe("work");
    expect(personal.calls[0]?.env["GH_ACCOUNT"]).toBe("personal");
  });

  test("no digest module builds a command line with auth in it: the account code and the run say it only in comments", async () => {
    const dir = path.join(import.meta.dir);
    const files = (await readdir(dir)).filter((f) => /^digest-.*\.ts$/.test(f) && !f.endsWith(".test.ts") && !f.includes("test-helpers"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = await readFile(path.join(dir, file), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n");
      expect({ file, hit: /["'`]auth["'`]/.test(code) || /\bauth\s+(switch|login)\b/.test(code) }).toEqual({ file, hit: false });
    }
  });

  test("gh runs from an empty directory of its own, never from the project", async () => {
    name = await addDigestSchedule(env);
    const fake = gh();
    await runDigest(env, name, { runGh: fake.run, summarize: fakeSummary().summarize, now: clock.now, sink });
    for (const call of fake.calls) {
      expect(call.cwd).not.toBe(env.root);
      expect(call.cwd.startsWith(env.root)).toBe(false);
      expect(path.basename(call.cwd)).toBe("granted-cwd");
    }
  });
});
