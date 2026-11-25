import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { printReviewHelpFor, reviewCommand } from "./review";
import { parseFindings, parsePlan, parseReviewer, parseUsage, runReviewState, STATE_USAGE } from "./review-state";

const sha = (c: string) => c.repeat(40);
const URL = "https://github.com/org/repo/pull/12";
const ID = "org-repo-12-alice";
let root: string;
let out: string[];
let err: string[];
const real = { log: console.log, error: console.error, write: process.stdout.write.bind(process.stdout), exitCode: process.exitCode, env: process.env.KERYX_REVIEW_SESSION_ID };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-review-state-cli-"));
  mkdirSync(path.join(root, ".metaproject"));
  out = [];
  err = [];
  console.log = (...parts: unknown[]) => { out.push(`${parts.join(" ")}\n`); };
  console.error = (...parts: unknown[]) => { err.push(parts.join(" ")); };
  process.stdout.write = ((chunk: string | Uint8Array, cb?: (error?: Error | null) => void) => {
    out.push(String(chunk));
    cb?.();
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
  delete process.env.KERYX_REVIEW_SESSION_ID;
});
afterEach(() => {
  console.log = real.log;
  console.error = real.error;
  process.stdout.write = real.write;
  process.exitCode = real.exitCode;
  if (real.env === undefined) delete process.env.KERYX_REVIEW_SESSION_ID;
  else process.env.KERYX_REVIEW_SESSION_ID = real.env;
  rmSync(root, { recursive: true, force: true });
});

/** Run `keryx review state …` through the review group and return stdout, stderr and the exit code. */
async function state(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  out = [];
  err = [];
  process.exitCode = 0;
  await reviewCommand(["state", ...args, "--cwd", root]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout: out.join(""), stderr: err.join("\n"), code };
}
async function stateJson(...args: string[]) {
  const result = await state(...args, "--json");
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}
const openArgs = (head = sha("b"), ...rest: string[]) => ["open", "--pr", URL, "--base", sha("a"), "--head", head, "--viewer", "alice", "--settings", "k1", ...rest];

describe("verbs and --json shape (AC4)", () => {
  test("open creates, reuses for another session and advances on a new head", async () => {
    const first = await stateJson(...openArgs(sha("b"), "--session", "s1", "--source", "desktop"));
    expect(Object.keys(first)).toEqual(["version", "review", "round", "action"]);
    expect(first.version).toBe(1);
    expect(first.action).toBe("created");
    expect(first.review).toMatchObject({ schema: "keryx.review", version: 1, id: ID, source: "desktop", state: "reviewing" });
    const reused = await stateJson(...openArgs(sha("b"), "--session", "s2"));
    expect(reused.action).toBe("reused");
    expect(reused.round.sessions.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);
    const advanced = await stateJson(...openArgs(sha("c")));
    expect(advanced).toMatchObject({ action: "advanced", round: { number: 2, previousRound: 1 } });
  });

  test("open takes --session from KERYX_REVIEW_SESSION_ID when not given", async () => {
    process.env.KERYX_REVIEW_SESSION_ID = "env-session";
    const result = await stateJson(...openArgs());
    expect(result.round.sessionId).toBe("env-session");
    const explicit = await stateJson(...openArgs(sha("b"), "--session", "flag-session"));
    expect(explicit.round.sessionId).toBe("flag-session");
  });

  test("round sets the skill's step fields", async () => {
    await stateJson(...openArgs());
    await stateJson("round", "--review", ID, "--package", ".metaproject/reviews/rv-1", "--state", "planning");
    await stateJson("round", "--review", ID, "--state", "dispatching", "--plan", "3,2,0/6");
    const wave = await stateJson("round", "--review", ID, "--plan", "3,2,4/6", "--reviewer", "review-logic=done:2", "--reviewer", "review-testing=failed", "--usage", "1200,0.75");
    expect(wave.round).toMatchObject({
      package: ".metaproject/reviews/rv-1", state: "dispatching",
      plan: { slices: 3, waves: 2, assignments: { done: 4, total: 6 } },
      reviewers: [{ role: "review-logic", state: "done", findings: 2 }, { role: "review-testing", state: "failed" }],
      usage: { tokens: 1200, costUsd: 0.75 },
    });
    await stateJson("round", "--review", ID, "--state", "reconciling", "--findings", "0,1,2,3");
    const ready = await stateJson("round", "--review", ID, "--state", "ready", "--verdict", "comment", "--findings", "0,1,2,3,1,1", "--usage", "2000");
    expect(ready.round).toMatchObject({ state: "ready", verdict: "comment", findings: { blocker: 0, major: 1, minor: 2, info: 3, carried: 1, rechecked: 1 }, usage: { tokens: 2000, costUsd: null } });
    expect(ready.review.state).toBe("ready");
    expect(Object.keys(ready)).toEqual(["version", "review", "round"]);
  });

  test("publish, mark, note, show and list", async () => {
    await stateJson(...openArgs());
    await stateJson("round", "--review", ID, "--state", "ready", "--verdict", "approve");
    const published = await stateJson("publish", "--review", ID, "--verdict", "approve", "--url", `${URL}#pullrequestreview-1`);
    expect(published.review.state).toBe("published");
    expect(published.review.publications).toHaveLength(1);
    expect((await stateJson("mark", "--review", ID, "--state", "stale")).review.state).toBe("stale");
    expect((await stateJson("mark", "--review", ID, "--state", "ready")).review.state).toBe("published");
    const note = await stateJson("note", "--review", ID, "--text", "provider rate limit");
    expect(note.version).toBe(1);
    const shown = await stateJson("show", "--pr", URL, "--viewer", "alice");
    expect(shown.review.id).toBe(ID);
    expect(shown.round.number).toBe(1);
    expect((await stateJson("show", "--review", ID)).review.id).toBe(ID);
    const listed = await stateJson("list");
    expect(listed).toEqual({ version: 1, reviews: [expect.objectContaining({ id: ID })], unreadable: [] });
    expect((await stateJson("list", "--pr", "https://github.com/org/repo/pull/99")).reviews).toEqual([]);
    const journal = readFileSync(path.join(root, ".metaproject/reviews/pr", ID, "journal.md"), "utf8").trimEnd().split("\n");
    expect(journal.map((line) => line.split(" ")[2])).toEqual(["open", "round", "publish", "mark", "mark", "note"]);
  });

  test("text output names the review and round", async () => {
    const result = await state(...openArgs());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`review ${ID}: reviewing`);
    expect(result.stdout).toContain("created: round 1 planning");
  });
});

