import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const ACTION = path.join(ROOT, "action.yml");
const WORKFLOW = path.join(ROOT, "docs", "examples", "review-bot.yml");

type Step = { name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; shell?: string };
type Doc = Record<string, unknown>;

function load(file: string): { text: string; doc: Doc } {
  const text = readFileSync(file, "utf8");
  return { text, doc: Bun.YAML.parse(text) as Doc };
}

const FORK_GUARD = /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/;

// The checks a workflow must pass before it is safe to hand a model key and a write token to.
export function workflowProblems(text: string): string[] {
  const doc = Bun.YAML.parse(text) as Doc;
  const problems: string[] = [];
  const triggers = Object.keys((doc.on ?? doc["true"] ?? {}) as Record<string, unknown>);
  if (/pull_request_target/.test(text)) problems.push("uses pull_request_target");
  if (!triggers.includes("pull_request")) problems.push("does not trigger on pull_request");
  const permissions = doc.permissions as Record<string, string> | undefined;
  if (JSON.stringify(permissions === undefined ? null : Object.entries(permissions).sort()) !== JSON.stringify([["contents", "read"], ["pull-requests", "write"]])) {
    problems.push("permissions are not exactly contents: read and pull-requests: write");
  }
  const jobs = Object.values((doc.jobs ?? {}) as Record<string, { if?: string; steps?: Step[] }>);
  if (jobs.length === 0) problems.push("has no job");
  for (const job of jobs) {
    if (job.if === undefined || !FORK_GUARD.test(job.if)) problems.push("a job has no fork guard on github.event.pull_request.head.repo.full_name");
  }
  return problems;
}

describe("the example workflow", () => {
  const { text, doc } = load(WORKFLOW);

  test("passes every safety check", () => {
    expect(workflowProblems(text)).toEqual([]);
  });

  test("checks out the pull request head with full history so the diff can be computed", () => {
    const steps = (Object.values(doc.jobs as Record<string, { steps: Step[] }>)[0] as { steps: Step[] }).steps;
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(String(checkout?.with?.ref)).toContain("github.event.pull_request.head.sha");
  });

  test("the model key comes only from a repository secret", () => {
    const steps = (Object.values(doc.jobs as Record<string, { steps: Step[] }>)[0] as { steps: Step[] }).steps;
    const bot = steps.find((step) => step.uses !== undefined && !step.uses.startsWith("actions/"));
    expect(String(bot?.with?.["model-api-key"])).toMatch(/^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/);
  });

  test("a fork PR is skipped, not reviewed: the guard names the same-repository comparison", () => {
    expect(text).toMatch(FORK_GUARD);
  });
});

describe("the workflow checker", () => {
  const good = readFileSync(WORKFLOW, "utf8");

  test("fails on pull_request_target", () => {
    const bad = good.replace(/^(\s*)pull_request:/m, "$1pull_request_target:");
    expect(workflowProblems(bad).join("\n")).toContain("pull_request_target");
  });

  test("fails when the fork guard is missing", () => {
    const bad = good.replace(/^\s*if: .*head\.repo\.full_name.*$/m, "");
    expect(workflowProblems(bad).join("\n")).toContain("fork guard");
  });

  test("fails when permissions are wider than needed", () => {
    const bad = good.replace("contents: read", "contents: write");
    expect(workflowProblems(bad).join("\n")).toContain("permissions");
  });
});

describe("action.yml", () => {
  const { text, doc } = load(ACTION);
  const runs = doc.runs as { using: string; steps: Step[] };
  const inputs = doc.inputs as Record<string, { required?: boolean; default?: unknown }>;

  test("is a composite action", () => {
    expect(runs.using).toBe("composite");
  });

  test("never mentions pull_request_target", () => {
    expect(text).not.toMatch(/pull_request_target/);
  });

  test("the model key is a required input with no default", () => {
    expect(inputs["model-api-key"]?.required).toBe(true);
    expect(inputs["model-api-key"]?.default).toBeUndefined();
  });

  test("the key reaches the run only through an environment variable, never inside a shell command", () => {
    for (const step of runs.steps) {
      expect(step.run ?? "").not.toMatch(/\$\{\{\s*(inputs|secrets)\./);
    }
    expect(runs.steps.some((step) => /\$\{\{\s*inputs\.model-api-key\s*\}\}/.test(step.env?.KERYX_BOT_MODEL_KEY ?? ""))).toBe(true);
  });

  test("installs keryx, then runs 'review bot run', then 'review bot post --post'", () => {
    const commands = runs.steps.map((step) => step.run ?? "").join("\n");
    const install = commands.indexOf("npm install -g");
    const run = commands.indexOf("review bot run");
    const post = commands.indexOf("review bot post");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(install);
    expect(post).toBeGreaterThan(run);
    expect(commands).toMatch(/review bot post[^\n]*--post/);
  });

  test("a fork PR is skipped inside the action too, before any step that holds the key", () => {
    const guardIndex = runs.steps.findIndex((step) => FORK_GUARD.test(step.run ?? "") || /head\.repo\.full_name/.test(step.run ?? "") || /head\.repo\.full_name/.test(JSON.stringify(step.env ?? {})));
    const keyIndex = runs.steps.findIndex((step) => step.env?.KERYX_BOT_MODEL_KEY !== undefined);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(keyIndex);
    for (const step of runs.steps.slice(guardIndex + 1)) expect(step.if ?? "").toContain("steps.guard.outputs");
  });
});
