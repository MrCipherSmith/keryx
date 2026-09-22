import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The bridge between an orchestrator's own plan and the session execution plan
 * the operator watches (rule `session-plan-bridge`).
 *
 * Every orchestrator ships a plan it owns — job steps, Flow tasks, a review
 * checklist — and none of them was visible while it ran: the operator saw
 * phases announced in prose and had to ask. The rule defines the projection;
 * these are the anchors that keep a future edit from quietly dropping it, since
 * nothing else executes a skill's prose.
 *
 * Both roots are read, because the bundled source and the installed mirror are
 * compared byte-for-byte elsewhere and a guard that looked at only one of them
 * would pass while the runtime read the other.
 */

const REPO_ROOT = process.cwd();
const ROOTS = ["src/gdskills/bundled", ".metaproject"] as const;

const rulePath = (root: string): string => path.join(REPO_ROOT, root, "rules", "core", "session-plan-bridge.mdc");
const skillPath = (root: string, skill: string): string =>
  root.startsWith("src")
    ? path.join(REPO_ROOT, root, "skills", skill, "SKILL.md")
    : path.join(REPO_ROOT, root, "skills", "gdskills", skill, "SKILL.md");

const ORCHESTRATORS = [
  "orchestration/job-orchestrator",
  "orchestration/flow-orchestrator",
  "review/review-orchestrator",
] as const;

const read = (file: string): string => readFileSync(file, "utf8");

test("the bridge rule ships in both roots, byte-identical, and covers the two statuses that would silently slip", () => {
  const bundled = read(rulePath("src/gdskills/bundled"));
  expect(read(rulePath(".metaproject"))).toBe(bundled);

  // The two translations a reader would otherwise guess wrong: job statuses are
  // hyphenated, and our vocabulary has no `failed` at all.
  expect(bundled).toContain("in-progress` (job, hyphenated)");
  expect(bundled).toContain("`failed` (job / flow task) | `blocked`");
  // `proposed` is the status the whole bridge exists for: it is what makes
  // "publish the plan, then wait for the operator" a real stopping point.
  expect(bundled).toContain("`proposed` for a plan that is awaiting the operator");
  expect(bundled).toContain("never makes the agent continue on its own");
  // Ids come from the orchestrator, never from the plan author.
  expect(bundled).toContain("Item ids are the orchestrator's own ids — never invented");
  for (const step of ["analyze", "tests-creator", "verify", "deploy"]) {
    expect(bundled).toContain(step);
  }
});

test("every orchestrator points at the rule and publishes through the plan tools", () => {
  for (const root of ROOTS) {
    for (const skill of ORCHESTRATORS) {
      const text = read(skillPath(root, skill));
      expect({ skill, rule: text.includes("session-plan-bridge") }).toEqual({ skill, rule: true });
      expect({ skill, publish: text.includes("plan_set") }).toEqual({ skill, publish: true });
      expect({ skill, update: text.includes("plan_update") }).toEqual({ skill, update: true });
    }
  }
});

test("the two approval gates are published as `proposed`, which is the point of the status", () => {
  for (const root of ROOTS) {
    const job = read(skillPath(root, "orchestration/job-orchestrator"));
    expect({ root, gate: job.includes("items are `proposed`") }).toEqual({ root, gate: true });
    const flow = read(skillPath(root, "orchestration/flow-orchestrator"));
    expect({ root, gate: flow.includes("completion choice is published as `proposed`") }).toEqual({ root, gate: true });
  }
});

test("the job bridge uses the CLI's own step ids rather than a second naming scheme", () => {
  for (const root of ROOTS) {
    const job = read(skillPath(root, "orchestration/job-orchestrator"));
    // The instruction to read them rather than retype them is the property that
    // keeps the projection reconcilable with `keryx job status`.
    expect(job).toContain("the SAME step ids `keryx job status` reports");
    expect(job).toContain("keryx job step");
  }
});

test("the review bridge uses its own numbered checklist ids, and keeps findings out of plan items", () => {
  for (const root of ROOTS) {
    const review = read(skillPath(root, "review/review-orchestrator"));
    expect(review).toContain("`step-0` … `step-14`");
    expect(review).toContain("severities stay in the report, not in a plan item");
  }
});

test("the rule is discoverable by the two orchestrators that say how to find it", () => {
  for (const root of ROOTS) {
    for (const skill of ORCHESTRATORS) {
      // A bare mention is not a pointer: the rule has to be named as a rule.
      expect(read(skillPath(root, skill))).toContain("`session-plan-bridge` rule");
    }
  }
});