describe("refusals exit non-zero with one error line (AC3)", () => {
  test("an invalid round transition", async () => {
    await stateJson(...openArgs());
    await stateJson("round", "--review", ID, "--state", "reconciling");
    const result = await state("round", "--review", ID, "--state", "planning");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`error: round 1 of ${ID} cannot go from reconciling to planning`);
    expect(result.stdout).toBe("");
  });

  test("a write to a ready round other than verdict, findings, usage", async () => {
    await stateJson(...openArgs());
    await stateJson("round", "--review", ID, "--state", "ready");
    const result = await state("round", "--review", ID, "--plan", "1,1,1/1");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: round 1 of .* is ready; it takes only --verdict, --findings and --usage/);
    expect((await state("round", "--review", ID, "--verdict", "request-changes")).code).toBe(0);
  });

  test("a foreign review.json exits 2 and stays byte-for-byte", async () => {
    const file = path.join(root, ".metaproject/reviews/pr", ID, "review.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ schema: "keryx.review", version: 9 });
    writeFileSync(file, text);
    const result = await state(...openArgs());
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^error: .*version 9/);
    expect((await state("show", "--review", ID)).code).toBe(2);
    expect((await state("list")).code).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("usage errors: unknown flag, bad value, missing flag, unknown verb, short SHA", async () => {
    const unknown = await state("open", "--pr", URL, "--bogus");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/^error: .*--bogus.*accepts --json --cwd --pr/);
    expect((await state("mark", "--review", ID, "--state", "published")).stderr).toBe("error: --state must be one of stale|closed|ready, got \"published\"");
    expect((await state("open", "--pr", URL, "--base", sha("a"))).stderr).toBe("error: review state open needs --head");
    expect((await state("fly")).stderr).toMatch(/^error: unknown review state verb "fly"/);
    expect((await state("open", "--pr", URL, "--base", sha("a"), "--head", "abc")).stderr).toMatch(/full 40-character SHA/);
    expect((await state("open", "--pr", "https://example.com/x", "--base", sha("a"), "--head", sha("b"))).code).toBe(1);
    expect((await state("show", "--review", "missing-1")).stderr).toMatch(/^error: no review missing-1/);
    expect((await state("round", "--review", ID)).stderr).toBe("error: review state round needs at least one field to set");
  });
});

describe("help (AC4)", () => {
  test("keryx review --help lists state, and state --help prints every verb", async () => {
    out = [];
    printReviewHelpFor([]);
    expect(out.join("")).toContain("keryx review state open|round|publish|mark|note|show|list");
    out = [];
    printReviewHelpFor(["state"]);
    expect(out.join("")).toBe(`${STATE_USAGE}\n`);
    out = [];
    await runReviewState(["--help"]);
    for (const verb of ["open", "round", "publish", "mark", "note", "show", "list"]) expect(out.join("")).toContain(`keryx review state ${verb} `);
    expect(out.join("")).toContain("KERYX_REVIEW_SESSION_ID");
  });
});

describe("value parsers", () => {
  test("plan, reviewer, usage and findings", () => {
    expect(parsePlan("3,2,1/6")).toEqual({ slices: 3, waves: 2, assignments: { done: 1, total: 6 } });
    expect(() => parsePlan("3,2,7/6")).toThrow(/more than total/);
    expect(() => parsePlan("3,2")).toThrow(/--plan must be/);
    expect(parseReviewer("review-logic=running")).toEqual({ role: "review-logic", state: "running" });
    expect(() => parseReviewer("review-logic=finished")).toThrow(/running\|done\|failed/);
    expect(parseUsage("10")).toEqual({ tokens: 10, costUsd: null });
    expect(parseUsage("10,0.5")).toEqual({ tokens: 10, costUsd: 0.5 });
    expect(() => parseUsage("-1")).toThrow(/--usage must be/);
    expect(parseFindings("1,2,3,4")).toEqual({ blocker: 1, major: 2, minor: 3, info: 4, carried: 0, rechecked: 0 });
    expect(() => parseFindings("1,2,3")).toThrow(/--findings must be/);
  });
});
