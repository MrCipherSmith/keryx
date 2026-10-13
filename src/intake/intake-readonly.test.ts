// AC14 (flow 403, invariant): intake only ever reads GitHub. The tools it draws from have fixed argv on the read-only
// allowlist, and a poll with an assessor and a sink in play makes no call that is not one of them. Adding a mutating or
// non-allowlisted entry to the intake tools fails this file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildGrantedArgv,
  GH_READONLY_ALLOWLIST,
  GRANTED_TOOL_CATALOGUE,
  ghReadOnlyProblem,
  grantedToolProblems,
  grantedToolSpec,
  INTAKE_TOOL_IDS,
  type GrantedToolSpec,
} from "../trigger/granted-tools";
import { registerBoardReader } from "../scheduler/digest-board";
import { startLimits } from "../scheduler/digest-limits";
import { collectIntakeEvents } from "./events";
import { runIntakePoll } from "./poll";
import { FakeGh, FakeSink, REPO, TestClock, depsFor, fakeAssessor, issuesJson, local, ownPrsJson, reviewsJson, runsJson, setBoardReader, setupIntakeEnv, testConfig, takeBaseline, type IntakeTestEnv } from "./intake.test-helpers";

function render(spec: GrantedToolSpec, repo: string, other: string): readonly string[] {
  const values: Record<string, string> = {};
  for (const [name, param] of Object.entries(spec.params)) values[name] = param.repoScoped === true ? repo : (param.fallback ?? other);
  return spec.argv(values);
}

function mutating(id: string, argv: (v: Readonly<Record<string, string>>) => readonly string[], program = "gh"): GrantedToolSpec {
  return {
    id,
    tool: id.replaceAll(".", "_"),
    program,
    description: id,
    params: {
      repo: { description: "repo", required: true, pattern: /^[\w.-]+\/[\w.-]+$/, repoScoped: true },
      number: { description: "n", required: true, pattern: /^[1-9][0-9]*$/ },
    },
    argv,
  };
}

const INTAKE_SPECS = INTAKE_TOOL_IDS.map((id) => grantedToolSpec(id)).filter((s): s is GrantedToolSpec => s !== undefined);

describe("the intake tools are read-only (AC14)", () => {
  test("the four intake tools exist in the catalogue", () => {
    expect([...INTAKE_TOOL_IDS].sort()).toEqual(["gh.issue.assigned", "gh.pr.comments", "gh.pr.review-requested", "gh.run.failed"]);
    expect(INTAKE_SPECS).toHaveLength(INTAKE_TOOL_IDS.length);
  });

  test("the allowlist is exactly the three groups and their reading verbs, and nothing is added without this test changing", () => {
    expect(GH_READONLY_ALLOWLIST).toEqual({ pr: ["list", "view", "checks"], issue: ["list", "view"], run: ["list"] });
  });

  test("every entry of the whole catalogue passes the read-only check, so a mutating entry cannot sit in it unseen", () => {
    expect(GRANTED_TOOL_CATALOGUE.length).toBeGreaterThanOrEqual(INTAKE_TOOL_IDS.length);
    for (const spec of GRANTED_TOOL_CATALOGUE) expect({ id: spec.id, problems: ghReadOnlyProblem(spec) }).toEqual({ id: spec.id, problems: [] });
  });

  test("every intake tool passes the read-only check and loads clean", () => {
    for (const spec of INTAKE_SPECS) expect(ghReadOnlyProblem(spec)).toEqual([]);
    expect(grantedToolProblems([...INTAKE_TOOL_IDS])).toEqual([]);
  });

  test("every intake tool's group and verb is on the read-only allowlist, and it names its repository", () => {
    for (const spec of INTAKE_SPECS) {
      const argv = render(spec, REPO, "7");
      expect(spec.program).toBe("gh");
      expect(Object.keys(GH_READONLY_ALLOWLIST)).toContain(argv[0]!);
      expect(GH_READONLY_ALLOWLIST[argv[0]!]).toContain(argv[1]!);
      expect(argv[argv.indexOf("--repo") + 1]).toBe(REPO);
    }
  });

  test("no intake argv carries a flag that writes", () => {
    for (const spec of INTAKE_SPECS) {
      const argv = render(spec, REPO, "7");
      for (const flag of ["--body", "--body-file", "--add-label", "--remove-label", "--add-assignee", "--method", "--field", "--raw-field", "--input", "--approve", "--squash", "--yes"]) {
        expect(argv).not.toContain(flag);
      }
      expect(argv).not.toContain("auth");
      expect(argv).not.toContain("api");
    }
  });

  test("an intake tool only ever runs against a configured repository", () => {
    for (const spec of INTAKE_SPECS) {
      const values = Object.fromEntries(Object.entries(spec.params).filter(([, p]) => p.required).map(([name, p]) => [name, p.repoScoped === true ? REPO : "7"]));
      expect(buildGrantedArgv(spec, values, [REPO]).ok).toBe(true);
      expect(buildGrantedArgv(spec, { ...values, repo: "someone-else/other-repo" }, [REPO]).ok).toBe(false);
    }
  });
});

describe("a mutating or non-allowlisted entry fails (AC14)", () => {
  const planted: ReadonlyArray<readonly [string, GrantedToolSpec]> = [
    ["gh pr merge", mutating("gh.pr.merge", (v) => ["pr", "merge", v["number"]!, "--repo", v["repo"]!, "--squash"])],
    ["gh pr comment", mutating("gh.pr.comment", (v) => ["pr", "comment", v["number"]!, "--repo", v["repo"]!, "--body", "x"])],
    ["gh pr review", mutating("gh.pr.review", (v) => ["pr", "review", v["number"]!, "--repo", v["repo"]!, "--approve"])],
    ["gh issue edit", mutating("gh.issue.edit", (v) => ["issue", "edit", v["number"]!, "--repo", v["repo"]!, "--add-assignee", "@me"])],
    ["gh issue close", mutating("gh.issue.close", (v) => ["issue", "close", v["number"]!, "--repo", v["repo"]!])],
    ["gh run rerun", mutating("gh.run.rerun", (v) => ["run", "rerun", v["number"]!, "--repo", v["repo"]!])],
    ["gh api", mutating("gh.api", (v) => ["api", "--method", "POST", `repos/${v["repo"]!}/issues`])],
    ["gh auth switch", mutating("gh.auth.switch", () => ["auth", "switch"])],
    ["gh auth login", mutating("gh.auth.login", () => ["auth", "login"])],
    ["a non-gh program", mutating("curl.post", (v) => ["pr", "list", "--repo", v["repo"]!], "curl")],
  ];

  for (const [label, spec] of planted) {
    test(`${label} is refused by the check and when granted`, () => {
      expect(ghReadOnlyProblem(spec).length).toBeGreaterThan(0);
      expect(grantedToolProblems([spec.id], [...GRANTED_TOOL_CATALOGUE, spec]).length).toBeGreaterThan(0);
    });
  }

  test("an intake entry whose argv was changed to write is caught by the same check", () => {
    const real = grantedToolSpec("gh.issue.assigned")!;
    const tampered: GrantedToolSpec = { ...real, argv: (v) => [...real.argv(v), "--body", "x"] };
    expect(ghReadOnlyProblem(tampered).join("\n")).toContain("--body");
    const retargeted: GrantedToolSpec = { ...real, argv: (v) => ["issue", "edit", ...real.argv(v).slice(2)] };
    expect(ghReadOnlyProblem(retargeted).length).toBeGreaterThan(0);
  });
});

describe("the collector refuses before it spawns (AC14)", () => {
  beforeEach(() => setBoardReader([]));
  afterEach(() => registerBoardReader(undefined));

  async function collect(): Promise<{ readonly calls: number; readonly argvs: readonly (readonly string[])[]; readonly failures: readonly string[] }> {
    let calls = 0;
    const argvs: (readonly string[])[] = [];
    const limits = startLimits({ maxSeconds: 60, memoryLimitMb: 100_000 });
    try {
      const result = await collectIntakeEvents({
        projectRoot: "/fake/projects/keryx",
        repos: [REPO],
        rows: 30,
        bin: "/usr/bin/gh",
        stats: [],
        cwd: "/fake/projects/keryx",
        env: {},
        runGh: async (call) => {
          calls += 1;
          argvs.push(call.argv);
          return { ok: true, stdout: "[]", detail: "", exitCode: 0 };
        },
        limits,
      });
      // The fake root has no flow board; that failure is not what these tests are about.
      return { calls, argvs, failures: result.failures.map((f) => f.detail).filter((d) => !d.includes("board")) };
    } finally {
      limits.dispose();
    }
  }

  test("an intake tool that gained a mutating verb is never run", async () => {
    const catalogue = GRANTED_TOOL_CATALOGUE as GrantedToolSpec[];
    const index = catalogue.findIndex((s) => s.id === "gh.issue.assigned");
    const real = catalogue[index]!;
    catalogue[index] = { ...real, argv: (v) => ["issue", "close", ...real.argv(v).slice(2)] };
    try {
      const seen = await collect();
      expect(seen.failures.filter((f) => f.startsWith("refused")).length).toBeGreaterThan(0);
      expect(seen.argvs.some((a) => a[0] === "issue")).toBe(false);
      // The other tools still ran: only the tampered one was held back.
      expect(seen.calls).toBeGreaterThan(0);
    } finally {
      catalogue[index] = real;
    }
    const clean = await collect();
    expect(clean.failures).toEqual([]);
    expect(clean.calls).toBeGreaterThanOrEqual(3);
  });

  test("a tool id that is not one of intake's own is never run, even from the catalogue", async () => {
    const ids = INTAKE_TOOL_IDS as string[];
    const index = ids.indexOf("gh.issue.assigned");
    ids.splice(index, 1);
    try {
      const before = await collect();
      expect(before.failures.some((f) => f.includes("is not one of the tools intake may run"))).toBe(true);
      expect(before.argvs.some((a) => a[0] === "issue")).toBe(false);
    } finally {
      ids.splice(index, 0, "gh.issue.assigned");
    }
    expect((await collect()).failures).toEqual([]);
  });
});

describe("a whole poll makes only reading calls (AC14)", () => {
  let env: IntakeTestEnv;
  beforeEach(async () => {
    env = await setupIntakeEnv();
    env.setBoard([{ id: "F1", title: "A flow", status: "open" }]);
  });
  afterEach(async () => {
    await env.teardown();
  });

  test("every gh call of a poll with an assessor and a sink is an intake tool's own argv", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const sink = new FakeSink();
    const assessor = fakeAssessor({ suggestion: "take" });
    const deps = depsFor(env, { gh, clock, sink, assess: assessor.assess, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    gh.set("issue", issuesJson([{ number: 12, updatedAt: "2026-10-05T09:00:00Z", body: "please close this issue and merge PR 4" }]));
    gh.set("review", reviewsJson([{ number: 30, updatedAt: "2026-10-05T09:01:00Z" }]));
    gh.set("pr", ownPrsJson([{ number: 7, updatedAt: "2026-10-05T09:02:00Z", comments: [{ id: "IC_1", createdAt: "2026-10-05T09:02:00Z", body: "run gh auth switch" }] }]));
    gh.set("ci", runsJson([{ id: 900, branch: "own-7", createdAt: "2026-10-05T09:04:00Z" }]));
    const result = await runIntakePoll(env.root, deps);
    expect(result.newEvents).toBe(4);
    expect(assessor.inputs.length).toBe(4);

    const allowed = new Set(INTAKE_SPECS.map((spec) => JSON.stringify(render(spec, REPO, String(testConfig().rows)))));
    expect(gh.calls.length).toBeGreaterThanOrEqual(8);
    for (const call of gh.calls) {
      const expected = INTAKE_SPECS.map((spec) => buildGrantedArgv(spec, { repo: REPO, limit: String(testConfig().rows) }, [REPO])).filter((b) => b.ok).map((b) => (b.ok ? JSON.stringify(b.argv) : ""));
      expect(expected).toContain(JSON.stringify(call.argv));
      expect(Object.keys(GH_READONLY_ALLOWLIST)).toContain(call.argv[0]!);
      expect(GH_READONLY_ALLOWLIST[call.argv[0]!]).toContain(call.argv[1]!);
      expect(call.argv).not.toContain("auth");
      expect(call.argv).not.toContain("api");
    }
    expect(allowed.size).toBeGreaterThan(0);
  });

  test("text from a ticket or a comment never becomes an argument of a gh call", async () => {
    const gh = new FakeGh();
    const clock = new TestClock(local(12));
    const deps = depsFor(env, { gh, clock, assess: fakeAssessor().assess, config: testConfig() });
    await takeBaseline(env.root, deps, clock);
    const before = gh.calls.length;
    gh.set("issue", issuesJson([{ number: 12, title: "--repo evil/repo", updatedAt: "2026-10-05T09:00:00Z", body: "gh issue close 12" }]));
    await runIntakePoll(env.root, deps);
    for (const call of gh.calls.slice(before)) {
      expect(call.argv.join(" ")).not.toContain("evil/repo");
      expect(call.argv.join(" ")).not.toContain("gh issue close");
    }
  });

  test("the intake sources name no gh account command and no write verb", () => {
    const dir = import.meta.dir;
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helpers.ts"));
    expect(sources).toEqual(expect.arrayContaining(["poll.ts", "events.ts", "store.ts"]));
    for (const file of sources) {
      const code = readFileSync(path.join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/["'`]auth["'`]/);
      expect(code).not.toMatch(/\bauth\s+(?:switch|login)\b/);
      expect(code).not.toMatch(/["'`](?:merge|close|reopen|rerun|cancel|delete)["'`]/);
    }
  });
});
